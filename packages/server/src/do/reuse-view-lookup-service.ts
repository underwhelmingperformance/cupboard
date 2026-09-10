import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheFromSelector,
	cacheNameSchema,
	type NarInfoGeneration,
	type NixSha256HashString,
	PRIVATE_STORED_PREFIX,
	privateStoredCache,
	publicCacheSelectorSchema,
	type StoredCache,
	storedReferencesSchema,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { byCodeUnit, StorePath } from '@cupboard/nix-store/store-path';
import {
	isPrivateReuseView,
	type ReuseViewRevision,
	type StoredReuseView
} from '@cupboard/protocol/reuse-views';
import { and, eq, gte, inArray, lt, or, type SQL, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { outsidePrivateCaches } from '../db/cache-range.ts';
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

import { batchNonEmpty, presentNarObjects } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type JsonRowList, jsonRowLists, jsonValueLists } from './json-list.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

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

// Bind only the key columns: a candidate row also holds the narinfo's references
// and signatures, which the list would otherwise carry.
function candidateVersions(
	candidates: readonly CandidateRow[]
): CandidateVersion[] {
	return candidates.map((candidate) => ({
		cache: candidate.cache,
		storePathHash: candidate.storePathHash,
		generation: candidate.generation
	}));
}

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

// A public view's prefix selectors match public caches only, so every prefix
// query excludes the private stored-name range.
function outsidePrivateRange(): SQL | undefined {
	return outsidePrivateCaches(schema.narInfos.cache);
}

// Every private stored name begins with the private prefix, so append the
// selector pattern to that prefix to form the range bounds. An empty pattern
// selects the complete private range.
function insidePrivatePrefix(pattern: string): SQL | undefined {
	const start = `${PRIVATE_STORED_PREFIX}${pattern}`;

	return and(
		gte(schema.narInfos.cache, sql`${start}`),
		lt(schema.narInfos.cache, sql`${prefixUpperBound(start)}`)
	);
}

// The condition for every cache in the view's namespace.
function allCachesCondition(view: StoredReuseView): SQL | undefined {
	return isPrivateReuseView(view)
		? insidePrivatePrefix('')
		: outsidePrivateRange();
}

// The cache an exact selector names, resolved inside the view's namespace.
function exactSelectorCache(
	view: StoredReuseView,
	pattern: string
): StoredCache {
	if (isPrivateReuseView(view)) {
		return privateStoredCache(cacheNameSchema.parse(pattern));
	}

	return cacheFromSelector(publicCacheSelectorSchema.parse(pattern));
}

/**
The half-open range of stored cache names one prefix selector matches.
*/
interface CacheRange {
	readonly lower: string;
	readonly upper: string;
}

/**
 * The range a non-empty prefix selector covers. A private view resolves the
 * pattern inside the private prefix; a public view compares it with the stored
 * names directly, and the caller excludes the private range separately.
 */
function selectorRange(
	view: StoredReuseView,
	pattern: string
): CacheRange | undefined {
	if (pattern === '') {
		return undefined;
	}

	const lower = isPrivateReuseView(view)
		? `${PRIVATE_STORED_PREFIX}${pattern}`
		: pattern;

	return { lower, upper: prefixUpperBound(lower) };
}

/**
 * Matches a cache against every range in one list, which binds the ranges as
 * one parameter however many selectors a view holds.
 */
function withinSelectorRanges(ranges: JsonRowList<CacheRange>): SQL {
	return ranges.anyRow(
		sql`${schema.narInfos.cache} >= ${ranges.column('lower')} and ${schema.narInfos.cache} < ${ranges.column('upper')}`
	);
}

/**
 * One candidate version, as the edge lookup compares it.
 */
interface CandidateVersion {
	readonly cache: StoredCache;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
}

/**
 * Builds the query for the committed reference edges of one list of candidate
 * versions. The versions travel as a row list, so the query binds the same
 * parameters however many caches hold the path.
 *
 * The parameter test imports this builder and inspects the statement it makes.
 */
