import { type Logger } from '@cupboard/logger';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type CacheAccessMode,
	type CacheScope,
	type NarInfoGeneration,
	type NixSha256HashString,
	storedReferencesSchema,
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
	type SQL,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { cacheSelectorsCondition, type ResolvedCache } from '../db/cache.ts';
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

import { batchNonEmpty, presentNarObjects } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type JsonRowList, jsonRowLists, jsonValueLists } from './json-list.ts';
import {
	legacyReuseViewKeys,
	reuseViewSelectorsFromRows
} from './reuse-view-selectors.ts';
import { storedSignaturesSchema } from './signing-keys.ts';

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

/**
 * One candidate version, as the edge lookup compares it.
 *
 * SQL compares a row list column by column, and a comparison against NULL
 * never holds, so the default cache's absent name travels as an empty string
 * and the statement reads the column through `coalesce`. A cache name has at
 * least one character, so no named cache collides with that.
 */
interface CandidateVersion {
	readonly cacheKind: CacheScope['kind'];
	readonly cacheName: string;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
}

function listedCacheName(scope: CacheScope): string {
	return scope.kind === 'named' ? scope.name : '';
}

function candidateKey(
	candidate: Pick<CandidateRow, 'cacheId' | 'storePathHash'>
): string {
	return JSON.stringify([candidate.cacheId, candidate.storePathHash]);
}

