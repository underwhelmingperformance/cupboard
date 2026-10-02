import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	type CacheScope,
	isSameCacheScope,
	type NarInfoGeneration,
	type NixSha256HashString,
	type PredicateType,
	predicateTypeSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	attestationAttachOverheadSubrequests,
	type AttestationAttachPathsResponseInput,
	attestationAttachPathSubrequests,
	type AttestationAttachResponseInput,
	type AttestationBundleDecisionInput,
	type AttestationBundleNegotiateRequest,
	type AttestationBundleNegotiateResponseInput,
	type AttestationDecisionInput,
	type AttestationDescriptorInput,
	type AttestationListInput,
	type AttestationNegotiateRequest,
	type AttestationNegotiateResponseInput
} from '@cupboard/protocol/attestations';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import {
	decodeDsseStatement,
	DsseDecodeError,
	inTotoStatementSchema
} from '@cupboard/shared/in-toto';
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	lte,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	type CacheId,
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
	AttestationInheritanceSourceChangedError,
	AttestationPathNotFoundError,
	AttestationSubjectMismatchError,
	AttestationUploadCacheMismatchError,
	AttestationUploadExpiredError,
	AttestationUploadNotFoundError,
	InvalidPushIdError,
	QuotaExceededError,
	TenantUsageMissingError,
	TenantWritesStoppedError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import {
	attestationListObjectKey,
	attestationStagingObjectKey,
	casObjectKey,
	isNotModified,
	parseAttestationDigestName,
	type R2ObjectKey,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { parseRequestValue } from '../http/parse.ts';
import {
	isListOfCommittedGeneration,
	listGenerationMetadataKey,
	recordedListGeneration
} from '../read/attestation-generation.ts';
import { authorisedNarInfoVersions } from '../read/read.ts';

import { armAlarmNoLaterThan, type MaintenanceProgress } from './alarm.ts';
import {
	type AttestationCasService,
	type AttestationReference,
	type MeasuredAttestationBundle
} from './attestation-cas-service.ts';
import {
	batchNonEmpty,
	deleteObjects,
	maxOutgoingConnections
} from './bulk.ts';
import { type CacheRegistrationService } from './cache-registration-service.ts';
import { type ServerContext } from './context.ts';
import { jsonRowList, jsonValueList, jsonValueLists } from './json-list.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	affordableSubrequestOperations,
	hasSubrequestsFor,
	requireSubrequestsFor
} from './subrequest-slice.ts';

export { listGenerationMetadataKey } from '../read/attestation-generation.ts';

interface AttestationBundle {
	readonly predicateType: PredicateType;
	readonly subjects: readonly {
		readonly name: string;
		readonly digest: Sha256HexDigest;
	}[];
}

interface ValidatedAttestationBundle {
	readonly predicateType: PredicateType;
	readonly size: number;
}
interface PreparedAttestationBundle {
	readonly cache: ResolvedCache;
	readonly validated: ValidatedAttestationBundle;
	readonly isPromoted: boolean;
}

interface PendingAttestationUpload {
	readonly cache: ResolvedCache;
	readonly row: typeof schema.pendingAttestations.$inferSelect;
}

// One D1 batch reads the inheritance sources and the destination's references.
export const inheritanceLookupSubrequests = 1;

// Writing the destination's list reads its descriptors from D1 and puts it in R2.
export const inheritanceListSubrequests = 2;

// A bundle costs one CAS head, one source revalidation and three reference calls.
export const inheritedBundleSubrequests = 5;

// One pass reads at most 65 sources per path. With 100 queued paths, the
// prefetched D1 result has at most 6,500 rows. Referencing 64 bundles uses at
// most 320 subrequests and leaves capacity to write the attestation list.
export const maxInheritedBundlesPerPass = 64;

// The most queued paths that one maintenance pass reads. The pass looks up the
// sources of each cache's paths in one D1 batch.
export const inheritanceDrainPageSize = 100;

export const inheritanceRetryDelayMs = 60 * 1000;
const inheritanceMaxRetryDelayMs = 60 * 60 * 1000;
const inheritanceContinuationDelayMs = 1;

/**
 * How an inheritance attempt ended. `budget-exhausted` means more work
 * remains for another pass. `superseded` means the path no longer has
 * the queued generation.
 */
type InheritanceResult =
	| 'complete'
	| 'over-quota'
	| 'budget-exhausted'
	| 'budget-exhausted-after-progress'
	| 'superseded';

/**
 * A queued path that the drain removed from the queue.
 */