export function reuseEdgeSelect(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	versions: JsonRowList<CandidateVersion>
) {
	return database
		.select({
			cache: d1Schema.blobReference.cache,
			storePathHash: d1Schema.blobReference.storePathHash,
			generation: d1Schema.blobReference.generation,
			narHash: d1Schema.blobReference.narHash
		})
		.from(d1Schema.blobReference)
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				versions.matches({
					cache: d1Schema.blobReference.cache,
					storePathHash: d1Schema.blobReference.storePathHash,
					generation: d1Schema.blobReference.generation
				})
			)
		);
}

/**
 * The condition that matches every cache a view selects.
 *
 * A view holds its selectors as exact cache names and as prefix ranges, and each
 * set travels as one bound list, so the condition binds the same parameters
 * however many selectors the view holds.
 */
function viewCacheFilter(
	view: StoredReuseView,
	selectors: readonly {
		readonly kind: 'exact' | 'prefix';
		readonly pattern: string;
	}[]
): SQL | undefined {
	// An empty prefix matches every cache of the view's namespace, so its
	// condition alone covers the other selectors.
	if (
		selectors.some(
			(selector) => selector.kind === 'prefix' && selector.pattern === ''
		)
	) {
		return allCachesCondition(view);
	}

	const exactCaches = selectors.flatMap((selector) =>
		selector.kind === 'exact'
			? [exactSelectorCache(view, selector.pattern)]
			: []
	);
	const prefixRanges = selectors.flatMap((selector) => {
		const range =
			selector.kind === 'prefix'
				? selectorRange(view, selector.pattern)
				: undefined;

		return range === undefined ? [] : [range];
	});
	const selectorConditions = [
		...jsonValueLists(exactCaches).map((caches) =>
			inArray(schema.narInfos.cache, caches)
		),
		...jsonRowLists(prefixRanges).map((ranges) => withinSelectorRanges(ranges))
	];
	// A public view's selectors match public caches only, so the namespace applies
	// to the whole selector set rather than to each selector.
	const namespaceFilter = isPrivateReuseView(view)
		? undefined
		: outsidePrivateRange();

	return and(or(...selectorConditions), namespaceFilter);
}

/**
 * The NAR URL a view's narinfo advertises, relative to the base URL the reader
 * addressed the view with.
 *
 * A private view serves its NARs under its own mount so the read remains behind
 * the tenant-credential guard and is authorised over the private cache range. A
 * route outside the view would enter the public namespace, which does not serve
 * a NAR referenced only by private caches.
 *
 * A public view uses the tenant's public NAR route, two segments above the
 * view. A public view can select only the tenant's public caches, and that route
 * serves any NAR those caches reference.
 */
function narUrlForView(
	view: StoredReuseView,
	narHash: NixSha256HashString,
	incarnation: number
): string {
	const key = narObjectKey(narHash, incarnation);

	return isPrivateReuseView(view) ? key : `../../${key}`;
}

/**
 * Resolves narinfos through a reuse view. Unlike ordinary narinfo reads, this
 * path enters the Durable Object so it can fence the view revision and local
 * candidate generations. Shared D1 and R2 reads run outside the input gate,
 * followed by a synchronous revalidation under the gate.
 */
export class ReuseViewLookupService {
	constructor(private readonly context: ServerContext) {}

