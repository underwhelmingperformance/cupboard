import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type CacheScope,
	isSameCacheScope,
	type NarInfoGeneration,
	narInfoGenerationSchema,
	type NixSha256HashString,
	type PredicateType,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	type AttestationAttachResponseInput,
	type AttestationDecisionInput,
	type AttestationDescriptorInput,
	type AttestationListInput,
	type AttestationNegotiateRequest,
	type AttestationNegotiateResponseInput
} from '@cupboard/protocol/attestations';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	decodeDsseStatement,
	DsseDecodeError,
	inTotoStatementSchema
} from '@cupboard/shared/in-toto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';

import {
	cacheIdentityCondition,
	cacheScopeFromRow,
	type ResolvedCache
} from '../db/cache.ts';
import {
	authorisedByCacheGeneration,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
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
	legacyAttestationListObjectKey,
	parseAttestationDigestName,
	uncachedNotFoundResponse
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
	deleteObjects,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';

interface AttestationBundle {
	readonly predicateType: PredicateType;
	readonly subjectDigests: readonly Sha256HexDigest[];
}

interface PendingAttestationUpload {
	readonly cache: ResolvedCache;
	readonly row: typeof schema.pendingAttestations.$inferSelect;
}

export class AttestationsService {
	constructor(
		private readonly context: ServerContext,
		private readonly attestationCas: AttestationCasService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	private async finaliseAttach(
		cache: ResolvedCache,
		pending: typeof schema.pendingAttestations.$inferSelect,
		measured: MeasuredAttestationBundle,
		parsed: AttestationBundle
	): Promise<AttestationAttachResponseInput> {
		const tenant = this.context.requireTenant();
		const narInfoFilter = and(
			eq(schema.narInfos.cacheId, cache.id),
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
			cacheIdentityCondition(
				d1Schema.blobReference.cacheKind,
				d1Schema.blobReference.cacheName,
				cache.scope
			),
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
			cache: cache.scope,
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
		this.context.db
			.update(schema.pendingAttestations)
			.set({ predicateType: parsed.predicateType })
			.where(eq(schema.pendingAttestations.id, pending.id))
			.run();

		return {
			storePathHash: pending.storePathHash,
			digest: measured.digest,
			predicateType: parsed.predicateType,
			status: outcome === 'already-present' ? 'already-present' : 'attached'
		};
	}

	private async pendingUpload(
		cacheScope: CacheScope,
		uploadId: UploadId
	): Promise<PendingAttestationUpload> {
		const pending = this.context.db
			.select()
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.id, uploadId))
			.get();

		if (pending === undefined) {
			throw new AttestationUploadNotFoundError(uploadId);
		}

		const cache = this.context.cacheRepository.resolvedForId(pending.cacheId);

		if (!isSameCacheScope(cache.scope, cacheScope)) {
			throw new AttestationUploadCacheMismatchError(
				uploadId,
				cache.scope,
				cacheScope
			);
		}

		const now = isoTimestamp(new Date());

		if (pending.expiresAt < now) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationUploadExpiredError(uploadId);
		}

		return { cache, row: pending };
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

	/**
	 * Whether the cache holds a live attestation reference to the bundle.
	 *
	 * An `attestation_ref` row records the narinfo generation but not the cache
	 * generation. Join it to `blob_ref` on the tenant, cache identity, path and
	 * narinfo generation, then apply the lifecycle-generation predicate. This
	 * excludes references from an earlier cache incarnation after the cache name
	 * is reused.
	 *
	 * The inner join also excludes a reference after path retirement has removed
	 * its reference edge, even if attestation cleanup has not yet removed the
	 * reference.
	 */
	private async hasOwnBundleReferenceInCache(
		cache: ResolvedCache,
		digest: Sha256HexDigest
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const reference = await this.context.d1
			.select({ digest: d1Schema.attestationReference.digest })
			.from(d1Schema.attestationReference)
			.innerJoin(
				d1Schema.blobReference,
				and(
					eq(
						d1Schema.blobReference.tenant,
						d1Schema.attestationReference.tenant
					),
					eq(
						d1Schema.blobReference.storePathHash,
						d1Schema.attestationReference.storePathHash
					),
					eq(
						d1Schema.blobReference.generation,
						d1Schema.attestationReference.generation
					)
				)
			)
			.leftJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.attestationReference.cacheKind,
						d1Schema.attestationReference.cacheName,
						cache.scope
					),
					cacheIdentityCondition(
						d1Schema.blobReference.cacheKind,
						d1Schema.blobReference.cacheName,
						cache.scope
					),
					eq(d1Schema.attestationReference.digest, digest),
					authorisedByCacheGeneration()
				)
			)
			.get();

		return reference !== undefined;
	}

	/**
	 * Returns the greatest narinfo generation among the reference edges for this
	 * tenant, cache identity and path that the current cache generation authorises,
	 * or `undefined` when it authorises none.
	 *
	 * A recommit can leave an earlier edge behind until the drain retires it.
	 * Narinfo generations increase and never repeat for a stored name and path,
	 * so the greatest authorised generation identifies the current commit.
	 * Advancing the cache generation excludes every edge from the previous cache
	 * incarnation.
	 */
	private async authorisedNarInfoGeneration(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): Promise<NarInfoGeneration | undefined> {
		const tenant = this.context.requireTenant();
		const edge = await this.context.d1
			.select({ generation: d1Schema.blobReference.generation })
			.from(d1Schema.blobReference)
			.leftJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.blobReference.cacheKind,
						d1Schema.blobReference.cacheName,
						cache.scope
					),
					eq(d1Schema.blobReference.storePathHash, storePathHash),
					authorisedByCacheGeneration()
				)
			)
			.orderBy(desc(d1Schema.blobReference.generation))
			.limit(1)
			.get();

		return edge?.generation;
	}

	private async availableBundleIncarnation(
		digest: Sha256HexDigest
	): Promise<number | undefined> {
		const row = await this.context.d1
			.select({ incarnation: d1Schema.casObject.incarnation })
			.from(d1Schema.casObject)
			.where(eq(d1Schema.casObject.digest, digest))
			.get();

		if (row === undefined) {
			return undefined;
		}

		return (await this.context.env.BLOBS.head(
			casObjectKey(digest, row.incarnation)
		)) === null
			? undefined
			: row.incarnation;
	}

	private async descriptorsFor(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): Promise<AttestationDescriptorInput[]> {
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
					cacheIdentityCondition(
						d1Schema.attestationReference.cacheKind,
						d1Schema.attestationReference.cacheName,
						cache.scope
					),
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
		contentType: string,
		cacheControl = 'no-store',
		isServable?: (object: R2Object) => boolean,
		fallbackKey?: string
	): Promise<Response> {
		const primary = await this.context.env.BLOBS.get(key);
		const object =
			primary === null && fallbackKey !== undefined
				? await this.context.env.BLOBS.get(fallbackKey)
				: primary;

		if (object === null) {
			return uncachedNotFoundResponse();
		}

		if (isServable !== undefined && !isServable(object)) {
			return uncachedNotFoundResponse();
		}

		const headers = new Headers({
			'cache-control': cacheControl,
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

	private async filedReferenceKeys(
		cache: ResolvedCache,
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
					cacheIdentityCondition(
						d1Schema.attestationReference.cacheKind,
						d1Schema.attestationReference.cacheName,
						cache.scope
					),
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

	private async availableDigests(
		digests: readonly Sha256HexDigest[]
	): Promise<Set<Sha256HexDigest>> {
		if (digests.length === 0) {
			return new Set();
		}

		const queries = chunk([...new Set(digests)], maxInClauseValues).map(
			(digestBatch) =>
				this.context.d1
					.select({
						digest: d1Schema.casObject.digest,
						incarnation: d1Schema.casObject.incarnation
					})
					.from(d1Schema.casObject)
					.where(inArray(d1Schema.casObject.digest, digestBatch))
		);

		const recordedPages = await batchNonEmpty(this.context.d1, queries);
		const recorded = recordedPages.flat();
		const present = await mapWithConcurrency(
			recorded,
			maxOutgoingConnections,
			async (object) =>
				(await this.context.env.BLOBS.head(
					casObjectKey(object.digest, object.incarnation)
				)) === null
					? undefined
					: object.digest
		);

		return new Set(
			present.filter(
				(digest): digest is Sha256HexDigest => digest !== undefined
			)
		);
	}

	async negotiate(
		cacheScope: CacheScope,
		body: AttestationNegotiateRequest
	): Promise<AttestationNegotiateResponseInput> {
		if (!(await this.context.pushCredentials().verify(body.pushId))) {
			throw new InvalidPushIdError();
		}

		if (body.bundles.length === 0) {
			return { bundles: [] };
		}

		const cache = this.context.cacheRepository.require(cacheScope);
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

		const bundles: AttestationDecisionInput[] = [];

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
					cacheId: cache.id,
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
		cacheScope: CacheScope,
		uploadId: UploadId
	): Promise<AttestationAttachResponseInput> {
		const { cache, row: pending } = await this.pendingUpload(
			cacheScope,
			uploadId
		);

		if (pending.predicateType !== null) {
			return {
				storePathHash: pending.storePathHash,
				digest: pending.digest,
				predicateType: pending.predicateType,
				status: 'already-present'
			};
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

		// Do not reject inside blockConcurrencyWhile; Cloudflare would break the
		// Durable Object's input gate. Rethrow after leaving the callback.
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
		cacheScope: CacheScope,
		hash: string
	): Promise<Response> {
		const storePathHash = parseRequestValue(storePathHashSchema, hash);
		const cache = this.context.cacheRepository.require(cacheScope);
		const committed = await this.authorisedNarInfoGeneration(
			cache,
			storePathHash
		);

		if (committed === undefined) {
			return uncachedNotFoundResponse();
		}

		return this.serveTenantObject(
			request,
			attestationListObjectKey(
				this.context.requireTenant(),
				storePathHash,
				cache.scope,
				cache.generation
			),
			'application/json; charset=utf-8',
			'no-store',
			(object) => isListOfCommittedGeneration(object, cache, committed),
			legacyAttestationListObjectKey(
				this.context.requireTenant(),
				storePathHash,
				cache.scope
			)
		);
	}

	async handleServeBundle(
		request: Request,
		cacheScope: CacheScope,
		digestParameter: string
	): Promise<Response> {
		const digest = parseRequestValue(
			sha256HexDigestSchema,
			parseAttestationDigestName(digestParameter)
		);
		const cache = this.context.cacheRepository.require(cacheScope);

		if (!(await this.hasOwnBundleReferenceInCache(cache, digest))) {
			return uncachedNotFoundResponse();
		}

		const incarnation = await this.availableBundleIncarnation(digest);

		if (incarnation === undefined) {
			return uncachedNotFoundResponse();
		}

		return this.serveTenantObject(
			request,
			casObjectKey(digest, incarnation),
			'application/vnd.dev.sigstore.bundle+json',
			'public, max-age=31536000, immutable'
		);
	}

	async materialiseList(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation?: NarInfoGeneration
	): Promise<void> {
		const key = attestationListObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope,
			cache.generation
		);
		const legacyKey = legacyAttestationListObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope
		);
		const committedRow =
			generation === undefined
				? await this.narInfoObjects.committedNarInfoRow(cache, storePathHash)
				: undefined;
		const resolvedGeneration = generation ?? committedRow?.generation;

		// The list object is path-keyed, so its mutations order behind any
		// abandoned mutation of the same key, exactly as the narinfo objects do.
		if (resolvedGeneration === undefined) {
			await this.context.objectWrites.write([key, legacyKey], () =>
				this.context.env.BLOBS.delete([key, legacyKey])
			);
			return;
		}

		const descriptors = await this.descriptorsFor(
			cache,
			storePathHash,
			resolvedGeneration
		);

		if (descriptors.length === 0) {
			await this.context.objectWrites.write([key, legacyKey], () =>
				this.context.env.BLOBS.delete([key, legacyKey])
			);
			return;
		}

		const body: AttestationListInput = { attestations: descriptors };
		const rendered = `${JSON.stringify(body)}\n`;
		const options = {
			httpMetadata: {
				contentType: 'application/json; charset=utf-8',
				cacheControl: 'no-store'
			},
			// Readers validate the published response body against a strict
			// schema. Store the narinfo generation in R2 custom metadata so the
			// response schema does not change.
			customMetadata: {
				[listGenerationMetadataKey]: String(resolvedGeneration)
			}
		};
		await this.context.objectWrites.write([key, legacyKey], () =>
			Promise.all([
				this.context.env.BLOBS.put(key, rendered, options),
				this.context.env.BLOBS.put(legacyKey, rendered, options)
			])
		);
	}

	/**
	 * Removes the list objects when the retired narinfo generation was the last
	 * committed generation for each path. One bulk call can remove all of these
	 * objects because no later generation uses them.
	 */
	async discardLists(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<void> {
		if (storePathHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const keys = [...new Set(storePathHashes)].map((storePathHash) =>
			attestationListObjectKey(
				tenant,
				storePathHash,
				cache.scope,
				cache.generation
			)
		);

		await this.context.objectWrites.write(keys, () =>
			deleteObjects(this.context.env.BLOBS, keys)
		);
	}

	/**
	 * Removes the list object of a retired narinfo generation, and preserves an
	 * object that belongs to a later generation of the same path.
	 *
	 * An object with no recorded generation was written before this server
	 * recorded one, so it describes a generation older than the recommit that
	 * kept the path. Remove it too.
	 *
	 * Call head inside the ordered mutation, after any abandoned publication for
	 * the key has settled. If head runs before that wait, it can observe the old
	 * object while an abandoned publication is about to replace it. Deleting
	 * based on that observation would remove the newly published list.
	 */
	async discardListOfGeneration(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): Promise<void> {
		const key = attestationListObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope,
			cache.generation
		);

		await this.context.objectWrites.write([key], async () => {
			const object = await this.context.env.BLOBS.head(key);

			if (object === null) {
				return;
			}

			const recorded = recordedListGeneration(object);

			if (recorded !== undefined && recorded !== generation) {
				return;
			}

			await this.context.env.BLOBS.delete(key);
		});
	}

	async removeReferencesForDigest(
		digest: Sha256HexDigest,
		fenceIncarnation: number
	): Promise<void> {
		// The reaper routes here on a single head()===null observation. Re-check inside
		// this Durable Object, the single writer of the tenant's rows: a concurrent
		// re-promote may have restored the shared object, in which case its references
		// are valid and must not be stripped. Unlike the re-materialisable narinfo
		// demote, stripping a reference and crediting quota cannot be undone.
		if (
			(await this.context.env.BLOBS.head(
				casObjectKey(digest, fenceIncarnation)
			)) !== null
		) {
			return;
		}

		const tenant = this.context.requireTenant();
		const references = await this.context.d1
			.select({
				cacheKind: d1Schema.attestationReference.cacheKind,
				cacheName: d1Schema.attestationReference.cacheName,
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
		const touchedPaths = new Map<ResolvedCache['id'], Set<StorePathHash>>();

		for (const reference of references) {
			const cache = this.context.cacheRepository.require(
				cacheScopeFromRow({
					kind: reference.cacheKind,
					name: reference.cacheName
				})
			);
			await this.attestationCas.removeCapturedReference(
				{ ...reference, cache: cache.scope },
				fenceIncarnation
			);
			const paths = touchedPaths.get(cache.id) ?? new Set<StorePathHash>();
			paths.add(reference.storePathHash);
			touchedPaths.set(cache.id, paths);
		}

		for (const [cacheId, storePathHashes] of touchedPaths) {
			const cache = this.context.cacheRepository.resolvedForId(cacheId);
			for (const storePathHash of storePathHashes) {
				await this.materialiseList(cache, storePathHash);
			}
		}
	}
}

// The R2 metadata entry naming the narinfo generation a list object describes.
export const listGenerationMetadataKey = 'narinfo-generation';

function recordedListGeneration(
	object: R2Object
): NarInfoGeneration | undefined {
	const recorded = object.customMetadata?.[listGenerationMetadataKey];

	if (recorded === undefined) {
		return undefined;
	}

	const parsed = narInfoGenerationSchema.safeParse(Number(recorded));

	return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a list object describes the narinfo generation the path currently
 * has committed.
 *
 * A path keeps one list object across all of its commits. A commit without an
 * attestation leaves the object from the previous generation in place. The
 * generation in the object metadata identifies which commit produced the list,
 * including after another cache reuses the stored name.
 *
 * Generation metadata was introduced after public-cache list objects. A
 * private cache therefore cannot accept an object without it.
 */
function isListOfCommittedGeneration(
	object: R2Object,
	cache: ResolvedCache,
	committed: NarInfoGeneration
): boolean {
	const recorded = recordedListGeneration(object);

	if (recorded === undefined) {
		return cache.access === 'public';
	}

	return recorded === committed;
}

const attestationStatementSchema = inTotoStatementSchema({
	sha256: sha256HexDigestSchema,
	predicateType: predicateTypeSchema
}).transform((statement) => ({
	predicateType: statement.predicateType,
	subjectDigests: statement.subject.map((subject) => subject.digest.sha256)
}));

function parseAttestationBundle(bytes: Uint8Array): AttestationBundle {
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

function attestationReferenceKey(
	storePathHash: StorePathHash,
	generation: NarInfoGeneration,
	digest: Sha256HexDigest
): string {
	return `${storePathHash} ${String(generation)} ${digest}`;
}
