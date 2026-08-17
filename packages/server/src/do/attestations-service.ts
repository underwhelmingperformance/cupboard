import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type NarInfoGeneration,
	type NixSha256HashString,
	type PredicateType,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StoredCache,
	storedCacheSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	type AttestationAttachResponse,
	type AttestationDecision,
	type AttestationDescriptor,
	type AttestationList,
	type AttestationNegotiateResponse,
	type ParsedAttestationNegotiateRequest
} from '@cupboard/protocol/attestations';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	decodeDsseStatement,
	DsseDecodeError,
	inTotoStatementSchema
} from '@cupboard/shared/in-toto';
import { and, eq, inArray } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';

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
	InvalidPushIdError,
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
import {
	batchNonEmpty,
	chunk,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';

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

	private async finaliseAttach(
		cache: StoredCache,
		pending: typeof schema.pendingAttestations.$inferSelect,
		measured: MeasuredAttestationBundle,
		parsed: ParsedAttestationBundle
	): Promise<AttestationAttachResponse> {
		const tenant = this.context.requireTenant();
		const narInfoFilter = and(
			eq(schema.narInfos.cache, cache),
			eq(schema.narInfos.storePathHash, pending.storePathHash)
		);
		const narInfoRow = this.context.db
			.select()
			.from(schema.narInfos)
			.where(narInfoFilter)
			.get();

		if (narInfoRow === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationPathNotFoundError(pending.storePathHash);
		}

		// One round-trip covers every independent in-gate read the decision needs:
		// the committed-reference edge that fixes the captured generation, the
		// tenant's status, and the usage and presence counters the quota check
		// consults before a CAS object is promoted.
		const committedReferenceFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			eq(d1Schema.blobReference.cache, cache),
			eq(d1Schema.blobReference.storePathHash, narInfoRow.storePathHash),
			eq(d1Schema.blobReference.generation, narInfoRow.generation),
			eq(d1Schema.blobReference.narHash, narInfoRow.narHash)
		);
		const tenantStatusFilter = eq(d1Schema.tenant.id, tenant);
		const usageFilter = eq(d1Schema.tenantUsage.tenant, tenant);
		const presenceFilter = and(
			eq(d1Schema.tenantCasBlob.tenant, tenant),
			eq(d1Schema.tenantCasBlob.digest, measured.digest)
		);
		const [committedRows, statusRows, usageRows, ownedRows] =
			await this.context.d1.batch([
				this.context.d1
					.select({ narHash: d1Schema.blobReference.narHash })
					.from(d1Schema.blobReference)
					.where(committedReferenceFilter),
				this.context.d1
					.select({ status: d1Schema.tenant.status })
					.from(d1Schema.tenant)
					.where(tenantStatusFilter),
				this.context.d1
					.select({
						bytes: d1Schema.tenantUsage.bytes,
						casBytes: d1Schema.tenantUsage.casBytes,
						stagedBytes: d1Schema.tenantUsage.stagedBytes,
						multipartBytes: d1Schema.tenantUsage.multipartBytes,
						quotaBytes: d1Schema.tenantUsage.quotaBytes
					})
					.from(d1Schema.tenantUsage)
					.where(usageFilter),
				this.context.d1
					.select({ digest: d1Schema.tenantCasBlob.digest })
					.from(d1Schema.tenantCasBlob)
					.where(presenceFilter)
			]);

		if (committedRows.length === 0) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationPathNotFoundError(pending.storePathHash);
		}

		const expectedSubject = narHashDigestHex(narInfoRow.narHash);
		const matchingSubject = parsed.subjectDigests.find(
			(digest) => digest === expectedSubject
		);

		if (matchingSubject === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationSubjectMismatchError(
				narInfoRow.narHash,
				parsed.subjectDigests[0] ?? ''
			);
		}

		if (statusRows[0]?.status !== 'active') {
			await this.clearPendingUploadAndStaging(pending);
			throw new TenantWritesStoppedError(tenant, statusRows[0]?.status);
		}

		if (
			this.attestationCas.overQuotaForCharge(
				usageRows[0],
				ownedRows.length > 0,
				measured.size
			)
		) {
			await this.clearPendingUploadAndStaging(pending);
			throw new QuotaExceededError(tenant);
		}

		await this.attestationCas.promoteMeasuredBundle(pending.r2Key, measured);

		const reference: AttestationReference = {
			cache,
			storePathHash: narInfoRow.storePathHash,
			generation: narInfoRow.generation,
			predicateType: parsed.predicateType,
			digest: measured.digest
		};
		const outcome = await this.attestationCas.reserveReferenceAndCharge(
			reference,
			measured.size
		);

		if (outcome === 'over-quota') {
			await this.clearPendingUploadAndStaging(pending);
			throw new QuotaExceededError(tenant);
		}

		await this.materialiseList(
			cache,
			pending.storePathHash,
			narInfoRow.generation
		);
		await this.clearPendingUploadAndStaging(pending);

		return {
			storePathHash: pending.storePathHash,
			digest: measured.digest,
			predicateType: parsed.predicateType,
			status: outcome === 'already-present' ? 'already-present' : 'attached'
		};
	}

	private async pendingUpload(
		cache: StoredCache,
		uploadId: UploadId
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

		const now = isoTimestamp(new Date());

		if (pending.expiresAt < now) {
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

	private async hasOwnBundleReferenceInCache(
		cache: StoredCache,
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
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
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

	// The `(storePathHash, generation, digest)` keys of this tenant's attestation
	// edges for `digests`, read set-wise in a handful of chunked queries.
	private async filedReferenceKeys(
		cache: StoredCache,
		digests: readonly Sha256HexDigest[]
	): Promise<Set<string>> {
		if (digests.length === 0) {
			return new Set();
		}

		const tenant = this.context.requireTenant();
		const queries = chunk([...new Set(digests)], maxInClauseValues).map(
			(digestBatch) => {
				const filter = and(
					eq(d1Schema.attestationReference.tenant, tenant),
					eq(d1Schema.attestationReference.cache, cache),
					inArray(d1Schema.attestationReference.digest, digestBatch)
				);

				return this.context.d1
					.select({
						storePathHash: d1Schema.attestationReference.storePathHash,
						generation: d1Schema.attestationReference.generation,
						digest: d1Schema.attestationReference.digest
					})
					.from(d1Schema.attestationReference)
					.where(filter);
			}
		);

		const pages = await batchNonEmpty(this.context.d1, queries);

		return new Set(
			pages
				.flat()
				.map((edge) =>
					attestationReferenceKey(
						edge.storePathHash,
						edge.generation,
						edge.digest
					)
				)
		);
	}

	// The subset of `digests` whose shared CAS object is both recorded and present:
	// one chunked `cas_object` read followed by a bounded fan-out of `head` reads,
	// the set-wise form of {@link hasAvailableBundle}.
	private async availableDigests(
		digests: readonly Sha256HexDigest[]
	): Promise<Set<Sha256HexDigest>> {
		if (digests.length === 0) {
			return new Set();
		}

		const queries = chunk([...new Set(digests)], maxInClauseValues).map(
			(digestBatch) =>
				this.context.d1
					.select({ digest: d1Schema.casObject.digest })
					.from(d1Schema.casObject)
					.where(inArray(d1Schema.casObject.digest, digestBatch))
		);

		const recordedPages = await batchNonEmpty(this.context.d1, queries);
		const recorded = recordedPages.flat().map((row) => row.digest);
		const present = await mapWithConcurrency(
			recorded,
			maxOutgoingConnections,
			async (digest) =>
				(await this.context.env.BLOBS.head(casObjectKey(digest))) === null
					? undefined
					: digest
		);

		return new Set(
			present.filter(
				(digest): digest is Sha256HexDigest => digest !== undefined
			)
		);
	}

	async negotiate(
		cache: StoredCache,
		body: ParsedAttestationNegotiateRequest
	): Promise<AttestationNegotiateResponse> {
		if (!(await this.context.pushCredentials().verify(body.pushId))) {
			throw new InvalidPushIdError();
		}

		const storePathHashes = [
			...new Set(body.bundles.map((bundle) => bundle.storePathHash))
		];
		const narInfoRows = this.narInfoObjects.narInfoRowsFor(
			cache,
			storePathHashes
		);

		const committed = await this.narInfoObjects.committedReferences(
			cache,
			narInfoRows
		);
		const rowByStorePathHash = new Map<
			StorePathHash,
			(typeof narInfoRows)[number]
		>();

		for (const row of narInfoRows) {
			rowByStorePathHash.set(row.storePathHash, row);
		}

		// Only a committed row can skip, so the set-wise own-reference and
		// availability reads need cover just those bundles' digests.
		const skipCandidates = body.bundles.filter((bundle) =>
			committed.has(bundle.storePathHash)
		);
		const candidateDigests = skipCandidates.map((bundle) => bundle.digest);
		const [filedReferenceKeys, availableDigests] = await Promise.all([
			this.filedReferenceKeys(cache, candidateDigests),
			this.availableDigests(candidateDigests)
		]);

		const bundles: AttestationDecision[] = [];

		for (const bundle of body.bundles) {
			const row = committed.has(bundle.storePathHash)
				? rowByStorePathHash.get(bundle.storePathHash)
				: undefined;
			const isAlreadyHeld =
				row !== undefined &&
				filedReferenceKeys.has(
					attestationReferenceKey(
						row.storePathHash,
						row.generation,
						bundle.digest
					)
				) &&
				availableDigests.has(bundle.digest);

			if (isAlreadyHeld) {
				bundles.push({
					action: 'skip',
					storePathHash: bundle.storePathHash,
					digest: bundle.digest
				});
				continue;
			}

			const uploadId = uploadIdSchema.parse(crypto.randomUUID());
			const now = new Date();
			const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
			const r2Key = attestationStagingObjectKey(body.pushId, uploadId);

			this.context.db
				.insert(schema.pendingAttestations)
				.values({
					id: uploadId,
					cache,
					storePathHash: bundle.storePathHash,
					digest: bundle.digest,
					r2Key,
					createdAt: isoTimestamp(now),
					expiresAt: isoTimestamp(expiresAt)
				})
				.run();

			bundles.push({
				action: 'upload',
				storePathHash: bundle.storePathHash,
				digest: bundle.digest,
				uploadId,
				r2Key,
				expiresAt: isoTimestamp(expiresAt)
			});
		}

		return { bundles };
	}

	async attach(
		cache: StoredCache,
		uploadId: UploadId
	): Promise<AttestationAttachResponse> {
		const pending = await this.pendingUpload(cache, uploadId);

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
		const finalised = await this.context.criticalSection(async () => {
			try {
				const value = await this.finaliseAttach(
					cache,
					pending,
					measured,
					parsed
				);

				return { ok: true as const, value };
			} catch (error: unknown) {
				return { ok: false as const, error };
			}
		});

		if (finalised.ok) {
			return finalised.value;
		}

		throw finalised.error;
	}

	async handleServeList(
		request: Request,
		cache: StoredCache,
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
		cache: StoredCache,
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

	// Renders this path's descriptor list from its filed edges. A caller that has
	// already resolved the committed generation under the gate passes it in, sparing
	// the committed-row read; callers without one leave it undefined and it is read.
	async materialiseList(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation?: NarInfoGeneration
	): Promise<void> {
		const key = attestationListObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache
		);
		const committedRow =
			generation === undefined
				? await this.narInfoObjects.committedNarInfoRow(cache, storePathHash)
				: undefined;
		const resolvedGeneration = generation ?? committedRow?.generation;

		// The list object is path-keyed, so its mutations order behind any
		// abandoned mutation of the same key, exactly as the narinfo objects do.
		if (resolvedGeneration === undefined) {
			await this.context.objectWrites.write([key], () =>
				this.context.env.BLOBS.delete(key)
			);
			return;
		}

		const descriptors = await this.descriptorsFor(
			cache,
			storePathHash,
			resolvedGeneration
		);

		if (descriptors.length === 0) {
			await this.context.objectWrites.write([key], () =>
				this.context.env.BLOBS.delete(key)
			);
			return;
		}

		const body: AttestationList = { attestations: descriptors };
		await this.context.objectWrites.write([key], () =>
			this.context.env.BLOBS.put(key, `${JSON.stringify(body)}\n`, {
				httpMetadata: {
					contentType: 'application/json; charset=utf-8',
					cacheControl: 'no-store'
				}
			})
		);
	}

	async removeReferencesForDigest(
		digest: Sha256HexDigest,
		fenceStoredAt: IsoTimestamp
	): Promise<void> {
		// The reaper routes here on a single head()===null observation. Re-check inside
		// this Durable Object, the single writer of the tenant's rows: a concurrent
		// re-promote may have restored the shared object, in which case its references
		// are valid and must not be stripped. Unlike the re-materialisable narinfo
		// demote, stripping a reference and crediting quota cannot be undone.
		if ((await this.context.env.BLOBS.head(casObjectKey(digest))) !== null) {
			return;
		}

		const tenant = this.context.requireTenant();
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
				reference,
				fenceStoredAt
			);
			touchedPaths.add(`${reference.cache}\0${reference.storePathHash}`);
		}

		for (const path of touchedPaths) {
			const [cache, storePathHash] = path.split('\0', 2);

			if (cache === undefined || storePathHash === undefined) {
				continue;
			}

			await this.materialiseList(
				storedCacheSchema.parse(cache),
				storePathHashSchema.parse(storePathHash)
			);
		}
	}
}

const attestationStatementSchema = inTotoStatementSchema({
	sha256: sha256HexDigestSchema,
	predicateType: predicateTypeSchema
}).transform((statement) => ({
	predicateType: statement.predicateType,
	subjectDigests: statement.subject.map((subject) => subject.digest.sha256)
}));

function parseAttestationBundle(bytes: Uint8Array): ParsedAttestationBundle {
	try {
		return decodeDsseStatement(bytes, attestationStatementSchema).statement;
	} catch (error) {
		if (error instanceof DsseDecodeError) {
			throw new AttestationBundleInvalidError();
		}

		throw error;
	}
}

function narHashDigestHex(narHash: NixSha256HashString): Sha256HexDigest {
	return NixSha256Hash.parse(narHash).digestHex();
}

// Identifies an attestation edge by the three columns negotiate matches a bundle
// against: the path, its committed generation, and the bundle digest it points at.
function attestationReferenceKey(
	storePathHash: StorePathHash,
	generation: NarInfoGeneration,
	digest: Sha256HexDigest
): string {
	return `${storePathHash} ${String(generation)} ${digest}`;
}

function notFound(): Response {
	return new Response('Not found\n', { status: StatusCodes.NOT_FOUND });
}