	// Read the view revision and candidates in one input-gate snapshot. The
	// selectors travel as bound lists, so one query returns every copy of the
	// path the view selects, and the primary key gives at most one row per cache.
	private snapshotCandidates(
		view: StoredReuseView,
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
		const candidates = this.context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.storePathHash, storePathHash),
					viewCacheFilter(view, selectors)
				)
			)
			.orderBy(schema.narInfos.cache)
			.all();

		return {
			tenant: this.context.requireTenant(),
			revision: viewRow.revision,
			candidates
		};
	}

	private snapshotCandidateBatch(
		view: StoredReuseView,
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
		const cacheFilter = viewCacheFilter(view, selectors);
		const candidates = jsonValueLists(storePathHashes).flatMap((hashes) =>
			this.context.db
				.select()
				.from(schema.narInfos)
				.where(and(inArray(schema.narInfos.storePathHash, hashes), cacheFilter))
				.orderBy(schema.narInfos.storePathHash, schema.narInfos.cache)
				.all()
		);

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

		const uniqueHashes = [
			...new Set(candidates.map((candidate) => candidate.narHash))
		];
		// The whole candidate set travels as one row list, so the statement count
		// comes from the statement and a path held by many caches costs the
		// invocation no more than a path held by one.
		const edgeQueries = jsonRowLists(candidateVersions(candidates)).map(
			(versions) => reuseEdgeSelect(this.context.d1, tenant, versions)
		);
		const [edgeResults, states, owned] = await this.sharedFacts(() =>
			Promise.all([
				readWithOneRetry(() => batchNonEmpty(this.context.d1, edgeQueries)),
				readWithOneRetry(() =>
					batchNonEmpty(
						this.context.d1,
						jsonValueLists(uniqueHashes).map((narHashes) =>
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
						)
					)
				),
				readWithOneRetry(() =>
					batchNonEmpty(
						this.context.d1,
						jsonValueLists(uniqueHashes).map((narHashes) =>
							this.context.d1
								.select({ narHash: d1Schema.tenantBlob.narHash })
								.from(d1Schema.tenantBlob)
								.where(
									and(
										eq(d1Schema.tenantBlob.tenant, tenant),
										inArray(d1Schema.tenantBlob.narHash, narHashes)
									)
								)
						)
					)
				)
			])
		);

		// The query returns one row for each committed edge in no guaranteed order,
		// so match candidates on the full version key. The rows do not line up with
		// the candidate list by position.
		const committedVersions = new Set(
			edgeResults.flat().map((edge) => candidateVersionKey(edge))
		);
		const committedCaches = new Set(
			candidates
				.filter((candidate) =>
					committedVersions.has(candidateVersionKey(candidate))
				)
				.map((candidate) => candidate.cache)
		);
		const blobs = new Map(
			states.flat().map((state) => [
				state.narHash,
				{
					fileHash: state.fileHash,
					fileSize: state.fileSize,
					compression: state.compression,
					incarnation: state.incarnation
				}
			])
		);
		const ownedHashes = new Set(owned.flat().map((row) => row.narHash));
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
		const edgeQueries = jsonRowLists(candidateVersions(candidates)).map(
			(versions) => reuseEdgeSelect(this.context.d1, tenant, versions)
		);
		const stateQueries = jsonValueLists(uniqueHashes).map((narHashes) =>
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
		const ownershipQueries = jsonValueLists(uniqueHashes).map((narHashes) =>
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
		view: StoredReuseView,
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
		view: StoredReuseView,
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

		const candidatePaths = verified.candidates.map((candidate) => ({
			cache: candidate.cache,
			storePathHash: candidate.storePathHash
		}));
		const currentRows = jsonRowLists(candidatePaths).flatMap((candidateBatch) =>
			this.context.db
				.select({
					cache: schema.narInfos.cache,
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.where(
					candidateBatch.matches({
						cache: schema.narInfos.cache,
						storePathHash: schema.narInfos.storePathHash
					})
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
		view: StoredReuseView,
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
							storedReferencesSchema,
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
		view: StoredReuseView,
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

		return new NarInfo(
			new StorePath(row.storePath),
			narUrlForView(view, row.narHash, blob.incarnation),
			blob.compression,
			NixSha256Hash.parse(blob.fileHash),
			blob.fileSize,
			NixSha256Hash.parse(row.narHash),
			row.narSize,
			parseStored(storedReferencesSchema, row.referencesJson, referencesFault),
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
		view: StoredReuseView,
		storePathHash: StorePathHash
	): Promise<NarInfo | undefined> {
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(this.snapshotCandidates(view, storePathHash))
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
		view: StoredReuseView,
		storePathHashes: readonly StorePathHash[]
	): Promise<StorePathHash[]> {
		const uniqueHashes = [...new Set(storePathHashes)];
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(this.snapshotCandidateBatch(view, uniqueHashes))
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
