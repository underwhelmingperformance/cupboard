import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheFromSelector,
	type NixSha256HashString,
	PRIVATE_STORED_RANGE_END,
	PRIVATE_STORED_RANGE_START,
	publicCacheSelectorSchema,
	referencesSchema,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	type ParsedReuseViewName,
	type ReuseViewRevision
} from '@cupboard/protocol/reuse-views';
import {
	and,
	eq,
	getTableColumns,
	gte,
	inArray,
	lt,
	lte,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

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
	maxInClauseValues,
	presentNarObjects
} from './bulk.ts';
import { type ServerContext } from './context.ts';
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
	readonly candidates: readonly CandidateRow[];
}

interface GateBatchSnapshot {
	readonly tenant: TenantId;
	readonly revision: number;
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

const maxEdgeCandidatesPerQuery = Math.floor((maxInClauseValues - 1) / 3);
const maxCurrentCandidatesPerQuery = Math.floor(maxInClauseValues / 2);

function candidateKey(
	candidate: Pick<CandidateRow, 'cache' | 'storePathHash'>
): string {
	return JSON.stringify([candidate.cache, candidate.storePathHash]);
}

function candidateVersionKey(
	candidate: Pick<
		CandidateRow,
		'cache' | 'storePathHash' | 'generation' | 'narHash'
	>
): string {
	return JSON.stringify([
		candidate.cache,
		candidate.storePathHash,
		candidate.generation,
		candidate.narHash
	]);
}

// Increment the last code unit to form an exclusive upper bound. Cache names
// are ASCII, so this cannot split or overflow a code point.
function prefixUpperBound(prefix: string): string {
	const last = prefix.codePointAt(prefix.length - 1);

	if (last === undefined) {
		throw new RangeError('prefix must be non-empty');
	}

	return prefix.slice(0, -1) + String.fromCodePoint(last + 1);
}

// Prefix selectors match public caches only. Exclude the private stored-name
// range from every prefix query. A public cache called `private` sorts below
// that range and remains matchable.
function outsidePrivateRange(): SQL | undefined {
	return or(
		lt(schema.narInfos.cache, sql`${PRIVATE_STORED_RANGE_START}`),
		gte(schema.narInfos.cache, sql`${PRIVATE_STORED_RANGE_END}`)
	);
}

const privateRangeParameters = 2;

function selectorParameters(selector: {
	kind: 'exact' | 'prefix';
	pattern: string;
}): number {
	if (selector.kind === 'exact') {
		return 1;
	}

	return selector.pattern === ''
		? privateRangeParameters
		: 2 + privateRangeParameters;
}

function selectorCondition(selector: {
	kind: 'exact' | 'prefix';
	pattern: string;
}): SQL | undefined {
	if (selector.kind === 'exact') {
		const cache = cacheFromSelector(
			publicCacheSelectorSchema.parse(selector.pattern)
		);

		return eq(schema.narInfos.cache, cache);
	}

	if (selector.pattern === '') {
		return outsidePrivateRange();
	}

	// Prefix patterns are not complete selectors, so compare them directly with
	// the stored names in the `cache` column.
	return and(
		gte(schema.narInfos.cache, sql`${selector.pattern}`),
		lt(schema.narInfos.cache, sql`${prefixUpperBound(selector.pattern)}`),
		outsidePrivateRange()
	);
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

	// Read the view revision and candidates in one input-gate snapshot. Each
	// selector uses the (store_path_hash, cache) index and returns a bounded
	// number of rows.
	private snapshotCandidates(
		logger: Logger,
		view: ParsedReuseViewName,
		storePathHash: StorePathHash
	): GateSnapshot | undefined {
		const viewRow = this.context.db
			.select({ revision: schema.reuseViews.revision })
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (viewRow === undefined) {
			return undefined;
		}

		const selectors = this.context.db
			.select({
				kind: schema.reuseViewSelectors.kind,
				pattern: schema.reuseViewSelectors.pattern
			})
			.from(schema.reuseViewSelectors)
			.where(eq(schema.reuseViewSelectors.view, view))
			.all();

		const byCache = new Map<string, CandidateRow>();

		for (const selector of selectors) {
			for (const row of this.selectorRows(selector, storePathHash)) {
				byCache.set(row.cache, row);
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
			candidates: byCache.values().toArray()
		};
	}

	private selectorRows(
		selector: { kind: 'exact' | 'prefix'; pattern: string },
		storePathHash: StorePathHash
	): CandidateRow[] {
		const hashMatch = eq(schema.narInfos.storePathHash, storePathHash);

		if (selector.kind === 'exact') {
			const cache = cacheFromSelector(
				publicCacheSelectorSchema.parse(selector.pattern)
			);

			return this.context.db
				.select()
				.from(schema.narInfos)
				.where(and(hashMatch, eq(schema.narInfos.cache, cache)))
				.all();
		}

		const cacheRange = selectorCondition(selector);

		return this.context.db
			.select()
			.from(schema.narInfos)
			.where(and(hashMatch, cacheRange))
			.limit(reuseCandidateLimit + 1)
			.all();
	}

	private snapshotCandidateBatch(
		logger: Logger,
		view: ParsedReuseViewName,
		storePathHashes: readonly StorePathHash[]
	): GateBatchSnapshot | undefined {
		const viewRow = this.context.db
			.select({ revision: schema.reuseViews.revision })
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (viewRow === undefined) {
			return undefined;
		}

		const selectors = this.context.db
			.select({
				kind: schema.reuseViewSelectors.kind,
				pattern: schema.reuseViewSelectors.pattern
			})
			.from(schema.reuseViewSelectors)
			.where(eq(schema.reuseViewSelectors.view, view))
			.all();
		const hasAllCacheSelector = selectors.some(
			(selector) => selector.kind === 'prefix' && selector.pattern === ''
		);
		const selectorConditions = selectors.flatMap((selector) => {
			const condition = selectorCondition(selector);
			return condition === undefined ? [] : [condition];
		});
		// An empty prefix matches every public cache, so its condition alone covers
		// the other selectors.
		const cacheFilter = hasAllCacheSelector
			? outsidePrivateRange()
			: or(...selectorConditions);
		const selectorParameterCount = hasAllCacheSelector
			? privateRangeParameters
			: selectors.reduce(
					(count, selector) => count + selectorParameters(selector),
					0
				);
		const maxHashesPerQuery = Math.max(
			1,
			maxInClauseValues - selectorParameterCount
		);
		const rows = chunk(storePathHashes, maxHashesPerQuery).flatMap(
			(storePathHashBatch) => {
				const hashFilter = inArray(
					schema.narInfos.storePathHash,
					storePathHashBatch
				);
				const selectedRowsFilter = and(hashFilter, cacheFilter);
				const ranked = this.context.db.$with('reuse_candidates').as(
					this.context.db
						.select({
							...getTableColumns(schema.narInfos),
							candidateRank: sql<number>`row_number() over (
									partition by ${schema.narInfos.storePathHash}
									order by ${schema.narInfos.cache}
								)`.as('candidate_rank')
						})
						.from(schema.narInfos)
						.where(selectedRowsFilter)
				);

				return this.context.db
					.with(ranked)
					.select()
					.from(ranked)
					.where(lte(ranked.candidateRank, reuseCandidateLimit + 1))
					.all();
			}
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
		const edgeQueries = candidates.map((candidate) =>
			this.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(
					and(
						eq(d1Schema.blobReference.tenant, tenant),
						eq(d1Schema.blobReference.cache, candidate.cache),
						eq(d1Schema.blobReference.storePathHash, storePathHash),
						eq(d1Schema.blobReference.generation, candidate.generation)
					)
				)
		);
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
				.map((candidate) => candidate.cache)
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
				committedCaches.has(candidate.cache) &&
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
						eq(d1Schema.blobReference.cache, candidate.cache),
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
						cache: d1Schema.blobReference.cache,
						storePathHash: d1Schema.blobReference.storePathHash,
						generation: d1Schema.blobReference.generation,
						narHash: d1Schema.blobReference.narHash
					})
					.from(d1Schema.blobReference)
					.where(edgeFilter);
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
			edgePages.flat().map((edge) => candidateVersionKey(edge))
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
				committedCandidates.has(candidateVersionKey(candidate)) &&
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
		view: ParsedReuseViewName,
		verified: VerifiedCandidates
	): VerifiedCandidates | undefined {
		const viewRow = this.context.db
			.select({ revision: schema.reuseViews.revision })
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (viewRow?.revision !== snapshot.revision) {
			return undefined;
		}

		for (const candidate of verified.candidates) {
			const current = this.context.db
				.select({
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, candidate.cache),
						eq(schema.narInfos.storePathHash, candidate.storePathHash)
					)
				)
				.get();

			if (
				current?.generation !== candidate.generation ||
				current.narHash !== candidate.narHash
			) {
				return undefined;
			}
		}

		return verified;
	}