// The identity of one committed version, as an edge row and a candidate row
// each describe it. A default cache has no stored name, and the key uses an
// empty string for it so both sides agree.
function versionKey(version: {
	readonly cacheKind: CacheScope['kind'] | null;
	readonly cacheName: string | null;
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}): string {
	return JSON.stringify([
		version.cacheKind,
		version.cacheName ?? '',
		version.storePathHash,
		version.generation,
		version.narHash
	]);
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
	access: CacheAccessMode,
	versions: JsonRowList<CandidateVersion>
) {
	return database
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
				eq(d1Schema.blobReference.tenant, tenant),
				versions.matches({
					cacheKind: d1Schema.blobReference.cacheKind,
					cacheName: sql`coalesce(${d1Schema.blobReference.cacheName}, '')`,
					storePathHash: d1Schema.blobReference.storePathHash,
					generation: d1Schema.blobReference.generation
				}),
				eq(d1Schema.cacheLifecycle.access, access),
				authorisedByCacheGeneration()
			)
		);
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
	constructor(private readonly context: ServerContext) {}

	/**
	 * The cache a candidate belongs to.
	 *
	 * `narinfo.cache_id` stays nullable until the expansion completes. A
	 * candidate reached this service through a join on `cache_identity`, so a
	 * null here means the row refers to no cache and the repository refuses it.
	 */
	private candidateCache(
		candidate: Pick<CandidateRow, 'cacheId'>
	): ResolvedCache {
		return this.context.cacheRepository.resolvedForId(candidate.cacheId);
	}

	private candidateVersionKey(candidate: CandidateRow): string {
		const scope = this.context.cacheRepository.scopeForId(candidate.cacheId);

		return versionKey({
			cacheKind: scope.kind,
			cacheName: listedCacheName(scope),
			storePathHash: candidate.storePathHash,
			generation: candidate.generation,
			narHash: candidate.narHash
		});
	}

	// Bind only the key columns: a candidate row also holds the narinfo's
	// references and signatures, which the list would otherwise carry.
	private candidateVersions(
		candidates: readonly CandidateRow[]
	): CandidateVersion[] {
		return candidates.map((candidate) => {
			const scope = this.context.cacheRepository.scopeForId(candidate.cacheId);

			return {
				cacheKind: scope.kind,
				cacheName: listedCacheName(scope),
				storePathHash: candidate.storePathHash,
				generation: candidate.generation
			};
		});
	}

	/**
	 * The rows of every cache a view selects that hold the paths `hashFilter`
	 * names.
	 *
	 * The selectors travel as one bound list, so a view of any width reads its
	 * candidates in one statement, and the primary key gives at most one row per
	 * cache and path.
	 */
	private candidateRows(
		selectors: readonly ReuseViewSelector[],
		access: CacheAccessMode,
		hashFilter: SQL
	): CandidateRow[] {
		return this.context.db
			.select(getTableColumns(schema.narInfos))
			.from(schema.narInfos)
			.innerJoin(
				schema.cacheIdentities,
				eq(schema.cacheIdentities.id, schema.narInfos.cacheId)
			)
			.where(
				and(
					hashFilter,
					eq(schema.cacheIdentities.access, access),
					isNull(schema.cacheIdentities.deletedAt),
					cacheSelectorsCondition(
						schema.cacheIdentities.kind,
						schema.cacheIdentities.name,
						selectors
					)
				)
			)
			.orderBy(schema.narInfos.storePathHash, schema.narInfos.cacheId)
			.all();
	}

	/**
	 * Matches the narinfo row a candidate came from.
	 *
	 * `narinfo.cache_id` stays nullable until the expansion completes, and a
	 * candidate reached this service through a join on `cache_identity`, so its
	 * id is set. The comparison is written in SQL because a null id must match no
	 * row, which is what a comparison against NULL already gives.
	 */
	private candidateRowFilter(candidate: CandidateRow): SQL | undefined {
		return and(
			sql`${schema.narInfos.cacheId} = ${candidate.cacheId}`,
			eq(schema.narInfos.storePathHash, candidate.storePathHash)
		);
	}

	private viewSelectors(
		view: ReuseViewName,
		keys: readonly string[]
	): ReuseViewSelector[] {
		return reuseViewSelectorsFromRows(
			view,
			this.context.db
				.select({
					kind: schema.nativeReuseViewSelectors.kind,
					cacheName: schema.nativeReuseViewSelectors.cacheName,
					prefix: schema.nativeReuseViewSelectors.prefix
				})
				.from(schema.nativeReuseViewSelectors)
				.where(inArray(schema.nativeReuseViewSelectors.view, keys))
				.all()
		);
	}

	// Read the view revision and candidates in one input-gate snapshot.
	private snapshotCandidates(
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHash: StorePathHash
	): GateSnapshot | undefined {
		const keys = legacyReuseViewKeys(view);
		const viewRow = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision
			})
			.from(schema.reuseViews)
			.where(inArray(schema.reuseViews.name, keys))
			.get();

		if (viewRow?.access !== access) {
			return undefined;
		}

		const selectors = this.viewSelectors(view, keys);
		const candidates = this.candidateRows(
			selectors,
			viewRow.access,
			eq(schema.narInfos.storePathHash, storePathHash)
		);

		return {
			tenant: this.context.requireTenant(),
			revision: viewRow.revision,
			access: viewRow.access,
			candidates
		};
	}

	private snapshotCandidateBatch(
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHashes: readonly StorePathHash[]
	): GateBatchSnapshot | undefined {
		const keys = legacyReuseViewKeys(view);
		const viewRow = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision
			})
			.from(schema.reuseViews)
			.where(inArray(schema.reuseViews.name, keys))
			.get();

		if (viewRow?.access !== access) {
			return undefined;
		}

		// The guard above narrows the stored access, and a property's narrowing
		// does not reach inside the callback below, so read it into a local first.
		const viewAccess = viewRow.access;
		const selectors = this.viewSelectors(view, keys);
		const candidates = jsonValueLists(storePathHashes).flatMap((hashes) =>
			this.candidateRows(
				selectors,
				viewAccess,
				inArray(schema.narInfos.storePathHash, hashes)
			)
		);

		return {
			tenant: this.context.requireTenant(),
			revision: viewRow.revision,
			access: viewAccess,
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
		const edgeQueries = jsonRowLists(this.candidateVersions(candidates)).map(
			(versions) =>
				reuseEdgeSelect(this.context.d1, tenant, snapshot.access, versions)
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
			edgeResults.flat().map((edge) => versionKey(edge))
		);
		const committedCaches = new Set(
			candidates
				.filter((candidate) =>
					committedVersions.has(this.candidateVersionKey(candidate))
				)
				.map((candidate) => candidate.cacheId)
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
		const edgeQueries = jsonRowLists(this.candidateVersions(candidates)).map(
			(versions) => reuseEdgeSelect(this.context.d1, tenant, access, versions)
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
			edgePages.flat().map((edge) => versionKey(edge))
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
				committedCandidates.has(this.candidateVersionKey(candidate)) &&
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
			.where(inArray(schema.reuseViews.name, legacyReuseViewKeys(view)))
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
					access: schema.cacheIdentities.access,
					deletedAt: schema.cacheIdentities.deletedAt,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.innerJoin(
					schema.cacheIdentities,
					eq(schema.cacheIdentities.id, schema.narInfos.cacheId)
				)
				.where(this.candidateRowFilter(candidate))
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
			.where(inArray(schema.reuseViews.name, legacyReuseViewKeys(view)))
			.get();

		if (
			viewRow?.revision !== snapshot.revision ||
			viewRow.access !== snapshot.access
		) {
			return undefined;
		}

		const candidatePaths = verified.candidates.map((candidate) => ({
			cache: candidate.cache,
			storePathHash: candidate.storePathHash
		}));
		const currentRows = jsonRowLists(candidatePaths).flatMap((candidateBatch) =>
			this.context.db
				.select({
					access: schema.cacheIdentities.access,
					cacheId: schema.narInfos.cacheId,
					deletedAt: schema.cacheIdentities.deletedAt,
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.innerJoin(
					schema.cacheIdentities,
					eq(schema.cacheIdentities.id, schema.narInfos.cacheId)
				)
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
		const ordered = settled.candidates
			.map((candidate) => ({
				candidate,
				cacheId: this.candidateCache(candidate).id
			}))
			.toSorted((left, right) => left.cacheId - right.cacheId)
			.map((entry) => entry.candidate);
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
		view: ReuseViewName,
		access: CacheAccessMode,
		storePathHash: StorePathHash
	): Promise<NarInfo | undefined> {
		const snapshot = await this.context.criticalSection(() =>
			Promise.resolve(this.snapshotCandidates(view, access, storePathHash))
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
			Promise.resolve(this.snapshotCandidateBatch(view, access, uniqueHashes))
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
