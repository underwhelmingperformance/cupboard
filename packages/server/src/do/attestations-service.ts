import { NixSha256Hash } from '@cupboard/nix/hash';
import {
	type NixSha256HashString,
	type PredicateType,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix/scalars';
import {
	type AttestationAttachResponse,
	type AttestationDecision,
	type AttestationDescriptor,
	type AttestationList,
	type AttestationNegotiateResponse,
	type AttestationPrepareResponse,
	type ParsedAttestationNegotiateRequest
} from '@cupboard/protocol/attestations';
import { bundleFromJSON, isBundleWithDsseEnvelope } from '@sigstore/bundle';
import { and, eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	AttestationBundleInvalidError,
	AttestationBundleTooLargeError,
	AttestationDigestMismatchError,
	AttestationPathNotFoundError,
	AttestationSubjectMismatchError,
	AttestationUploadCacheMismatchError,
	AttestationUploadExpiredError,
	AttestationUploadNotFoundError,
	QuotaExceededError,
	TenantWritesStoppedError
} from '../errors.ts';
import {
	attestationListObjectKey,
	attestationStagingObjectKey,
	casObjectKey,
	isNotModified,
	parseAttestationDigestName
} from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';

import {
	type AttestationCasService,
	type AttestationReference,
	type MeasuredAttestationBundle
} from './attestation-cas-service.ts';
import { type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';

const inTotoPayloadType = 'application/vnd.in-toto+json';
const inTotoStatementType = 'https://in-toto.io/Statement/v1';

const inTotoSubjectSchema = z.object({
	digest: z.object({
		sha256: sha256HexDigestSchema
	})
});

const inTotoStatementSchema = z.object({
	_type: z.literal(inTotoStatementType),
	subject: z.array(inTotoSubjectSchema).min(1),
	predicateType: predicateTypeSchema,
	predicate: z.record(z.string(), z.unknown())
});

interface ParsedAttestationBundle {
	readonly predicateType: PredicateType;
	readonly subjectDigests: readonly Sha256HexDigest[];
}

export class AttestationsService {
	constructor(
		private readonly context: ServerContext,
		private readonly attestationCas: AttestationCasService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	async negotiate(
		cache: string,
		body: ParsedAttestationNegotiateRequest
	): Promise<AttestationNegotiateResponse> {
		const bundles: AttestationDecision[] = [];

		for (const bundle of body.bundles) {
			const row = await this.narInfoObjects.committedNarInfoRow(
				cache,
				bundle.storePathHash
			);

			if (
				row !== undefined &&
				(await this.hasOwnBundleReference(
					cache,
					row.storePathHash,
					row.generation,
					bundle.digest
				)) &&
				(await this.hasAvailableBundle(bundle.digest))
			) {
				bundles.push({
					action: 'skip',
					storePathHash: bundle.storePathHash,
					digest: bundle.digest
				});
				continue;
			}

			const uploadId = crypto.randomUUID();
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const r2Key = attestationStagingObjectKey(uploadId);

			this.context.db
				.insert(schema.pendingAttestations)
				.values({
					id: uploadId,
					cache,
					storePathHash: bundle.storePathHash,
					digest: bundle.digest,
					r2Key,
					createdAt: now.toISOString(),
					expiresAt: expiresAt.toISOString()
				})
				.run();

			bundles.push({
				action: 'upload',
				storePathHash: bundle.storePathHash,
				digest: bundle.digest,
				uploadId,
				r2Key,
				expiresAt: expiresAt.toISOString()
			});
		}

		return { bundles };
	}

	async prepare(
		cache: string,
		uploadId: string
	): Promise<AttestationPrepareResponse> {
		const pending = await this.pendingUpload(cache, uploadId);
		const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

		this.context.db
			.update(schema.pendingAttestations)
			.set({ expiresAt: expiresAt.toISOString() })
			.where(eq(schema.pendingAttestations.id, uploadId))
			.run();

		return {
			uploadUrl: await this.context.r2Presigner().presignPutUrl({
				key: pending.r2Key,
				checksumSha256: hexDigestBase64(pending.digest),
				expiresSeconds: Math.max(
					1,
					Math.floor((expiresAt.getTime() - Date.now()) / 1000)
				)
			}),
			uploadHeaders: {
				'x-amz-checksum-sha256': hexDigestBase64(pending.digest)
			},
			expiresAt: expiresAt.toISOString()
		};
	}

	async attach(
		cache: string,
		uploadId: string
	): Promise<AttestationAttachResponse> {
		const pending = await this.pendingUpload(cache, uploadId);
		const initialRow = await this.narInfoObjects.committedNarInfoRow(
			cache,
			pending.storePathHash
		);

		if (initialRow === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationPathNotFoundError(pending.storePathHash);
		}

		let measured: MeasuredAttestationBundle;

		try {
			measured = await this.attestationCas.measureStagedBundle(pending.r2Key);
		} catch (error) {
			if (error instanceof AttestationBundleTooLargeError) {
				await this.clearPendingUploadAndStaging(pending);
			}

			throw error;
		}

		if (measured.digest !== pending.digest) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationDigestMismatchError(pending.digest, measured.digest);
		}

		const parsed = parseAttestationBundle(measured.bytes);

		// A rejection inside blockConcurrencyWhile would break the input gate, so
		// the outcome is carried out as a value and rethrown afterwards.
		const finalised = await this.context.ctx.blockConcurrencyWhile(() =>
			this.finaliseAttach(cache, pending, measured, parsed).then(
				(value) => ({ ok: true as const, value }),
				(error: unknown) => ({ ok: false as const, error })
			)
		);

		if (finalised.ok) {
			return finalised.value;
		}

		throw finalised.error;
	}

	private async finaliseAttach(
		cache: string,
		pending: typeof schema.pendingAttestations.$inferSelect,
		measured: MeasuredAttestationBundle,
		parsed: ParsedAttestationBundle
	): Promise<AttestationAttachResponse> {
		const row = await this.narInfoObjects.committedNarInfoRow(
			cache,
			pending.storePathHash
		);

		if (row === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationPathNotFoundError(pending.storePathHash);
		}

		const expectedSubject = narHashDigestHex(row.narHash);
		const matchingSubject = parsed.subjectDigests.find(
			(digest) => digest === expectedSubject
		);

		if (matchingSubject === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationSubjectMismatchError(
				row.narHash,
				parsed.subjectDigests[0] ?? ''
			);
		}

		if (!(await this.tenantActive())) {
			await this.clearPendingUploadAndStaging(pending);
			throw new TenantWritesStoppedError(
				this.context.requireTenant(),
				'inactive'
			);
		}

		if (
			await this.attestationCas.wouldExceedQuota(measured.digest, measured.size)
		) {
			await this.clearPendingUploadAndStaging(pending);
			throw new QuotaExceededError(this.context.requireTenant());
		}

		await this.attestationCas.promoteMeasuredBundle(pending.r2Key, measured);

		const reference: AttestationReference = {
			cache,
			storePathHash: row.storePathHash,
			generation: row.generation,
			predicateType: parsed.predicateType,
			digest: measured.digest
		};
		const outcome = await this.attestationCas.reserveReferenceAndCharge(
			reference,
			measured.size
		);

		if (outcome === 'over-quota') {
			await this.clearPendingUploadAndStaging(pending);
			throw new QuotaExceededError(this.context.requireTenant());
		}

		await this.materialiseList(cache, pending.storePathHash);
		await this.clearPendingUploadAndStaging(pending);

		return {
			storePathHash: pending.storePathHash,
			digest: measured.digest,
			predicateType: parsed.predicateType,
			status: outcome === 'already-present' ? 'already-present' : 'attached'
		};
	}

	async handleServeList(
		request: Request,
		cache: string,
		hash: string
	): Promise<Response> {
		const storePathHash = parseRequestValue(storePathHashSchema, hash);

		return this.serveTenantObject(
			request,
			attestationListObjectKey(
				this.context.requireTenant(),
				storePathHash,
				cache
			),
			'application/json; charset=utf-8'
		);
	}

	async handleServeBundle(
		request: Request,
		cache: string,
		digestParameter: string
	): Promise<Response> {
		const digest = parseRequestValue(
			sha256HexDigestSchema,
			parseAttestationDigestName(digestParameter)
		);

		if (!(await this.hasOwnBundleReferenceInCache(cache, digest))) {
			return notFound();
		}

		if (!(await this.hasAvailableBundle(digest))) {
			return notFound();
		}

		return this.serveTenantObject(
			request,
			casObjectKey(digest),
			'application/vnd.dev.sigstore.bundle+json'
		);
	}

	async materialiseList(
		cache: string,
		storePathHash: StorePathHash
	): Promise<void> {
		const row = await this.narInfoObjects.committedNarInfoRow(
			cache,
			storePathHash
		);
		const key = attestationListObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache
		);

		if (row === undefined) {
			await this.context.env.BLOBS.delete(key);
			return;
		}

		const descriptors = await this.descriptorsFor(
			cache,
			storePathHash,
			row.generation
		);

		if (descriptors.length === 0) {
			await this.context.env.BLOBS.delete(key);
			return;
		}

		const body: AttestationList = { attestations: descriptors };
		await this.context.env.BLOBS.put(key, `${JSON.stringify(body)}\n`, {
			httpMetadata: {
				contentType: 'application/json; charset=utf-8',
				cacheControl: 'no-store'
			}
		});
	}

	async removeReferencesForDigest(
		digest: Sha256HexDigest,
		fenceStoredAt: string
	): Promise<void> {
		const tenant = this.context.requireTenant();

		// The reaper routes here on a single head()===null observation. Re-check inside
		// this Durable Object, the single writer of the tenant's rows: a concurrent
		// re-promote may have restored the shared object, in which case its references
		// are valid and must not be stripped. Unlike the re-materialisable narinfo
		// demote, stripping a reference and crediting quota cannot be undone.
		if ((await this.context.env.BLOBS.head(casObjectKey(digest))) !== null) {
			return;
		}

		const references = await this.context.d1
			.select({
				cache: d1Schema.attestationReference.cache,
				storePathHash: d1Schema.attestationReference.storePathHash,
				generation: d1Schema.attestationReference.generation,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.digest, digest)
				)
			)
			.all();
		const touchedPaths = new Set<string>();

		for (const reference of references) {
			await this.attestationCas.removeCapturedReference(
				reference as AttestationReference,
				fenceStoredAt
			);
			touchedPaths.add(`${reference.cache}\0${reference.storePathHash}`);
		}

		for (const path of touchedPaths) {
			const [cache, storePathHash] = path.split('\0');

			if (cache === undefined || storePathHash === undefined) {
				continue;
			}

			await this.materialiseList(
				cache,
				storePathHashSchema.parse(storePathHash)
			);
		}
	}

	private async pendingUpload(
		cache: string,
		uploadId: string
	): Promise<typeof schema.pendingAttestations.$inferSelect> {
		const pending = this.context.db
			.select()
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new AttestationUploadNotFoundError(uploadId);
		}

		if (pending.cache !== cache) {
			throw new AttestationUploadCacheMismatchError(
				uploadId,
				pending.cache,
				cache
			);
		}

		if (pending.expiresAt < new Date().toISOString()) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationUploadExpiredError(uploadId);
		}

		return pending;
	}

	private async clearPendingUploadAndStaging(
		pending: typeof schema.pendingAttestations.$inferSelect
	): Promise<void> {
		await this.context.env.BLOBS.delete(pending.r2Key);
		this.context.db
			.delete(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.id, pending.id))
			.run();
	}

	private async hasOwnBundleReference(
		cache: string,
		storePathHash: StorePathHash,
		generation: number,
		digest: Sha256HexDigest
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const reference = await this.context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache),
					eq(d1Schema.attestationReference.storePathHash, storePathHash),
					eq(d1Schema.attestationReference.generation, generation),
					eq(d1Schema.attestationReference.digest, digest)
				)
			)
			.get();

		return reference !== undefined;
	}

	private async hasOwnBundleReferenceInCache(
		cache: string,
		digest: Sha256HexDigest
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const reference = await this.context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache),
					eq(d1Schema.attestationReference.digest, digest)
				)
			)
			.get();

		return reference !== undefined;
	}

	private async hasAvailableBundle(digest: Sha256HexDigest): Promise<boolean> {
		const row = await this.context.d1
			.select({ digest: d1Schema.casObject.digest })
			.from(d1Schema.casObject)
			.where(eq(d1Schema.casObject.digest, digest))
			.get();

		if (row === undefined) {
			return false;
		}

		return (await this.context.env.BLOBS.head(casObjectKey(digest))) !== null;
	}

	private async descriptorsFor(
		cache: string,
		storePathHash: StorePathHash,
		generation: number
	): Promise<AttestationDescriptor[]> {
		const tenant = this.context.requireTenant();
		const rows = await this.context.d1
			.select({
				digest: d1Schema.attestationReference.digest,
				predicateType: d1Schema.attestationReference.predicateType,
				size: d1Schema.casObject.size
			})
			.from(d1Schema.attestationReference)
			.innerJoin(
				d1Schema.casObject,
				eq(d1Schema.attestationReference.digest, d1Schema.casObject.digest)
			)
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache),
					eq(d1Schema.attestationReference.storePathHash, storePathHash),
					eq(d1Schema.attestationReference.generation, generation)
				)
			)
			.all();

		return rows
			.map((row) => ({
				digest: row.digest,
				predicateType: row.predicateType,
				size: row.size
			}))
			.toSorted((left, right) =>
				`${left.predicateType}:${left.digest}` >
				`${right.predicateType}:${right.digest}`
					? 1
					: -1
			);
	}

	private async tenantActive(): Promise<boolean> {
		const row = await this.context.d1
			.select({ status: d1Schema.tenant.status })
			.from(d1Schema.tenant)
			.where(eq(d1Schema.tenant.id, this.context.requireTenant()))
			.get();

		return row?.status === 'active';
	}

	private async serveTenantObject(
		request: Request,
		key: string,
		contentType: string
	): Promise<Response> {
		const object = await this.context.env.BLOBS.get(key);

		if (object === null) {
			return notFound();
		}

		const headers = new Headers({
			'cache-control': 'no-store',
			'content-type': contentType,
			etag: object.httpEtag,
			'last-modified': object.uploaded.toUTCString()
		});
		headers.set('content-length', String(object.size));

		if (isNotModified(request, headers)) {
			return new Response(undefined, {
				status: StatusCodes.NOT_MODIFIED,
				headers
			});
		}

		return new Response(request.method === 'HEAD' ? undefined : object.body, {
			headers
		});
	}
}