	private revalidateCandidates(
		revision: number,
		view: ParsedReuseViewName,
		verified: VerifiedCandidates
	): VerifiedCandidates | undefined {
		const viewRow = this.context.db
			.select({ revision: schema.reuseViews.revision })
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, view))
			.get();

		if (viewRow?.revision !== revision) {
			return undefined;
		}

		const currentRows = chunk(
			verified.candidates,
			maxCurrentCandidatesPerQuery
		).flatMap((candidateBatch) =>
			this.context.db
				.select({
					cache: schema.narInfos.cache,
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.where(
					or(
						...candidateBatch.map((candidate) =>
							and(
								eq(schema.narInfos.cache, candidate.cache),
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
				current?.generation !== candidate.generation ||
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
		view: ParsedReuseViewName,
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
					.map((candidate) => candidate.cache)
					.toSorted(byCodeUnit)
			});

			return false;
		}

		return true;
	}

	private renderSingleCandidate(
		logger: Logger,
		view: ParsedReuseViewName,
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
		const ordered = settled.candidates.toSorted((left, right) =>
			byCodeUnit(left.cache, right.cache)
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

		// This narinfo is two path segments below the tenant's canonical NAR route.
		return new NarInfo(
			new StorePath(row.storePath),
			`../../${narObjectKey(row.narHash, blob.incarnation)}`,
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
		view: ParsedReuseViewName,
		storePathHash: StorePathHash
	): Promise<NarInfo | undefined> {
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(this.snapshotCandidates(logger, view, storePathHash))
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
		view: ParsedReuseViewName,
		storePathHashes: readonly StorePathHash[]
	): Promise<StorePathHash[]> {
		const uniqueHashes = [...new Set(storePathHashes)];
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(this.snapshotCandidateBatch(logger, view, uniqueHashes))
		);

		if (snapshot === undefined || snapshot.candidates.length === 0) {
			return uniqueHashes;
		}

		const verified = await this.verifyCandidates(
			snapshot.tenant,
			snapshot.candidates
		);
		const settled = await this.context.criticalSection(() =>
			Promise.resolve(
				this.revalidateCandidates(snapshot.revision, view, verified)
			)
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