export interface DequeuedInheritance {
	readonly cacheId: CacheId;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

/**
 * The result of one drain pass, and the paths that it removed from the queue.
 */
export interface InheritanceDrainOutcome {
	readonly progress: MaintenanceProgress;
	readonly dequeued: readonly DequeuedInheritance[];
}

export interface InheritanceSourceRow {
	readonly storePathHash: StorePathHash;
	readonly narHash: NixSha256HashString;
	readonly predicateType: PredicateType;
	readonly digest: Sha256HexDigest;
	readonly size: number | null;
	readonly incarnation: number | null;
}

export interface ExistingInheritanceRow {
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
}

/**
 * The inheritance sources that one drain pass reads once for the queued paths
 * of one cache, keyed by {@link inheritanceSourceKey}. `candidates` lists every
 * key that the pass looked up, so an absent key in `sources` means that the
 * path has no sources.
 */
export interface InheritancePrefetch {
	readonly candidates: ReadonlySet<string>;
	readonly sources: ReadonlyMap<string, readonly InheritanceSourceRow[]>;
	readonly existing: ReadonlyMap<
		StorePathHash,
		readonly ExistingInheritanceRow[]
	>;
}

export const emptyInheritancePrefetch: InheritancePrefetch = {
	candidates: new Set(),
	sources: new Map(),
	existing: new Map()
};

/**
 * One committed path that inherits attestations. The path and NAR hash come
 * from the committed narinfo row.
 */
export interface InheritanceRequest {
	readonly cache: ResolvedCache;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
	readonly prefetch?: InheritancePrefetch;
}

export function inheritanceSourceKey(
	storePathHash: StorePathHash,
	narHash: NixSha256HashString
): string {
	return JSON.stringify([storePathHash, narHash]);
}

export class AttestationsService {
	constructor(
		private readonly context: ServerContext,
		private readonly registration: CacheRegistrationService,
		private readonly attestationCas: AttestationCasService,
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	private async finaliseAttach(
		cache: ResolvedCache,
		pending: typeof schema.pendingAttestations.$inferSelect & {
			readonly storePathHash: StorePathHash;
		},
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
		const matchingSubject = parsed.subjects.find(
			(subject) => subject.digest === expectedSubject
		);

		if (matchingSubject === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new AttestationSubjectMismatchError(
				narInfoRow.narHash,
				parsed.subjects[0]?.digest ?? ''
			);
		}

		if (statusRows[0]?.status !== 'active') {
			await this.clearPendingUploadAndStaging(pending);
			throw new TenantWritesStoppedError(tenant, statusRows[0]?.status);
		}

		const usage = usageRows[0];

		// Refuse before `promoteMeasuredBundle` writes the CAS object.
		if (usage === undefined) {
			await this.clearPendingUploadAndStaging(pending);
			throw new TenantUsageMissingError(tenant);
		}

		if (
			this.attestationCas.overQuotaForCharge(
				usage,
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
		isServable?: (object: R2Object) => boolean
	): Promise<Response> {
		const object = await this.context.env.BLOBS.get(key);

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
		const queries = jsonValueLists([...new Set(digests)]).map((list) => {
			const filter = and(
				eq(d1Schema.attestationReference.tenant, tenant),
				cacheIdentityCondition(
					d1Schema.attestationReference.cacheKind,
					d1Schema.attestationReference.cacheName,
					cache.scope
				),
				inArray(d1Schema.attestationReference.digest, list)
			);

			return this.context.d1
				.select({
					storePathHash: d1Schema.attestationReference.storePathHash,
					generation: d1Schema.attestationReference.generation,
					digest: d1Schema.attestationReference.digest
				})
				.from(d1Schema.attestationReference)
				.where(filter);
		});

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

		const queries = jsonValueLists([...new Set(digests)]).map((list) =>
			this.context.d1
				.select({
					digest: d1Schema.casObject.digest,
					incarnation: d1Schema.casObject.incarnation
				})
				.from(d1Schema.casObject)
				.where(inArray(d1Schema.casObject.digest, list))
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

	private inheritanceSourceQuery(
		cache: ResolvedCache,
		candidates: SQL,
		limit: number,
		exclude?: SQL,
		destinationGeneration?: NarInfoGeneration
	) {
		const sameSourceReference = and(
			eq(d1Schema.blobReference.tenant, d1Schema.attestationReference.tenant),
			eq(
				d1Schema.blobReference.cacheKind,
				d1Schema.attestationReference.cacheKind
			),
			sql`${d1Schema.blobReference.cacheName} is ${d1Schema.attestationReference.cacheName}`,
			eq(
				d1Schema.blobReference.storePathHash,
				d1Schema.attestationReference.storePathHash
			),
			eq(
				d1Schema.blobReference.generation,
				d1Schema.attestationReference.generation
			)
		);
		const destinationIdentity = cacheIdentityCondition(
			d1Schema.attestationReference.cacheKind,
			d1Schema.attestationReference.cacheName,
			cache.scope
		);
		const tenant = this.context.requireTenant();
		const publicSource = eq(d1Schema.cacheLifecycle.access, 'public');
		const allowedSource = or(publicSource, destinationIdentity);
		const destinationReference = alias(
			d1Schema.attestationReference,
			'destination_attestation_ref'
		);
		const destinationMatch = and(
			eq(destinationReference.tenant, tenant),
			cacheIdentityCondition(
				destinationReference.cacheKind,
				destinationReference.cacheName,
				cache.scope
			),
			eq(
				destinationReference.storePathHash,
				d1Schema.attestationReference.storePathHash
			),
			destinationGeneration === undefined
				? undefined
				: eq(destinationReference.generation, destinationGeneration),
			eq(
				destinationReference.predicateType,
				d1Schema.attestationReference.predicateType
			),
			eq(destinationReference.digest, d1Schema.attestationReference.digest)
		);
		const destinationQuery = this.context.d1
			.select({ digest: destinationReference.digest })
			.from(destinationReference)
			.where(destinationMatch);
		const alreadyInherited =
			destinationGeneration === undefined
				? undefined
				: notExists(destinationQuery);

		const distinctSources = this.context.d1
			.selectDistinct({
				storePathHash: d1Schema.attestationReference.storePathHash,
				narHash: d1Schema.blobReference.narHash,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest,
				size: d1Schema.casObject.size,
				incarnation: d1Schema.casObject.incarnation
			})
			.from(d1Schema.attestationReference)
			.innerJoin(d1Schema.blobReference, sameSourceReference)
			.leftJoin(
				d1Schema.casObject,
				eq(d1Schema.casObject.digest, d1Schema.attestationReference.digest)
			)
			.leftJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
			.where(
				and(
					eq(d1Schema.attestationReference.tenant, tenant),
					candidates,
					authorisedByCacheGeneration(),
					allowedSource,
					exclude,
					alreadyInherited
				)
			)
			.as('distinct_inheritance_sources');
		const rankedSources = this.context.d1
			.select({
				storePathHash: distinctSources.storePathHash,
				narHash: distinctSources.narHash,
				predicateType: distinctSources.predicateType,
				digest: distinctSources.digest,
				size: distinctSources.size,
				incarnation: distinctSources.incarnation,
				rank: sql<number>`row_number() over (partition by ${distinctSources.storePathHash}, ${distinctSources.narHash} order by ${distinctSources.predicateType}, ${distinctSources.digest})`.as(
					'source_rank'
				)
			})
			.from(distinctSources)
			.as('ranked_inheritance_sources');

		return this.context.d1
			.select({
				storePathHash: rankedSources.storePathHash,
				narHash: rankedSources.narHash,
				predicateType: rankedSources.predicateType,
				digest: rankedSources.digest,
				size: rankedSources.size,
				incarnation: rankedSources.incarnation
			})
			.from(rankedSources)
			.where(lte(rankedSources.rank, limit))
			.orderBy(
				rankedSources.storePathHash,
				rankedSources.narHash,
				rankedSources.predicateType,
				rankedSources.digest
			);
	}

	private async drainCacheInheritances(
		logger: Logger,
		cache: ResolvedCache,
		rows: readonly (typeof schema.attestationInheritances.$inferSelect)[],
		dequeued: DequeuedInheritance[]
	): Promise<{
		readonly hasProgressed: boolean;
		readonly isBudgetExhausted: boolean;
	}> {
		const stale = rows.filter(
			(row) => !this.isQueuedGenerationCurrent(cache, row)
		);
		const live = rows.filter((row) =>
			this.isQueuedGenerationCurrent(cache, row)
		);

		for (const row of stale) {
			this.dequeueInheritance(row, dequeued);
		}

		let hasProgressed = stale.length > 0;
		let prefetch = emptyInheritancePrefetch;

		try {
			prefetch = await this.prefetchInheritanceSources(cache, live);
		} catch (error) {
			// Each path then looks up its own sources.
			logger.warn('attestation inheritance prefetch failed', {
				cache: cache.scope,
				errorMessage: error instanceof Error ? error.message : String(error)
			});
		}

		for (const row of live) {
			const attempt = this.startInheritanceAttempt(row);

			try {
				const result = await this.inheritFromTenant(logger, {
					cache,
					storePathHash: row.storePathHash,
					generation: row.generation,
					narHash: row.narHash,
					prefetch
				});

				if (
					result === 'budget-exhausted' ||
					result === 'budget-exhausted-after-progress'
				) {
					// Running out of subrequests is not a failed attempt.
					this.restoreInheritanceRow(row);

					return {
						hasProgressed:
							hasProgressed || result === 'budget-exhausted-after-progress',
						isBudgetExhausted: true
					};
				}

				if (result !== 'complete') {
					logger.warn('attestation inheritance incomplete', {
						cache: cache.scope,
						storePathHash: row.storePathHash,
						reason: result
					});
				}

				this.dequeueInheritance(row, dequeued);
			} catch (error) {
				await this.recordInheritanceFailure(logger, cache, row, attempt, error);
			}

			hasProgressed = true;
		}

		return { hasProgressed, isBudgetExhausted: false };
	}

	// A newer generation of the path owns the list once it commits.
	private async writeInheritedList(request: InheritanceRequest): Promise<void> {
		const { cache, storePathHash, generation } = request;

		await this.context.criticalSection(async () => {
			if (this.isQueuedGenerationCurrent(cache, request)) {
				await this.materialiseList(cache, storePathHash, generation);
			}
		});
	}

	private isQueuedGenerationCurrent(
		cache: ResolvedCache,
		queued: {
			readonly storePathHash: StorePathHash;
			readonly generation: NarInfoGeneration;
			readonly narHash: NixSha256HashString;
		}
	): boolean {
		const [narInfo] = this.narInfoObjects.narInfoRowsFor(cache, [
			queued.storePathHash
		]);

		return (
			narInfo?.generation === queued.generation &&
			narInfo.narHash === queued.narHash
		);
	}

	// Record the attempt before work, so a runtime interruption also delays the
	// next retry.
	private startInheritanceAttempt(
		row: typeof schema.attestationInheritances.$inferSelect
	): number {
		const attempt = row.attempts + 1;
		const delay = Math.min(
			inheritanceRetryDelayMs * 2 ** Math.min(row.attempts, 6),
			inheritanceMaxRetryDelayMs
		);
		const retryAt = new Date(Date.now() + delay);

		this.updateInheritanceRow(row, {
			attempts: attempt,
			notBefore: isoTimestamp(retryAt)
		});

		return attempt;
	}

	private restoreInheritanceRow(
		row: typeof schema.attestationInheritances.$inferSelect
	): void {
		const retryAt = new Date(Date.now() + inheritanceContinuationDelayMs);
		this.updateInheritanceRow(row, {
			attempts: row.attempts,
			notBefore: isoTimestamp(retryAt)
		});
	}

	private updateInheritanceRow(
		row: typeof schema.attestationInheritances.$inferSelect,
		values: { readonly attempts: number; readonly notBefore: IsoTimestamp }
	): void {
		const table = schema.attestationInheritances;

		this.context.db
			.update(table)
			.set(values)
			.where(
				and(
					eq(table.cacheId, row.cacheId),
					eq(table.storePathHash, row.storePathHash),
					eq(table.generation, row.generation)
				)
			)
			.run();
	}

	private dequeueInheritance(
		row: typeof schema.attestationInheritances.$inferSelect,
		dequeued: DequeuedInheritance[]
	): void {
		const table = schema.attestationInheritances;

		this.context.db
			.delete(table)
			.where(
				and(
					eq(table.cacheId, row.cacheId),
					eq(table.storePathHash, row.storePathHash),
					eq(table.generation, row.generation)
				)
			)
			.run();
		dequeued.push({
			cacheId: row.cacheId,
			storePathHash: row.storePathHash,
			generation: row.generation,
			narHash: row.narHash
		});
	}

	private async recordInheritanceFailure(
		logger: Logger,
		cache: ResolvedCache,
		row: typeof schema.attestationInheritances.$inferSelect,
		attempt: number,
		error: unknown
	): Promise<void> {
		const details = {
			cache: cache.scope,
			storePathHash: row.storePathHash,
			attempts: attempt,
			errorName: error instanceof Error ? error.name : 'UnknownError',
			errorMessage: error instanceof Error ? error.message : String(error)
		};

		logger.warn('attestation inheritance failed', details);
		const delay = Math.min(
			inheritanceRetryDelayMs * 2 ** Math.min(row.attempts, 6),
			inheritanceMaxRetryDelayMs
		);
		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now() + delay);
	}

	private async checkBundleCharge(
		digest: Sha256HexDigest,
		size: number
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const presenceFilter = and(
			eq(d1Schema.tenantCasBlob.tenant, tenant),
			eq(d1Schema.tenantCasBlob.digest, digest)
		);
		const [statuses, usages, owned] = await this.context.d1.batch([
			this.context.d1
				.select({ status: d1Schema.tenant.status })
				.from(d1Schema.tenant)
				.where(eq(d1Schema.tenant.id, tenant)),
			this.context.d1
				.select({
					bytes: d1Schema.tenantUsage.bytes,
					casBytes: d1Schema.tenantUsage.casBytes,
					quotaBytes: d1Schema.tenantUsage.quotaBytes
				})
				.from(d1Schema.tenantUsage)
				.where(eq(d1Schema.tenantUsage.tenant, tenant)),
			this.context.d1
				.select({ digest: d1Schema.tenantCasBlob.digest })
				.from(d1Schema.tenantCasBlob)
				.where(presenceFilter)
		]);
		if (statuses[0]?.status !== 'active') {
			throw new TenantWritesStoppedError(tenant, statuses[0]?.status);
		}
		const usage = usages[0];
		if (usage === undefined) {
			throw new TenantUsageMissingError(tenant);
		}
		if (this.attestationCas.overQuotaForCharge(usage, owned.length > 0, size)) {
			throw new QuotaExceededError(tenant);
		}
	}

	private async groupedUploadLocked(
		cacheScope: CacheScope,
		uploadId: UploadId,
		expected?: PendingAttestationUpload
	): Promise<PendingAttestationUpload> {
		const upload = await this.pendingUpload(cacheScope, uploadId);
		const cache = this.context.cacheRepository.require(cacheScope);
		if (
			cache.id !== upload.cache.id ||
			upload.row.storePathHash !== null ||
			(expected !== undefined &&
				(cache.id !== expected.cache.id ||
					cache.generation !== expected.cache.generation ||
					upload.row.digest !== expected.row.digest ||
					upload.row.r2Key !== expected.row.r2Key ||
					upload.row.createdAt !== expected.row.createdAt))
		) {
			throw new AttestationUploadNotFoundError(uploadId);
		}
		return { cache, row: upload.row };
	}

	private async eligibleBundlePaths(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<readonly (typeof schema.narInfos.$inferSelect)[]> {
		const rows = this.narInfoObjects.narInfoRowsFor(cache, [
			...new Set(storePathHashes)
		]);
		const versions = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			cache.scope,
			storePathHashes
		);
		return rows.filter((row) => {
			const version = versions.get(row.storePathHash);
			return (
				version?.generation === row.generation &&
				version.narHash === row.narHash &&
				version.cacheGeneration === cache.generation
			);
		});
	}

	private async reusableBundleLocked(
		upload: PendingAttestationUpload,
		storePathHashes: readonly StorePathHash[]
	): Promise<PreparedAttestationBundle | undefined> {
		const { cache, row: pending } = upload;
		const uploadId = pending.id;
		const known =
			pending.validatedBundleJson === null
				? undefined
				: validatedAttestationBundleSchema.parse(
						JSON.parse(pending.validatedBundleJson)
					);
		if (known === undefined) {
			return undefined;
		}
		const eligible = await this.eligibleBundlePaths(cache, storePathHashes);
		for (const row of eligible) {
			this.requirePendingSubject(uploadId, row);
		}
		if (eligible.length > 0) {
			await this.checkBundleCharge(pending.digest, known.size);
		}
		const incarnation = await this.availableBundleIncarnation(pending.digest);
		if (
			incarnation !== undefined &&
			(await this.attestationCas.reuseBundleIncarnation(
				pending.digest,
				incarnation
			))
		) {
			return { cache, validated: known, isPromoted: true };
		}
		return undefined;
	}

	private async prepareMeasuredBundleLocked(
		upload: PendingAttestationUpload,
		storePathHashes: readonly StorePathHash[],
		measured: MeasuredAttestationBundle,
		parsed: AttestationBundle
	): Promise<PreparedAttestationBundle> {
		const { cache, row: pending } = upload;
		const eligible = await this.eligibleBundlePaths(cache, storePathHashes);
		const uploadId = pending.id;
		const subjects = new Set(parsed.subjects.map((subject) => subject.digest));
		for (const row of eligible) {
			if (!subjects.has(narHashDigestHex(row.narHash))) {
				throw new AttestationSubjectMismatchError(
					row.narHash,
					parsed.subjects[0]?.digest ?? '',
					StorePath.basename(row.storePath)
				);
			}
		}
		const validated = {
			predicateType: parsed.predicateType,
			size: measured.size
		};
		if (eligible.length === 0) {
			return { cache, validated, isPromoted: false };
		}
		await this.checkBundleCharge(pending.digest, measured.size);
		await this.attestationCas.promoteMeasuredBundle(pending.r2Key, measured, {
			restoreMissingObject: true
		});
		const subjectRows = jsonRowList(parsed.subjects);
		this.context.db.transaction((transaction) => {
			transaction
				.delete(schema.pendingAttestationSubjects)
				.where(eq(schema.pendingAttestationSubjects.uploadId, uploadId))
				.run();
			transaction
				.insert(schema.pendingAttestationSubjects)
				.select(
					subjectRows.insertSource([
						sql`${uploadId}`,
						subjectRows.column('name'),
						subjectRows.column('digest')
					])
				)
				.onConflictDoNothing()
				.run();
			transaction
				.update(schema.pendingAttestations)
				.set({ validatedBundleJson: JSON.stringify(validated) })
				.where(eq(schema.pendingAttestations.id, uploadId))
				.run();
		});
		return { cache, validated, isPromoted: true };
	}

	private async prepareBundle(
		cacheScope: CacheScope,
		uploadId: UploadId,
		storePathHashes: readonly StorePathHash[]
	): Promise<PreparedAttestationBundle> {
		const preparation = await this.context.criticalSection(async () => {
			const upload = await this.groupedUploadLocked(cacheScope, uploadId);
			const bundle = await this.reusableBundleLocked(upload, storePathHashes);
			return { upload, bundle };
		});
		if (preparation.bundle !== undefined) {
			return preparation.bundle;
		}
		let measured: MeasuredAttestationBundle;
		try {
			measured = await this.attestationCas.measureStagedBundle(
				preparation.upload.row.r2Key
			);
		} catch (error) {
			if (!(error instanceof UploadedObjectNotFoundError)) {
				throw error;
			}
			return this.context.criticalSection(async () => {
				const upload = await this.groupedUploadLocked(
					cacheScope,
					uploadId,
					preparation.upload
				);
				await this.clearPendingUploadAndStaging(upload.row);
				throw new AttestationUploadNotFoundError(uploadId);
			});
		}
		if (measured.digest !== preparation.upload.row.digest) {
			return this.context.criticalSection(async () => {
				const upload = await this.groupedUploadLocked(
					cacheScope,
					uploadId,
					preparation.upload
				);
				await this.clearPendingUploadAndStaging(upload.row);
				throw new AttestationDigestMismatchError(
					upload.row.digest,
					measured.digest
				);
			});
		}
		const parsed = parseAttestationBundle(measured.bytes);
		return this.context.criticalSection(async () => {
			const upload = await this.groupedUploadLocked(
				cacheScope,
				uploadId,
				preparation.upload
			);
			return this.prepareMeasuredBundleLocked(
				upload,
				storePathHashes,
				measured,
				parsed
			);
		});
	}

	private requirePendingSubject(
		uploadId: UploadId,
		row: typeof schema.narInfos.$inferSelect
	): void {
		const subjectName = StorePath.basename(row.storePath);
		const narDigest = narHashDigestHex(row.narHash);
		const filter = and(
			eq(schema.pendingAttestationSubjects.uploadId, uploadId),
			eq(schema.pendingAttestationSubjects.narDigest, narDigest)
		);
		const subject = this.context.db
			.select({ digest: schema.pendingAttestationSubjects.narDigest })
			.from(schema.pendingAttestationSubjects)
			.where(filter)
			.get();
		if (subject === undefined) {
			throw new AttestationSubjectMismatchError(row.narHash, '', subjectName);
		}
	}

	private async attachBundlePathLocked(
		uploadId: UploadId,
		bundle: PreparedAttestationBundle,
		storePathHash: StorePathHash
	): Promise<AttestationAttachPathsResponseInput['paths'][number]> {
		const pending = await this.pendingUpload(bundle.cache.scope, uploadId);
		const cache = this.context.cacheRepository.require(bundle.cache.scope);
		if (cache.id !== bundle.cache.id || pending.cache.id !== cache.id) {
			throw new AttestationUploadNotFoundError(uploadId);
		}
		const expiresAt = isoTimestamp(new Date(Date.now() + 15 * 60 * 1000));
		this.context.db
			.update(schema.pendingAttestations)
			.set({ expiresAt })
			.where(eq(schema.pendingAttestations.id, uploadId))
			.run();
		const result = {
			storePathHash,
			digest: pending.row.digest,
			predicateType: bundle.validated.predicateType
		};
		const row = this.narInfoObjects.narInfoRowsFor(cache, [storePathHash])[0];
		const versions = await authorisedNarInfoVersions(
			this.context.d1,
			this.context.requireTenant(),
			cache.scope,
			[storePathHash]
		);
		const version = versions.get(storePathHash);
		if (
			row === undefined ||
			!bundle.isPromoted ||
			cache.generation !== bundle.cache.generation ||
			version?.generation !== row.generation ||
			version.narHash !== row.narHash ||
			version.cacheGeneration !== cache.generation
		) {
			return { ...result, status: 'unservable' };
		}
		this.requirePendingSubject(uploadId, row);
		const outcome = await this.attestationCas.reserveReferenceAndCharge(
			{
				cache: cache.scope,
				storePathHash,
				generation: row.generation,
				predicateType: bundle.validated.predicateType,
				digest: result.digest
			},
			bundle.validated.size
		);
		if (outcome === 'over-quota') {
			throw new QuotaExceededError(this.context.requireTenant());
		}
		await this.materialiseList(cache, storePathHash, row.generation);
		return {
			...result,
			status: outcome === 'already-present' ? 'already-present' : 'attached'
		};
	}

	// The cache's generation is part of the key, so a cache created after a
	// deletion of the same name never writes over what its predecessor left.
	listKey(cache: ResolvedCache, storePathHash: StorePathHash): R2ObjectKey {
		return attestationListObjectKey(
			this.context.requireTenant(),
			storePathHash,
			cache.scope,
			cache.generation
		);
	}

	/**
	 * Queues a committed path for attestation inheritance and arms the alarm
	 * that drains the queue. The commit does not wait for inheritance.
	 */
	async queueInheritance(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString
	): Promise<void> {
		this.context.db
			.insert(schema.attestationInheritances)
			.values({
				cacheId: cache.id,
				storePathHash,
				generation,
				narHash,
				notBefore: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();
		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
	}

	/**
	 * When the queue next has a path that the drain may attempt, or `undefined`
	 * when the queue is empty. The maintenance scheduler arms the alarm for this
	 * time, so a scheduled retry is not lost when an earlier alarm runs first.
	 */
	nextInheritanceAt(): number | undefined {
		const table = schema.attestationInheritances;
		const row = this.context.db
			.select({ notBefore: table.notBefore })
			.from(table)
			.orderBy(table.notBefore)
			.limit(1)
			.get();

		return row === undefined ? undefined : Date.parse(row.notBefore);
	}

	/**
	 * Inherits attestations for one page of queued paths. A path leaves the
	 * queue when inheritance ends, when its narinfo row no longer has the queued
	 * generation. A path whose
	 * inheritance runs out of subrequests stays queued for the next pass.
	 */
	async drainInheritanceQueue(
		logger: Logger
	): Promise<InheritanceDrainOutcome> {
		const table = schema.attestationInheritances;
		const now = isoTimestamp(new Date());
		const queued = this.context.db
			.select()
			.from(table)
			.where(lte(table.notBefore, now))
			.orderBy(
				table.notBefore,
				table.cacheId,
				table.storePathHash,
				table.generation
			)
			.limit(inheritanceDrainPageSize)
			.all();
		const byCache = Map.groupBy(queued, (row) => row.cacheId);
		const dequeued: DequeuedInheritance[] = [];
		let hasProgressed = false;

		for (const [cacheId, rows] of byCache) {
			const outcome = await this.drainCacheInheritances(
				logger,
				this.context.cacheRepository.resolvedForId(cacheId),
				rows,
				dequeued
			);

			hasProgressed ||= outcome.hasProgressed;

			if (outcome.isBudgetExhausted) {
				break;
			}
		}

		return { progress: hasProgressed ? 'progressed' : 'stalled', dequeued };
	}

	async prefetchInheritanceSources(
		cache: ResolvedCache,
		candidates: readonly {
			readonly storePathHash: StorePathHash;
			readonly narHash: NixSha256HashString;
		}[]
	): Promise<InheritancePrefetch> {
		const unique = new Map(
			candidates.map((candidate) => [
				inheritanceSourceKey(candidate.storePathHash, candidate.narHash),
				candidate
			])
		);

		if (unique.size === 0 || !hasSubrequestsFor(inheritanceLookupSubrequests)) {
			return emptyInheritancePrefetch;
		}

		const uniqueCandidates = unique.values().toArray();
		const pathHashes = [
			...new Set(uniqueCandidates.map((row) => row.storePathHash))
		];
		// Keep the indexed path filter separate from the exact-pair check. D1's
		// row-value IN predicate returns no rows across both reference tables.
		const candidatePairs = jsonRowList(uniqueCandidates);
		const candidateFilter =
			and(
				inArray(
					d1Schema.attestationReference.storePathHash,
					jsonValueList(pathHashes)
				),
				candidatePairs.anyRow(
					sql`${d1Schema.attestationReference.storePathHash} = ${candidatePairs.column('storePathHash')} and ${d1Schema.blobReference.narHash} = ${candidatePairs.column('narHash')}`
				)
			) ?? sql`false`;
		const destinationVersions = this.narInfoObjects
			.narInfoRowsFor(cache, pathHashes)
			.map((row) => ({
				storePathHash: row.storePathHash,
				generation: row.generation
			}));
		const requestedVersions = jsonRowList(destinationVersions).matches({
			storePathHash: d1Schema.attestationReference.storePathHash,
			generation: d1Schema.attestationReference.generation
		});
		const existingFilter = and(
			eq(d1Schema.attestationReference.tenant, this.context.requireTenant()),
			cacheIdentityCondition(
				d1Schema.attestationReference.cacheKind,
				d1Schema.attestationReference.cacheName,
				cache.scope
			),
			requestedVersions
		);
		const [rows, existingRows] = await this.context.d1.batch([
			// Exclude the destination's own references for the queued generation, as
			// the per-path lookup does.
			this.inheritanceSourceQuery(
				cache,
				candidateFilter,
				maxInheritedBundlesPerPass + 1,
				sql`not (${existingFilter})`
			),
			this.context.d1
				.select({
					storePathHash: d1Schema.attestationReference.storePathHash,
					generation: d1Schema.attestationReference.generation
				})
				.from(d1Schema.attestationReference)
				.where(existingFilter)
				.groupBy(
					d1Schema.attestationReference.storePathHash,
					d1Schema.attestationReference.generation
				)
		]);
		const sources = Map.groupBy(rows, (row) =>
			inheritanceSourceKey(row.storePathHash, row.narHash)
		);
		const existing = Map.groupBy(existingRows, (row) => row.storePathHash);

		return { candidates: new Set(unique.keys()), sources, existing };
	}

	async inheritFromTenant(
		logger: Logger,
		request: InheritanceRequest
	): Promise<InheritanceResult> {
		const { cache, storePathHash, generation, narHash } = request;
		const queue = schema.attestationInheritances;
		const queueFilter = and(
			eq(queue.cacheId, cache.id),
			eq(queue.storePathHash, storePathHash),
			eq(queue.generation, generation),
			eq(queue.narHash, narHash)
		);
		const cursorRow = this.context.db
			.select({
				predicateType: queue.sourcePredicateType,
				digest: queue.sourceDigest
			})
			.from(queue)
			.where(queueFilter)
			.get();
		const cursorPredicateType = cursorRow?.predicateType ?? undefined;
		const cursorDigest = cursorRow?.digest ?? undefined;
		const cursor =
			cursorPredicateType === undefined || cursorDigest === undefined
				? undefined
				: { predicateType: cursorPredicateType, digest: cursorDigest };
		const advanceCursor = (source: InheritanceSourceRow) => {
			this.context.db
				.update(queue)
				.set({
					sourcePredicateType: source.predicateType,
					sourceDigest: source.digest
				})
				.where(queueFilter)
				.run();
		};
		// Use the prefetched sources only for this path and NAR. For a path that
		// the pass did not look up, read the sources here.
		const key = inheritanceSourceKey(storePathHash, narHash);
		const prefetch =
			cursor === undefined && request.prefetch?.candidates.has(key) === true
				? request.prefetch
				: undefined;
		const prefetchedSources =
			prefetch === undefined ? undefined : (prefetch.sources.get(key) ?? []);

		const prefetchedExisting = prefetch?.existing
			.get(storePathHash)
			?.filter((row) => row.generation === generation);

		if (
			prefetchedSources?.length === 0 &&
			(prefetchedExisting ?? []).length === 0
		) {
			return 'complete';
		}

		const listSubrequests = inheritanceListSubrequests;
		const requiresLookup =
			prefetchedSources === undefined ||
			prefetchedSources.length > maxInheritedBundlesPerPass ||
			(prefetchedExisting ?? []).length > 0;
		const lookup = requiresLookup ? inheritanceLookupSubrequests : 0;

		if (!hasSubrequestsFor(lookup + listSubrequests)) {
			return 'budget-exhausted';
		}

		const tenant = this.context.requireTenant();
		const maxRows = Math.min(
			maxInheritedBundlesPerPass,
			affordableSubrequestOperations(
				inheritedBundleSubrequests,
				lookup + listSubrequests
			)
		);
		const destinationIdentity = cacheIdentityCondition(
			d1Schema.attestationReference.cacheKind,
			d1Schema.attestationReference.cacheName,
			cache.scope
		);
		const otherSource = sql`not (${destinationIdentity} and ${eq(d1Schema.attestationReference.generation, generation)})`;
		const existingFilter = and(
			eq(d1Schema.attestationReference.tenant, tenant),
			destinationIdentity,
			eq(d1Schema.attestationReference.storePathHash, storePathHash),
			eq(d1Schema.attestationReference.generation, generation)
		);
		const existingQuery = this.context.d1
			.select({ storePathHash: d1Schema.attestationReference.storePathHash })
			.from(d1Schema.attestationReference)
			.where(existingFilter)
			.limit(1);
		let sourceRows: readonly InheritanceSourceRow[];
		let hasExisting: boolean;

		if (requiresLookup) {
			const afterCursor =
				cursor === undefined
					? undefined
					: or(
							gt(
								d1Schema.attestationReference.predicateType,
								cursor.predicateType
							),
							and(
								eq(
									d1Schema.attestationReference.predicateType,
									cursor.predicateType
								),
								gt(d1Schema.attestationReference.digest, cursor.digest)
							)
						);
			const sourceFilter =
				and(
					eq(d1Schema.attestationReference.storePathHash, storePathHash),
					eq(d1Schema.blobReference.narHash, narHash),
					otherSource,
					afterCursor
				) ?? sql`false`;
			const result = await this.context.d1.batch([
				this.inheritanceSourceQuery(
					cache,
					sourceFilter,
					maxInheritedBundlesPerPass + 1,
					undefined,
					generation
				),
				existingQuery
			]);
			sourceRows = result[0];
			hasExisting = result[1].length > 0;
		} else {
			sourceRows = prefetchedSources;
			hasExisting = false;
		}
		// An earlier attempt can create references and stop before it writes the
		// list, for example when the runtime resets the Durable Object or the list
		// write fails. The sources of those references can be gone by the retry.
		// Write the list whenever the destination already has a reference for
		// this generation.
		let shouldWriteList = hasExisting;
		let hasProgressed = false;
		const missingRows = sourceRows.slice(0, maxInheritedBundlesPerPass);
		let result: InheritanceResult = 'complete';

		if (
			missingRows.length > maxRows ||
			sourceRows.length > maxInheritedBundlesPerPass
		) {
			result = 'budget-exhausted';
		}

		try {
			for (const row of missingRows.slice(0, maxRows)) {
				if (!hasSubrequestsFor(inheritedBundleSubrequests + listSubrequests)) {
					result = 'budget-exhausted';
					break;
				}

				const object =
					row.incarnation === null
						? undefined
						: await this.context.env.BLOBS.head(
								casObjectKey(row.digest, row.incarnation)
							);

				// Source access and reference generations can change during prefetch
				// or the CAS head. Revalidate them inside the destination write gate.
				const outcome = await this.context.criticalSection(async () => {
					if (!this.isQueuedGenerationCurrent(cache, request)) {
						return 'superseded';
					}

					const sourceFilter =
						and(
							eq(d1Schema.attestationReference.storePathHash, storePathHash),
							eq(d1Schema.blobReference.narHash, narHash),
							eq(
								d1Schema.attestationReference.predicateType,
								row.predicateType
							),
							eq(d1Schema.attestationReference.digest, row.digest),
							otherSource
						) ?? sql`false`;
					const availableSource = this.inheritanceSourceQuery(
						cache,
						sourceFilter,
						1
					).as('available_inheritance_source');
					const [source] = await this.context.d1
						.select({
							predicateType: availableSource.predicateType,
							digest: availableSource.digest,
							size: availableSource.size,
							incarnation: availableSource.incarnation,
							registryIncarnation: d1Schema.objectIncarnation.incarnation,
							registryState: d1Schema.objectIncarnation.state
						})
						.from(availableSource)
						.leftJoin(
							d1Schema.objectIncarnation,
							and(
								eq(d1Schema.objectIncarnation.kind, 'cas'),
								eq(d1Schema.objectIncarnation.objectId, availableSource.digest)
							)
						)
						.all();

					if (source === undefined || source.registryState === 'absent') {
						return 'unavailable' as const;
					}
					if (
						source.incarnation !== row.incarnation ||
						(source.registryIncarnation !== null &&
							source.registryIncarnation !== row.incarnation) ||
						source.registryState === 'pending'
					) {
						throw new AttestationInheritanceSourceChangedError(row.digest);
					}
					if (object == undefined || source.size === null) {
						logger.warn('attestation inheritance source missing', {
							cache: cache.scope,
							storePathHash,
							digest: row.digest
						});
						return 'unavailable' as const;
					}

					return this.attestationCas.reserveReferenceAndCharge(
						{
							cache: cache.scope,
							storePathHash,
							generation,
							predicateType: source.predicateType,
							digest: source.digest
						},
						source.size
					);
				});

				if (outcome === 'superseded' || outcome === 'over-quota') {
					result = outcome;
					break;
				}

				shouldWriteList ||= outcome !== 'unavailable';
				advanceCursor(row);
				hasProgressed = true;
			}
		} catch (error) {
			// Write the list for the references that this attempt created, but
			// report the error that stopped the attempt.
			if (shouldWriteList) {
				try {
					await this.writeInheritedList(request);
				} catch (listError) {
					logger.warn('attestation inheritance list write failed', {
						cache: cache.scope,
						storePathHash,
						errorMessage:
							listError instanceof Error ? listError.message : String(listError)
					});
				}
			}

			throw error;
		}

		if (shouldWriteList && result !== 'budget-exhausted') {
			await this.writeInheritedList(request);
		}

		return result === 'budget-exhausted' && hasProgressed
			? 'budget-exhausted-after-progress'
			: result;
	}

	async negotiateBundles(
		cacheScope: CacheScope,
		body: AttestationBundleNegotiateRequest
	): Promise<AttestationBundleNegotiateResponseInput> {
		if (!(await this.context.pushCredentials().verify(body.pushId))) {
			throw new InvalidPushIdError();
		}
		if (body.bundles.length === 0) {
			return { bundles: [] };
		}
		const cache = await this.registration.forWrite(cacheScope);
		const bundles: AttestationBundleDecisionInput[] = [];
		const digests = new Set(body.bundles.map((bundle) => bundle.digest));
		for (const digest of digests) {
			const uploadId = uploadIdSchema.parse(crypto.randomUUID());
			const now = new Date();
			const expiresAt = isoTimestamp(new Date(now.getTime() + 15 * 60 * 1000));
			const r2Key = attestationStagingObjectKey(body.pushId, uploadId);
			const isAuthorised = await this.hasOwnBundleReferenceInCache(
				cache,
				digest
			);
			const incarnation = isAuthorised
				? await this.availableBundleIncarnation(digest)
				: undefined;
			const existing =
				incarnation === undefined
					? undefined
					: await this.context.env.BLOBS.get(casObjectKey(digest, incarnation));
			this.context.db
				.insert(schema.pendingAttestations)
				.values({
					id: uploadId,
					cacheId: cache.id,
					digest,
					r2Key,
					createdAt: isoTimestamp(now),
					expiresAt
				})
				.run();
			if (existing != undefined) {
				await this.context.env.BLOBS.put(r2Key, existing.body, {
					sha256: digest
				});
				bundles.push({ action: 'reuse', digest, uploadId, expiresAt });
				continue;
			}
			bundles.push({ action: 'upload', digest, uploadId, r2Key, expiresAt });
		}
		return { bundles };
	}

	async attachPaths(
		cacheScope: CacheScope,
		uploadId: UploadId,
		storePathHashes: readonly StorePathHash[]
	): Promise<AttestationAttachPathsResponseInput> {
		requireSubrequestsFor(
			attestationAttachOverheadSubrequests +
				storePathHashes.length * attestationAttachPathSubrequests,
			'attestation attachment'
		);
		const bundle = await this.prepareBundle(
			cacheScope,
			uploadId,
			storePathHashes
		);
		const paths = await Array.fromAsync(storePathHashes, (storePathHash) =>
			this.context.criticalSection(() =>
				this.attachBundlePathLocked(uploadId, bundle, storePathHash)
			)
		);
		const { row: pending } = await this.pendingUpload(cacheScope, uploadId);
		return { paths, expiresAt: pending.expiresAt };
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

		const cache = await this.registration.forWrite(cacheScope);
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

		if (pending.storePathHash === null) {
			throw new AttestationUploadNotFoundError(uploadId);
		}

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
		const pendingPath = { ...pending, storePathHash: pending.storePathHash };

		// Do not reject inside blockConcurrencyWhile; Cloudflare would break the
		// Durable Object's input gate. Rethrow after leaving the callback.
		const finalised = await this.context.criticalSection(async () => {
			try {
				const value = await this.finaliseAttach(
					cache,
					pendingPath,
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
			this.listKey(cache, storePathHash),
			'application/json; charset=utf-8',
			'no-store',
			(object) => isListOfCommittedGeneration(object, cache, committed)
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

	/**
	 * Of these stored list objects, the ones that still describe the generation
	 * this cache's narinfo row holds for the path.
	 *
	 * This is the read path's own test, `isListOfCommittedGeneration`, with the
	 * local row standing in for the D1 edge the read compares against. A list
	 * object records a generation and no NAR hash, so the comparison is by
	 * generation alone, and an object with no recorded generation is treated
	 * exactly as a read of this cache would treat it.
	 */
	currentListObjects(
		cache: ResolvedCache,
		objects: ReadonlyMap<StorePathHash, R2Object>
	): ReadonlySet<StorePathHash> {
		const generations = new Map(
			this.narInfoObjects
				.narInfoRowsFor(cache, objects.keys().toArray())
				.map((row) => [row.storePathHash, row.generation])
		);
		const current = new Set<StorePathHash>();

		for (const [storePathHash, object] of objects) {
			const generation = generations.get(storePathHash);

			if (
				generation !== undefined &&
				isListOfCommittedGeneration(object, cache, generation)
			) {
				current.add(storePathHash);
			}
		}

		return current;
	}

	async materialiseList(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation?: NarInfoGeneration
	): Promise<void> {
		const key = this.listKey(cache, storePathHash);
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

		const body: AttestationListInput = { attestations: descriptors };
		await this.context.objectWrites.write([key], () =>
			this.context.env.BLOBS.put(key, `${JSON.stringify(body)}\n`, {
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
			})
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

		const keys = [...new Set(storePathHashes)].map((storePathHash) =>
			this.listKey(cache, storePathHash)
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
		const key = this.listKey(cache, storePathHash);

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

const attestationSubjectSchema = z.object({
	name: z.string().optional(),
	digest: z.object({ sha256: sha256HexDigestSchema })
});
const attestationStatementSchema = inTotoStatementSchema({
	sha256: sha256HexDigestSchema,
	predicateType: predicateTypeSchema
})
	.extend({ subject: z.array(attestationSubjectSchema).min(1) })
	.transform((statement) => ({
		predicateType: statement.predicateType,
		subjects: statement.subject.map((subject) => ({
			name: subject.name ?? '',
			digest: subject.digest.sha256
		}))
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

const validatedAttestationBundleSchema = z.strictObject({
	predicateType: predicateTypeSchema,
	size: z.number().int().positive()
});