function parseAttestationBundle(bytes: Uint8Array): ParsedAttestationBundle {
	let json: unknown;

	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new AttestationBundleInvalidError('Attestation bundle is not JSON');
	}

	let bundle: ReturnType<typeof bundleFromJSON>;

	try {
		bundle = bundleFromJSON(json);
	} catch {
		throw new AttestationBundleInvalidError();
	}

	if (!isBundleWithDsseEnvelope(bundle)) {
		throw new AttestationBundleInvalidError(
			'Attestation bundle must carry a DSSE envelope'
		);
	}

	const envelope = bundle.content.dsseEnvelope;

	if (envelope.payloadType !== inTotoPayloadType) {
		throw new AttestationBundleInvalidError(
			'Attestation bundle DSSE payload type is not in-toto'
		);
	}

	let statementJson: unknown;

	try {
		statementJson = JSON.parse(new TextDecoder().decode(envelope.payload));
	} catch {
		throw new AttestationBundleInvalidError(
			'Attestation bundle DSSE payload is not JSON'
		);
	}

	const statement = inTotoStatementSchema.safeParse(statementJson);

	if (!statement.success) {
		throw new AttestationBundleInvalidError(
			'Attestation bundle does not contain a supported in-toto statement'
		);
	}

	return {
		predicateType: statement.data.predicateType,
		subjectDigests: statement.data.subject.map(
			(subject) => subject.digest.sha256
		)
	};
}

function narHashDigestHex(narHash: NixSha256HashString): Sha256HexDigest {
	return NixSha256Hash.parse(narHash).digestHex();
}

function hexDigestBase64(digest: Sha256HexDigest): string {
	return bytesBase64(hexBytes(digest));
}

function hexBytes(value: string): Uint8Array {
	const bytes = new Uint8Array(value.length / 2);

	for (let index = 0; index < bytes.byteLength; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}

	return bytes;
}

function bytesBase64(bytes: Uint8Array): string {
	let result = '';

	for (let index = 0; index < bytes.byteLength; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

		result += base64Alphabet[(combined >> 18) & 0x3f] ?? '';
		result += base64Alphabet[(combined >> 12) & 0x3f] ?? '';
		result +=
			second === undefined
				? '='
				: (base64Alphabet[(combined >> 6) & 0x3f] ?? '');
		result +=
			third === undefined ? '=' : (base64Alphabet[combined & 0x3f] ?? '');
	}

	return result;
}

function notFound(): Response {
	return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
}

const base64Alphabet =
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
