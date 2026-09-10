import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheAccessMode,
	type CacheScope,
	type NixSha256HashString,
	referencesSchema,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	type ReuseViewName,
	type ReuseViewRevision,
	type ReuseViewSelector
} from '@cupboard/protocol/reuse-views';
import {
	and,
	eq,
	getTableColumns,
	inArray,
	isNull,
	lte,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

import {
	cacheIdentityCondition,
	cacheScopeFromRow,
	cacheSelectorCondition,
	cacheSelectorsCondition
} from '../db/cache.ts';
import {
	authorisedByCacheGeneration,
	referencedCacheLifecycle
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { readWithOneRetry } from '../db/transient.ts';
import {
	SharedFactsUnavailableError,
	StoredReferencesInvalidError,
	StoredSignaturesInvalidError
} from '../errors.ts';
import { narObjectKey } from '../http/http.ts';
import { parseStored } from '../http/parse.ts';

import {
	batchNonEmpty,
	chunk,
	chunkByStatementParameters,
	maxInClauseValues,
	presentNarObjects
} from './bulk.ts';
import { type ServerContext } from './context.ts';
import { reuseViewSelectorsFromRows } from './reuse-view-selectors.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

/**
 * The most distinct source-cache copies of one store-path hash a lookup will
 * verify. A hash with more copies than this is served as a miss and recorded
 * as a structured event; the candidate set is never truncated. A miss only
 * sends the reader to its next substituter or to a local build, whereas a
 * narinfo computed from a truncated candidate set could hide a conflict.
 */
export const reuseCandidateLimit = 16;

type CandidateRow = typeof schema.narInfos.$inferSelect;

interface GateSnapshot {
	readonly tenant: TenantId;
	readonly revision: ReuseViewRevision;
	readonly access: CacheAccessMode;
	readonly candidates: readonly CandidateRow[];
}

interface GateBatchSnapshot {
	readonly tenant: TenantId;
	readonly revision: number;
	readonly access: CacheAccessMode;
	readonly candidates: readonly CandidateRow[];
}

interface BlobFields {
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
	readonly compression: 'zstd';
	readonly incarnation: number;
}

interface VerifiedCandidates {
	readonly candidates: readonly CandidateRow[];
	readonly blobs: ReadonlyMap<string, BlobFields>;
}

function recordedObjectVersions(
	candidates: readonly CandidateRow[],
	blobs: ReadonlyMap<string, BlobFields>
): { readonly narHash: NixSha256HashString; readonly incarnation: number }[] {
	return candidates.flatMap((candidate) => {
		const blob = blobs.get(candidate.narHash);

		return blob === undefined
			? []
			: [{ narHash: candidate.narHash, incarnation: blob.incarnation }];
	});
}

const maxEdgeCandidatesPerQuery = Math.floor((maxInClauseValues - 1) / 5);
const maxCurrentCandidatesPerQuery = Math.floor(maxInClauseValues / 2);

function candidateKey(
	candidate: Pick<CandidateRow, 'cacheId' | 'storePathHash'>
): string {
	return JSON.stringify([candidate.cacheId, candidate.storePathHash]);
}

function candidateVersionKey(
	candidate: Pick<CandidateRow, 'storePathHash' | 'generation' | 'narHash'>,
	cache: CacheScope
): string {
	return JSON.stringify([
		cache,
		candidate.storePathHash,
		candidate.generation,
		candidate.narHash
	]);
}

/**
 * The NAR URL a view's narinfo advertises, relative to the base URL the reader
 * addressed the view with.
 *
 * The NAR remains under the view's stable route. The route resolves the view
 * again and applies the same access check as the narinfo request.
 */
function narUrlForView(
	narHash: NixSha256HashString,
	incarnation: number
): string {
	const key = narObjectKey(narHash, incarnation);

	return key;
}

/**
 * Resolves narinfos through a reuse view. Unlike ordinary narinfo reads, this
 * path enters the Durable Object so it can fence the view revision and local
 * candidate generations. Shared D1 and R2 reads run outside the input gate,
 * followed by a synchronous revalidation under the gate.
 */
export class ReuseViewLookupService {
	// Planner concurrency can repeat an over-limit lookup many times. Warn once
	// per view so these configuration warnings do not obscure integrity events.
	private readonly warnedOverLimitViews = new Set<string>();

	constructor(private readonly context: ServerContext) {}

	private selectorCondition(selector: ReuseViewSelector): SQL | undefined {
		return cacheSelectorCondition(
			schema.caches.kind,
			schema.caches.name,
			selector
		);
	}

	// Read the view revision and candidates in one input-gate snapshot. Each
	// selector uses the (store_path_hash, cache) index and returns a bounded
	// number of rows.
	private snapshotCandidates(
		logger: Logger,
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHash: StorePathHash
	): GateSnapshot | undefined {
		const viewRow = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision
			})
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (viewRow?.access !== access) {
			return undefined;
		}

		const selectors = reuseViewSelectorsFromRows(
			view,
			this.context.db
				.select({
					kind: schema.reuseViewSelectors.kind,
					cacheName: schema.reuseViewSelectors.cacheName,
					prefix: schema.reuseViewSelectors.prefix
				})
				.from(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, view))
				.all()
		);

		const byCache = new Map<CandidateRow['cacheId'], CandidateRow>();

		for (const selector of selectors) {
			for (const row of this.selectorRows(
				selector,
				viewRow.access,
				storePathHash
			)) {
				byCache.set(row.cacheId, row);
			}

			if (byCache.size > reuseCandidateLimit) {
				if (!this.warnedOverLimitViews.has(view)) {
					this.warnedOverLimitViews.add(view);
					logger.warn('reuse lookup exceeded the candidate limit', {
						view,
						storePathHash,
						candidateLimit: reuseCandidateLimit
					});
				}

				return undefined;
			}
		}

		return {
			tenant: this.context.requireTenant(),
			revision: viewRow.revision,
			access: viewRow.access,
			candidates: byCache.values().toArray()
		};
	}

	private selectorRows(
		selector: ReuseViewSelector,
		access: CacheAccessMode,
		storePathHash: StorePathHash
	): CandidateRow[] {
		const hashMatch = eq(schema.narInfos.storePathHash, storePathHash);
		const cacheCondition = this.selectorCondition(selector);

		return this.context.db
			.select(getTableColumns(schema.narInfos))
			.from(schema.narInfos)
			.innerJoin(schema.caches, eq(schema.caches.id, schema.narInfos.cacheId))
			.where(
				and(
					hashMatch,
					eq(schema.caches.access, access),
					isNull(schema.caches.deletedAt),
					cacheCondition
				)
			)
			.limit(reuseCandidateLimit + 1)
			.all();
	}

	private snapshotCandidateBatch(
		logger: Logger,
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHashes: readonly StorePathHash[]
	): GateBatchSnapshot | undefined {
		const viewRow = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision
			})
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (viewRow?.access !== access) {
			return undefined;
		}

		const selectors = reuseViewSelectorsFromRows(
			view,
			this.context.db
				.select({
					kind: schema.reuseViewSelectors.kind,
					cacheName: schema.reuseViewSelectors.cacheName,
					prefix: schema.reuseViewSelectors.prefix
				})
				.from(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, view))
				.all()
		);
		const cacheFilter = cacheSelectorsCondition(
			schema.caches.kind,
			schema.caches.name,
			selectors
		);
		const candidateStatement = (
			storePathHashBatch: readonly StorePathHash[]
		) => {
			const hashFilter = inArray(
				schema.narInfos.storePathHash,
				storePathHashBatch
			);
			const selectedRowsFilter = and(hashFilter, cacheFilter);
			const activeRowsFilter = and(
				selectedRowsFilter,
				eq(schema.caches.access, viewRow.access),
				isNull(schema.caches.deletedAt)
			);
			const ranked = this.context.db.$with('reuse_candidates').as(
				this.context.db
					.select({
						...getTableColumns(schema.narInfos),
						candidateRank: sql<number>`row_number() over (
									partition by ${schema.narInfos.storePathHash}
									order by ${schema.narInfos.cacheId}
								)`.as('candidate_rank')
					})
					.from(schema.narInfos)
					.innerJoin(
						schema.caches,
						eq(schema.caches.id, schema.narInfos.cacheId)
					)
					.where(activeRowsFilter)
			);

			return this.context.db
				.with(ranked)
				.select()
				.from(ranked)
				.where(lte(ranked.candidateRank, reuseCandidateLimit + 1));
		};
		const rows = chunkByStatementParameters(
			storePathHashes,
			candidateStatement
		).flatMap((storePathHashBatch) =>
			candidateStatement(storePathHashBatch).all()
		);
		const candidatesByHash = new Map<StorePathHash, CandidateRow[]>();

		for (const row of rows) {
			const candidates = candidatesByHash.get(row.storePathHash) ?? [];
			candidates.push(row);
			candidatesByHash.set(row.storePathHash, candidates);
		}

		const candidates: CandidateRow[] = [];

		for (const [storePathHash, selected] of candidatesByHash) {
			if (selected.length > reuseCandidateLimit) {
				if (!this.warnedOverLimitViews.has(view)) {
					this.warnedOverLimitViews.add(view);
					logger.warn('reuse lookup exceeded the candidate limit', {
						view,
						storePathHash,
						candidateLimit: reuseCandidateLimit
					});
				}

				continue;
			}

			candidates.push(...selected);
		}

		return {
			tenant: this.context.requireTenant(),
			revision: viewRow.revision,
			access: viewRow.access,
			candidates
		};
	}

	// A local narinfo row can describe a generation that is still reserved.
	// Require the exact committed edge, tenant ownership, blob metadata, and a
	// live canonical object before using a candidate.
	private async verifyOffGate(
		snapshot: GateSnapshot
	): Promise<VerifiedCandidates> {
		const { tenant, candidates } = snapshot;
		const [first] = candidates;

		if (first === undefined) {
			return { candidates: [], blobs: new Map() };
		}

		const storePathHash = first.storePathHash;
		const uniqueHashes = [
			...new Set(candidates.map((candidate) => candidate.narHash))
		];
		const edgeQueries = candidates.map((candidate) => {
			const cache = this.context.cacheRepository.scopeForId(candidate.cacheId);
			const cacheFilter = cacheIdentityCondition(
				d1Schema.blobReference.cacheKind,
				d1Schema.blobReference.cacheName,
				cache
			);
			const edgeFilter = and(
				eq(d1Schema.blobReference.tenant, tenant),
				cacheFilter,
				eq(d1Schema.blobReference.storePathHash, storePathHash),
				eq(d1Schema.blobReference.generation, candidate.generation)
			);

			return this.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
				.where(
					and(
						edgeFilter,
						eq(d1Schema.cacheLifecycle.access, snapshot.access),
						authorisedByCacheGeneration()
					)
				);
		});
		const [edgeResults, states, owned] = await this.sharedFacts(() =>
			Promise.all([
				readWithOneRetry(() => batchNonEmpty(this.context.d1, edgeQueries)),
				readWithOneRetry(() =>
					this.context.d1
						.select({
							narHash: d1Schema.blobState.narHash,
							fileHash: d1Schema.blobState.fileHash,
							fileSize: d1Schema.blobState.fileSize,
							compression: d1Schema.blobState.compression,
							incarnation: d1Schema.blobState.incarnation
						})
						.from(d1Schema.blobState)
						.where(inArray(d1Schema.blobState.narHash, uniqueHashes))
						.all()
				),
				readWithOneRetry(() =>
					this.context.d1
						.select({ narHash: d1Schema.tenantBlob.narHash })
						.from(d1Schema.tenantBlob)
						.where(
							and(
								eq(d1Schema.tenantBlob.tenant, tenant),
								inArray(d1Schema.tenantBlob.narHash, uniqueHashes)
							)
						)
						.all()
				)
			])
		);

		const committedCaches = new Set(
			candidates
				.filter(
					(candidate, index) =>
						edgeResults[index]?.[0]?.narHash === candidate.narHash
				)
				.map((candidate) => candidate.cacheId)
		);
		const blobs = new Map(
			states.map((state) => [
				state.narHash,
				{
					fileHash: state.fileHash,
					fileSize: state.fileSize,
					compression: state.compression,
					incarnation: state.incarnation
				}
			])
		);
		const ownedHashes = new Set(owned.map((row) => row.narHash));
		const backed = candidates.filter(
			(candidate) =>
				committedCaches.has(candidate.cacheId) &&
				blobs.has(candidate.narHash) &&
				ownedHashes.has(candidate.narHash)
		);
		const presentHashes = await this.sharedFacts(() =>
			presentNarObjects(
				this.context.env.BLOBS,
				recordedObjectVersions(backed, blobs)
			)
		);

		return {
			candidates: backed.filter((candidate) =>
				presentHashes.has(candidate.narHash)
			),
			blobs
		};
	}

	private async verifyCandidates(
		tenant: TenantId,
		access: CacheAccessMode,
		candidates: readonly CandidateRow[]
	): Promise<VerifiedCandidates> {
		if (candidates.length === 0) {
			return { candidates: [], blobs: new Map() };
		}

		const uniqueHashes = [
			...new Set(candidates.map((candidate) => candidate.narHash))
		];
		const edgeQueries = chunk(candidates, maxEdgeCandidatesPerQuery).map(
			(candidateBatch) => {
				const candidateFilters = candidateBatch.map((candidate) =>
					and(
						cacheIdentityCondition(
							d1Schema.blobReference.cacheKind,
							d1Schema.blobReference.cacheName,
							this.context.cacheRepository.scopeForId(candidate.cacheId)
						),
						eq(d1Schema.blobReference.storePathHash, candidate.storePathHash),
						eq(d1Schema.blobReference.generation, candidate.generation)
					)
				);
				const edgeFilter = and(
					eq(d1Schema.blobReference.tenant, tenant),
					or(...candidateFilters)
				);

				return this.context.d1
					.select({
						cacheKind: d1Schema.blobReference.cacheKind,
						cacheName: d1Schema.blobReference.cacheName,
						storePathHash: d1Schema.blobReference.storePathHash,
						generation: d1Schema.blobReference.generation,
						narHash: d1Schema.blobReference.narHash
					})
					.from(d1Schema.blobReference)
					.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
					.where(
						and(
							edgeFilter,
							eq(d1Schema.cacheLifecycle.access, access),
							authorisedByCacheGeneration()
						)
					);
			}
		);
		const stateQueries = chunk(uniqueHashes, maxInClauseValues).map(
			(narHashes) =>
				this.context.d1
					.select({
						narHash: d1Schema.blobState.narHash,
						fileHash: d1Schema.blobState.fileHash,
						fileSize: d1Schema.blobState.fileSize,
						compression: d1Schema.blobState.compression,
						incarnation: d1Schema.blobState.incarnation
					})
					.from(d1Schema.blobState)
					.where(inArray(d1Schema.blobState.narHash, narHashes))
		);
		const ownershipQueries = chunk(uniqueHashes, maxInClauseValues).map(
			(narHashes) =>
				this.context.d1
					.select({ narHash: d1Schema.tenantBlob.narHash })
					.from(d1Schema.tenantBlob)
					.where(
						and(
							eq(d1Schema.tenantBlob.tenant, tenant),
							inArray(d1Schema.tenantBlob.narHash, narHashes)
						)
					)
		);
		const [edgePages, statePages, ownershipPages] = await this.sharedFacts(() =>
			Promise.all([
				readWithOneRetry(() => batchNonEmpty(this.context.d1, edgeQueries)),
				readWithOneRetry(() => batchNonEmpty(this.context.d1, stateQueries)),
				readWithOneRetry(() => batchNonEmpty(this.context.d1, ownershipQueries))
			])
		);

		const committedCandidates = new Set(
			edgePages
				.flat()
				.map((edge) =>
					candidateVersionKey(
						edge,
						cacheScopeFromRow({ kind: edge.cacheKind, name: edge.cacheName })
					)
				)
		);
		const blobs = new Map(
			statePages.flat().map((state) => [
				state.narHash,
				{
					fileHash: state.fileHash,
					fileSize: state.fileSize,
					compression: state.compression,
					incarnation: state.incarnation
				}
			])
		);
		const ownedHashes = new Set(
			ownershipPages.flat().map((row) => row.narHash)
		);

		const backed = candidates.filter(
			(candidate) =>
				committedCandidates.has(
					candidateVersionKey(
						candidate,
						this.context.cacheRepository.scopeForId(candidate.cacheId)
					)
				) &&
				blobs.has(candidate.narHash) &&
				ownedHashes.has(candidate.narHash)
		);
		const presentHashes = await this.sharedFacts(() =>
			presentNarObjects(
				this.context.env.BLOBS,
				recordedObjectVersions(backed, blobs)
			)
		);

		return {
			candidates: backed.filter((candidate) =>
				presentHashes.has(candidate.narHash)
			),
			blobs
		};
	}

	// Revalidate the view revision and each surviving candidate under the input
	// gate. A concurrent view edit, recommit, or deletion then produces a miss
	// instead of serving a stale generation. Do not recheck candidates already
	// rejected off-gate: churn in an unusable row must not create a negative Nix
	// cache entry. Revision numbers also survive deletion, so recreating a view
	// cannot match a revision captured before deletion.
	private revalidateSnapshot(
		snapshot: GateSnapshot,
		view: ReuseViewName,
		verified: VerifiedCandidates
	): VerifiedCandidates | undefined {
		const viewRow = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision
			})
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (
			viewRow?.revision !== snapshot.revision ||
			viewRow.access !== snapshot.access
		) {
			return undefined;
		}

		for (const candidate of verified.candidates) {
			const current = this.context.db
				.select({
					access: schema.caches.access,
					deletedAt: schema.caches.deletedAt,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.innerJoin(schema.caches, eq(schema.caches.id, schema.narInfos.cacheId))
				.where(
					and(
						eq(schema.narInfos.cacheId, candidate.cacheId),
						eq(schema.narInfos.storePathHash, candidate.storePathHash)
					)
				)
				.get();

			if (
				current?.access !== snapshot.access ||
				current.deletedAt !== null ||
				current.generation !== candidate.generation ||
				current.narHash !== candidate.narHash
			) {
				return undefined;
			}
		}

		return verified;
	}

	private revalidateCandidates(
		snapshot: GateBatchSnapshot,
		view: ReuseViewName,
		verified: VerifiedCandidates
	): VerifiedCandidates | undefined {
		const viewRow = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision
			})
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (
			viewRow?.revision !== snapshot.revision ||
			viewRow.access !== snapshot.access
		) {
			return undefined;
		}

		const currentRows = chunk(
			verified.candidates,
			maxCurrentCandidatesPerQuery
		).flatMap((candidateBatch) =>
			this.context.db
				.select({
					access: schema.caches.access,
					cacheId: schema.narInfos.cacheId,
					deletedAt: schema.caches.deletedAt,
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.innerJoin(schema.caches, eq(schema.caches.id, schema.narInfos.cacheId))
				.where(
					or(
						...candidateBatch.map((candidate) =>
							and(
								eq(schema.narInfos.cacheId, candidate.cacheId),
								eq(schema.narInfos.storePathHash, candidate.storePathHash)
							)
						)
					)
				)
				.all()
		);
		const currentByCandidate = new Map(
			currentRows.map((current) => [candidateKey(current), current])
		);

		for (const candidate of verified.candidates) {
			const current = currentByCandidate.get(candidateKey(candidate));

			if (
				current?.access !== snapshot.access ||
				current.deletedAt !== null ||
				current.generation !== candidate.generation ||
				current.narHash !== candidate.narHash
			) {
				return undefined;
			}
		}

		return verified;
	}

	// Signature sets may differ after key rotation without making two copies
	// conflict. Compare the common fingerprint fields instead, with references
	// sorted because the fingerprint treats them as a set.
	private hasSingleSemanticCandidate(
		logger: Logger,
		view: ReuseViewName,
		storePathHash: StorePathHash,
		candidates: readonly CandidateRow[]
	): boolean {
		if (candidates.length === 0) {
			return false;
		}

		const referencesFault = (cause: Error): StoredReferencesInvalidError =>
			new StoredReferencesInvalidError(storePathHash, cause);
		const semanticKeys = new Set(
			candidates.map((candidate) =>
				JSON.stringify([
					candidate.storePath,
					candidate.narHash,
					candidate.narSize,
					[
						...parseStored(
							referencesSchema,
							candidate.referencesJson,
							referencesFault
						)
					].toSorted(byCodeUnit),
					candidate.deriver,
					candidate.ca
				])
			)
		);

		if (semanticKeys.size > 1) {
			logger.warn('reuse lookup found conflicting candidates', {
				view,
				storePathHash,
				caches: candidates
					.map((candidate) =>
						this.context.cacheRepository.scopeForId(candidate.cacheId)
					)
					.map((cache) => JSON.stringify(cache))
					.toSorted(byCodeUnit)
			});

			return false;
		}

		return true;
	}

	private renderSingleCandidate(
		logger: Logger,
		view: ReuseViewName,
		storePathHash: StorePathHash,
		settled: VerifiedCandidates
	): NarInfo | undefined {
		if (
			!this.hasSingleSemanticCandidate(
				logger,
				view,
				storePathHash,
				settled.candidates
			)
		) {
			return undefined;
		}

		const referencesFault = (cause: Error): StoredReferencesInvalidError =>
			new StoredReferencesInvalidError(storePathHash, cause);
		const ordered = settled.candidates.toSorted(
			(left, right) => left.cacheId - right.cacheId
		);
		const row = ordered[0];

		if (row === undefined) {
			return undefined;
		}

		const blob = settled.blobs.get(row.narHash);

		if (blob === undefined) {
			return undefined;
		}

		const signaturesFault = (cause: Error): StoredSignaturesInvalidError =>
			new StoredSignaturesInvalidError(storePathHash, cause);
		const signatures = [
			...new Set(
				ordered.flatMap((candidate) =>
					parseStored(
						storedSignaturesSchema,
						candidate.sigsJson,
						signaturesFault
					)
				)
			)
		].toSorted(byCodeUnit);

		return new NarInfo(
			new StorePath(row.storePath),
			narUrlForView(row.narHash, blob.incarnation),
			blob.compression,
			NixSha256Hash.parse(blob.fileHash),
			blob.fileSize,
			NixSha256Hash.parse(row.narHash),
			row.narSize,
			parseStored(referencesSchema, row.referencesJson, referencesFault),
			row.deriver ?? undefined,
			row.ca ?? undefined,
			signatures
		);
	}

	// A shared-state fault must remain distinguishable from a missing path. The
	// latter can make Nix rebuild a path that the cache still has.
	private async sharedFacts<T>(read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	/**
	 * Returns a virtual narinfo when every usable source agrees on the path.
	 * Unknown views, absent or conflicting candidates, over-limit candidate
	 * sets, and concurrent mutations return `undefined`. Shared-state failures
	 * throw a retryable error instead of appearing to be a missing path.
	 */
	async lookup(
		logger: Logger,
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHash: StorePathHash
	): Promise<NarInfo | undefined> {
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(
				this.snapshotCandidates(logger, view, access, storePathHash)
			)
		);

		if (snapshot === undefined || snapshot.candidates.length === 0) {
			return undefined;
		}

		const verified = await this.verifyOffGate(snapshot);
		const settled = await this.context.criticalSection(() =>
			Promise.resolve(this.revalidateSnapshot(snapshot, view, verified))
		);

		if (settled === undefined) {
			return undefined;
		}

		return this.renderSingleCandidate(logger, view, storePathHash, settled);
	}

	/**
	 * Deduplicates the requested hashes and returns those without one verified,
	 * unambiguous candidate. A concurrent view mutation invalidates the complete
	 * batch rather than mixing revisions.
	 */
	async missingStorePathHashes(
		logger: Logger,
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHashes: readonly StorePathHash[]
	): Promise<StorePathHash[]> {
		const uniqueHashes = [...new Set(storePathHashes)];
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(
				this.snapshotCandidateBatch(logger, view, access, uniqueHashes)
			)
		);

		if (snapshot === undefined || snapshot.candidates.length === 0) {
			return uniqueHashes;
		}

		const verified = await this.verifyCandidates(
			snapshot.tenant,
			snapshot.access,
			snapshot.candidates
		);
		const settled = await this.context.criticalSection(() =>
			Promise.resolve(this.revalidateCandidates(snapshot, view, verified))
		);

		if (settled === undefined) {
			return uniqueHashes;
		}

		const candidatesByHash = new Map<StorePathHash, CandidateRow[]>();

		for (const candidate of settled.candidates) {
			const candidates = candidatesByHash.get(candidate.storePathHash) ?? [];
			candidates.push(candidate);
			candidatesByHash.set(candidate.storePathHash, candidates);
		}

		return uniqueHashes.filter(
			(storePathHash) =>
				!this.hasSingleSemanticCandidate(
					logger,
					view,
					storePathHash,
					candidatesByHash.get(storePathHash) ?? []
				)
		);
	}
}
