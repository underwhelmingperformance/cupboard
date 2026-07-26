import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	DEFAULT_CACHE,
	type NixSha256HashString,
	referencesSchema,
	type StorePathHash,
	type TenantId,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import { type ParsedReuseViewName } from '@cupboard/protocol/reuse-views';
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
 * verify. More copies than this answers as a miss (with a structured event)
 * rather than truncating: a miss only degrades the reader to its next
 * substituter or a local build, whereas an answer computed from a truncated
 * candidate set could hide a conflict.
 */
export const reuseCandidateLimit = 16;

type CandidateRow = typeof schema.narInfos.$inferSelect;

interface GateSnapshot {
	readonly tenant: TenantId;
	readonly revision: number;
	readonly candidates: readonly CandidateRow[];
}

interface GateBatchSnapshot {
	readonly tenant: TenantId;
	readonly revision: number;
	readonly candidates: readonly CandidateRow[];
}

// The canonical compressed metadata a virtual narinfo joins in from
// `blob_state`, keyed by NAR hash.
interface BlobFields {
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
	readonly compression: 'zstd';
}

interface VerifiedCandidates {
	readonly candidates: readonly CandidateRow[];
	readonly blobs: ReadonlyMap<string, BlobFields>;
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

// The exclusive upper bound of the cache-name range a non-empty prefix
// selector matches: the prefix with its last code unit incremented. Cache
// names are ASCII, so the successor never overflows a code point.
function prefixUpperBound(prefix: string): string {
	const last = prefix.codePointAt(prefix.length - 1);

	if (last === undefined) {
		throw new RangeError('prefix must be non-empty');
	}

	return prefix.slice(0, -1) + String.fromCodePoint(last + 1);
}

function selectorCondition(selector: {
	kind: 'exact' | 'prefix';
	pattern: string;
}): SQL | undefined {
	if (selector.kind === 'exact') {
		const cache =
			selector.pattern === WIRE_DEFAULT_CACHE
				? DEFAULT_CACHE
				: selector.pattern;

		return eq(schema.narInfos.cache, cache);
	}

	if (selector.pattern === '') {
		return undefined;
	}

	return and(
		gte(schema.narInfos.cache, selector.pattern),
		lt(schema.narInfos.cache, prefixUpperBound(selector.pattern))
	);
}

/**
 * Serves reuse-view narinfo lookups. This is a deliberate exception to the
 * read architecture: ordinary narinfo reads never enter the Durable Object,
 * but a view needs the definition-revision fence and the stored row fields,
 * so it pays the round trip. The gate is held only for synchronous row reads;
 * the D1 edge, ownership and shared-fact reads and the canonical-object
 * probes all run between the two gate entries, and the second entry
 * revalidates everything the first snapshotted.
 */
export class ReuseViewLookupService {
	// An over-limit view is a configuration state, not an event: probed at
	// planner concurrency it would repeat this warning per lookup and drown
	// the genuinely rare integrity events on the same channel, so each view
	// warns once per instance lifetime.
	private readonly warnedOverLimitViews = new Set<string>();

	constructor(private readonly context: ServerContext) {}

	// Gate 1: the view definition and the local candidate rows, read
	// synchronously under the input gate so they are one consistent snapshot.
	// Each selector issues one bounded query against the (store_path_hash,
	// cache) index, so the work scales with the selector list and the copies
	// of this hash, not with everything the source caches hold.
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
			const cache =
				selector.pattern === WIRE_DEFAULT_CACHE
					? DEFAULT_CACHE
					: selector.pattern;

			return this.context.db
				.select()
				.from(schema.narInfos)
				.where(and(hashMatch, eq(schema.narInfos.cache, cache)))
				.all();
		}

		const cacheRange =
			selector.pattern === ''
				? undefined
				: and(
						gte(schema.narInfos.cache, selector.pattern),
						lt(schema.narInfos.cache, prefixUpperBound(selector.pattern))
					);

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
		const cacheFilter = hasAllCacheSelector
			? undefined
			: or(...selectorConditions);
		const selectorParameterCount = hasAllCacheSelector
			? 0
			: selectors.reduce(
					(count, selector) => count + (selector.kind === 'exact' ? 1 : 2),
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

	// Between the gates: retain only candidates backed by the exact committed
	// D1 edge, this tenant's ownership fact, the shared blob fact, and a live
	// canonical object. A local row carries no reservation state, so an
	// in-flight commit's reserved generation shows up here with no edge and is
	// rejected. Persistent D1 or R2 failure refuses retryably.
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
							compression: d1Schema.blobState.compression
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
					compression: state.compression
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
				backed.map((candidate) => candidate.narHash)
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
						compression: d1Schema.blobState.compression
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
					compression: state.compression
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
				backed.map((candidate) => candidate.narHash)
			)
		);

		return {
			candidates: backed.filter((candidate) =>
				presentHashes.has(candidate.narHash)
			),
			blobs
		};
	}

	// Gate 2: the answer is only served if the definition revision and every
	// verified candidate identity are exactly as gate 1 read them, so a
	// concurrent view change, recommit, or deletion fails towards a miss
	// rather than admitting a stale generation. Candidates the off-gate phase
	// already discarded contribute nothing to the answer, so churn on those
	// rows is not rechecked: a reclaimed reservation must not fail the lookup
	// into Nix's negative narinfo cache. The conflict computation is decided
	// against the gate-1 snapshot: a copy whose first commit lands after that
	// snapshot affects the next lookup (answers are no-store), exactly as a
	// commit landing just after the response would. The revision sequence
	// survives view deletion, so a deleted-and-recreated view can never
	// present the revision this lookup captured.
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

	// Group by the semantic fields signed into or carried by the narinfo;
	// signature sets may differ across key rotation without making two copies
	// conflict, and Nix signatures cover the common fingerprint (whose
	// references are a sorted set), so grouping compares sorted references.
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

		// The virtual narinfo is served beneath `/reuse/<view>/`, two segments
		// deep, and points back at the tenant's one canonical NAR route.
		return new NarInfo(
			new StorePath(row.storePath),
			`../../${narObjectKey(row.narHash)}`,
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

	// Wraps the authoritative shared-fact reads behind the serve: a fault that
	// survives the bounded retry refuses retryably rather than answering,
	// since a miss here would send the reader off to rebuild a path that
	// exists.
	private async sharedFacts<T>(read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	/**
	 * Resolves one store-path hash through a view: the rendered virtual
	 * narinfo on a verified single-candidate answer, or `undefined` for every
	 * kind of miss (unknown view, no candidates, over the candidate limit,
	 * conflicting candidates, or a concurrent mutation detected by the second
	 * gate entry). Persistent D1 or R2 failure throws retryably instead of
	 * answering: a miss would read as the path not existing.
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
	 * Finds the requested hashes which a reuse view cannot serve.
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
