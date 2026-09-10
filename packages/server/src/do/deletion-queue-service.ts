import {
	type CacheReadRevision,
	type CacheScope,
	isSameCacheScope,
	type NarInfoGeneration,
	type NixSha256HashString,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type DeletePathResponseInput } from '@cupboard/protocol/upload';
import { and, eq, exists, inArray, notExists, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type CacheId,
	cacheIdentityColumns,
	cacheIdentityCondition,
	cacheScopeFromRow,
	legacyCacheKey,
	type ResolvedCache
} from '../db/cache.ts';
import {
	authorisedByCacheGeneration,
	type CacheLifecycleVersion,
	firstCacheGeneration,
	firstCacheReadRevision,
	referencedCacheLifecycle,
	revokedByCacheGeneration,
	secondCacheGeneration,
	secondCacheReadRevision
} from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { d1StatementsPerInvocation, type RequestOrigin } from '../http/http.ts';

import {
	type AttestationCasService,
	type AttestationReference
} from './attestation-cas-service.ts';
import { type AttestationsService } from './attestations-service.ts';
import { chunk, drainStatementBatches } from './bulk.ts';
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import {
	type JsonRowList,
	jsonRowLists,
	type JsonValueList,
	jsonValueLists
} from './json-list.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';
import {
	affordableOperations,
	statementsRemaining
} from './statement-scope.ts';

export interface TornDownNarInfo {
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

// The paths one retirement chunk covers. A chunk costs the same number of D1
// statements whatever its size, so this is a step size: a larger chunk retires
// more paths for those statements and holds the critical section for longer.
export const maxFencedRetireRows = 45;

// Limit each flush to a few retirement batches. An alarm continues any backlog
// without keeping the critical section open for the entire queue.
const teardownChunksPerFlush = 4;
export const maxNarInfoDeletionsFlushedPerRun =
	teardownChunksPerFlush * maxFencedRetireRows;

// One query finds the attestation references of every path in a chunk.
const attestationQueryStatementsPerChunk = 1;

// Retiring one attestation reference runs a three-statement batch: the edge
// delete and the two reads that decide whether the tenant still holds the
// digest. The tenant's last reference to a digest runs a further two-statement
// batch for the quota credit and the presence delete. The drain cannot tell the
// two apart until the delete has run, so it reserves the larger cost before
// each reference.
const attestationRetirementStatements = 5;

// After retiring all attestation references, the chunk credits usage, deletes
// edges, updates presence accounting and queues exact-cache purges. A chunk
// contains at most `maxFencedRetireRows` paths, so all of its distinct NAR
// hashes fit in one presence batch.
const narInfoRetirementStatementsPerChunk = 5;

// The fixed D1 statement cost of retiring one teardown chunk.
export const minimumStatementsPerTeardownChunk =
	attestationQueryStatementsPerChunk + narInfoRetirementStatementsPerChunk;

// The fixed D1 statement cost of retiring one path. This includes the edge
// credit and delete, two presence reads, the presence credit and delete, the
// attestation-reference query, the unreferenced-hash probe and the two
// maintenance-eligibility statements around the request.
const statementsPerSinglePathRetirement = 10;

// The maximum number of attestation references that one invocation can retire
// after paying the fixed cost for the path.
const maxSinglePathAttestationRetirements = Math.floor(
	(d1StatementsPerInvocation - statementsPerSinglePathRetirement) /
		attestationRetirementStatements
);

/**
 * Builds the query for the attestation references filed against the exact
 * narinfo generations of one retirement chunk. The chunk travels as a row
 * list, so the query binds the same parameters however many paths it covers.
 *
 * The parameter test imports this builder and inspects the statement it makes.
 */
export function capturedReferenceSelect(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: CacheScope,
	batch: JsonRowList<TornDownNarInfo>,
	limit: number
) {
	return database
		.select({
			storePathHash: d1Schema.attestationReference.storePathHash,
			generation: d1Schema.attestationReference.generation,
			predicateType: d1Schema.attestationReference.predicateType,
			digest: d1Schema.attestationReference.digest
		})
		.from(d1Schema.attestationReference)
		.where(
			and(
				eq(d1Schema.attestationReference.tenant, tenant),
				cacheIdentityCondition(
					d1Schema.attestationReference.cacheKind,
					d1Schema.attestationReference.cacheName,
					cache
				),
				batch.matches({
					storePathHash: d1Schema.attestationReference.storePathHash,
					generation: d1Schema.attestationReference.generation
				})
			)
		)
		.limit(limit);
}

/**
 * Builds the query for the edges of one cache that still reference a retired
 * chunk's NAR hashes. The hashes travel as a list, so the query binds the same
 * parameters however many the chunk retired.
 *
 * The parameter test imports this builder and inspects the statement it makes.
 */
export function cacheReferenceSelect(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: CacheScope,
	narHashes: JsonValueList<NixSha256HashString>
) {
	return database
		.select({ narHash: d1Schema.blobReference.narHash })
		.from(d1Schema.blobReference)
		.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				cacheIdentityCondition(
					d1Schema.blobReference.cacheKind,
					d1Schema.blobReference.cacheName,
					cache
				),
				inArray(d1Schema.blobReference.narHash, narHashes),
				authorisedByCacheGeneration()
			)
		);
}

/**
 * Builds the usage-credit update and edge delete that retire one chunk of
 * narinfo edges. Both statements use the same edge filter, which the credit
 * update embeds in its `count(*)` subquery.
 *
 * The parameter test imports this builder so it inspects the production
 * statements instead of maintaining a separate filter.
 */
export function fencedEdgeRetirement(
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: CacheScope,
	batch: JsonRowList<TornDownNarInfo>,
	now: IsoTimestamp
) {
	const edgeFilter = and(
		eq(d1Schema.blobReference.tenant, tenant),
		cacheIdentityCondition(
			d1Schema.blobReference.cacheKind,
			d1Schema.blobReference.cacheName,
			cache
		),
		batch.matches({
			storePathHash: d1Schema.blobReference.storePathHash,
			generation: d1Schema.blobReference.generation
		})
	);
	const edgeCount = database
		.select({ count: sql<number>`count(*)` })
		.from(d1Schema.blobReference)
		.where(edgeFilter);

	return {
		creditUpdate: database
			.update(d1Schema.tenantUsage)
			.set({
				narinfos: sql`${d1Schema.tenantUsage.narinfos} - (${edgeCount})`,
				updatedAt: now
			})
			.where(eq(d1Schema.tenantUsage.tenant, tenant)),
		edgeDelete: database.delete(d1Schema.blobReference).where(edgeFilter)
	};
}

// The credit update and presence delete use the same filter in one transaction.
// Keep the update first so its subqueries measure the rows that the delete will
// remove. Exported for the D1 parameter-limit test.
export function teardownPresenceBatch(
	d1: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: JsonValueList<NixSha256HashString>,
	now: IsoTimestamp
) {
	const stillReferenced = d1
		.select({ narHash: d1Schema.blobReference.narHash })
		.from(d1Schema.blobReference)
		.where(
			and(
				eq(d1Schema.blobReference.tenant, tenant),
				eq(d1Schema.blobReference.narHash, d1Schema.tenantBlob.narHash)
			)
		);
	const droppableFilter = and(
		eq(d1Schema.tenantBlob.tenant, tenant),
		inArray(d1Schema.tenantBlob.narHash, narHashes),
		notExists(stillReferenced)
	);
	const droppedBytes = sql`coalesce((select sum(${d1Schema.tenantBlob.fileSize}) from ${d1Schema.tenantBlob} where ${droppableFilter}), 0)`;
	const droppedCount = sql`coalesce((select count(*) from ${d1Schema.tenantBlob} where ${droppableFilter}), 0)`;

	return {
		update: d1
			.update(d1Schema.tenantUsage)
			.set({
				bytes: sql`${d1Schema.tenantUsage.bytes} - ${droppedBytes}`,
				blobs: sql`${d1Schema.tenantUsage.blobs} - ${droppedCount}`,
				updatedAt: now
			})
			.where(eq(d1Schema.tenantUsage.tenant, tenant)),
		presenceDelete: d1.delete(d1Schema.tenantBlob).where(droppableFilter)
	};
}

export class DeletionQueueService {
	constructor(
		private readonly context: ServerContext,
		private readonly attestationCas: AttestationCasService,
		private readonly attestations: AttestationsService,
		private readonly narInfoObjects: NarInfoObjectsService,
		private readonly cachePurges: CachePurgeQueueService = new CachePurgeQueueService(
			context
		)
	) {}

	private async retireBlobRefEdge(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		narHash: NixSha256HashString
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		// Credit only while the captured edge still exists, then delete that exact
		// generation in the same transaction. A replay cannot credit it twice or
		// remove a newer edge.
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			cacheIdentityCondition(
				d1Schema.blobReference.cacheKind,
				d1Schema.blobReference.cacheName,
				cache.scope
			),
			eq(d1Schema.blobReference.storePathHash, storePathHash),
			eq(d1Schema.blobReference.generation, generation)
		);
		const edgeExists = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.blobReference)
				.where(edgeFilter)
		);
		const creditNarInfoFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			edgeExists
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					narinfos: sql`${d1Schema.tenantUsage.narinfos} - 1`,
					updatedAt: now
				})
				.where(creditNarInfoFilter),
			this.context.d1.delete(d1Schema.blobReference).where(edgeFilter)
		]);

		const hashReferencedFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			eq(d1Schema.blobReference.narHash, narHash)
		);
		const presenceFilter = and(
			eq(d1Schema.tenantBlob.tenant, tenant),
			eq(d1Schema.tenantBlob.narHash, narHash)
		);
		const authorisedReferenceFilter = and(
			hashReferencedFilter,
			authorisedByCacheGeneration()
		);

		const [stillReferencedRows, presenceRows] = await this.context.d1.batch([
			this.context.d1
				.select({
					kind: d1Schema.blobReference.cacheKind,
					name: d1Schema.blobReference.cacheName
				})
				.from(d1Schema.blobReference)
				.innerJoin(d1Schema.cacheLifecycle, referencedCacheLifecycle())
				.where(authorisedReferenceFilter),
			this.context.d1
				.select({ fileSize: d1Schema.tenantBlob.fileSize })
				.from(d1Schema.tenantBlob)
				.where(presenceFilter)
		]);
		const hasExactReference = stillReferencedRows.some((row) =>
			isSameCacheScope(
				cacheScopeFromRow({ kind: row.kind, name: row.name }),
				cache.scope
			)
		);

		if (!hasExactReference && cache.access === 'public') {
			await this.cachePurges.enqueueNars(cache, [narHash]);
		}

		if (stillReferencedRows[0] !== undefined) {
			return;
		}

		// Credit the blob only while its presence row still exists, and remove that
		// row in the same transaction. A replay cannot credit the last edge twice.
		const presence = presenceRows[0];

		if (presence === undefined) {
			return;
		}

		const presenceExists = exists(
			this.context.d1
				.select({ one: sql`1` })
				.from(d1Schema.tenantBlob)
				.where(presenceFilter)
		);
		const creditBytesFilter = and(
			eq(d1Schema.tenantUsage.tenant, tenant),
			presenceExists
		);

		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.tenantUsage)
				.set({
					bytes: sql`${d1Schema.tenantUsage.bytes} - ${presence.fileSize}`,
					blobs: sql`${d1Schema.tenantUsage.blobs} - 1`,
					updatedAt: now
				})
				.where(creditBytesFilter),
			this.context.d1.delete(d1Schema.tenantBlob).where(presenceFilter)
		]);
	}

	// Queues a cache-tag purge for each hash this public cache no longer
	// references.
	private async purgeRetiredNars(
		cache: ResolvedCache,
		narHashes: readonly NixSha256HashString[]
	): Promise<void> {
		if (cache.access === 'private' || narHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const stillReferenced = new Set<NixSha256HashString>();

		for (const list of jsonValueLists(narHashes)) {
			const rows = await cacheReferenceSelect(
				this.context.d1,
				tenant,
				cache.scope,
				list
			).all();

			for (const row of rows) {
				stillReferenced.add(row.narHash);
			}
		}

		await this.cachePurges.enqueueNars(
			cache,
			narHashes.filter((narHash) => !stillReferenced.has(narHash))
		);
	}

	// Reports whether any tenant still has a committed reference to the hash. The
	// global reaper owns removal of the NAR object.
	private async blobHashUnreferenced(
		narHash: NixSha256HashString
	): Promise<boolean> {
		const referenced = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(eq(d1Schema.blobReference.narHash, narHash))
			.get();

		return referenced === undefined;
	}

	private clearQueuedNarInfoDeletion(
		cacheId: CacheId,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): void {
		this.context.db
			.delete(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cacheId, cacheId),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.run();
	}

	/**
	 * Retires as many of one narinfo generation's attestation references as the
	 * available D1 statements permit, and reports whether it retired them all.
	 *
	 * A path may have any number of references, so one invocation might not
	 * retire them all. When this returns false the caller keeps the queue entry,
	 * and garbage collection retires the remainder.
	 *
	 * The remaining D1 allowance and `maxSinglePathAttestationRetirements`
	 * jointly limit the page.
	 */
	private async retireAttestationRefs(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): Promise<boolean> {
		const affordable = Math.min(
			maxSinglePathAttestationRetirements,
			affordableOperations(attestationRetirementStatements)
		);
		const tenant = this.context.requireTenant();
		const references = await this.context.d1
			.select({
				storePathHash: d1Schema.attestationReference.storePathHash,
				generation: d1Schema.attestationReference.generation,
				predicateType: d1Schema.attestationReference.predicateType,
				digest: d1Schema.attestationReference.digest
			})
			.from(d1Schema.attestationReference)
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
			// One reference more than this invocation may retire, so a surplus row
			// reports the path unfinished.
			.limit(affordable + 1)
			.all();
		const retiring = references.slice(0, affordable);

		for (const reference of retiring) {
			await this.attestationCas.removeCapturedReference({
				...reference,
				cache: cache.scope
			});
		}

		return references.length <= affordable;
	}

	/**
	 * Retires one chunk of queued narinfo deletions. Returns the number of
	 * published narinfo objects removed, or `undefined` when the remaining D1
	 * allowance is too small for the complete chunk.
	 *
	 * Attestation references go first because their unbounded count determines
	 * whether the chunk can finish. The drain keeps back the fixed
	 * narinfo-retirement cost and retires only the references the rest of the
	 * allowance covers. A surplus reference stops the chunk before it retires the
	 * reference edges or clears the queue entries.
	 *
	 * The bundle route requires both an attestation reference and its matching
	 * generation-authorised reference edge. Removing references before the rest
	 * of the chunk therefore reduces access immediately, even if the pass is
	 * interrupted.
	 */
	private async retireTornDownChunk(
		cache: ResolvedCache,
		tenant: TenantId,
		batch: readonly TornDownNarInfo[],
		now: IsoTimestamp
	): Promise<number | undefined> {
		// Start a chunk only when the remaining allowance covers its attestation
		// query and fixed narinfo-retirement work.
		if (statementsRemaining() < minimumStatementsPerTeardownChunk) {
			return undefined;
		}

		// Reserve the fixed narinfo-retirement cost before selecting attestation
		// references. Read one additional reference to detect an unfinished chunk.
		const affordable = affordableOperations(
			attestationRetirementStatements,
			attestationQueryStatementsPerChunk + narInfoRetirementStatementsPerChunk
		);
		const references = await this.capturedAttestationReferences(
			tenant,
			cache,
			batch,
			affordable + 1
		);
		const retiring = references.slice(0, affordable);

		for (const reference of retiring) {
			await this.attestationCas.removeCapturedReference(reference);
		}

		if (references.length > affordable) {
			return undefined;
		}

		if (statementsRemaining() < narInfoRetirementStatementsPerChunk) {
			return undefined;
		}

		const storePathHashes = batch.map((entry) => entry.storePathHash);
		const liveRows = jsonValueLists(storePathHashes).flatMap((list) =>
			this.context.db
				.select({
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation
				})
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						inArray(schema.narInfos.storePathHash, list)
					)
				)
				.all()
		);
		const liveGenerations = new Map(
			liveRows.map((row) => [row.storePathHash, row.generation] as const)
		);
		const removable = batch.filter((entry) => {
			const live = liveGenerations.get(entry.storePathHash);

			return live === undefined || live === entry.generation;
		});
		const superseded = batch.filter((entry) => !removable.includes(entry));

		await this.narInfoObjects.deleteNarInfoObjects(
			cache,
			removable.map((entry) => entry.storePathHash)
		);

		await this.cachePurges.enqueueNarInfos(cache, storePathHashes);

		// Compute the credit from edges that still exist, then delete those exact
		// generations in the same transaction. Replays cannot double-credit.
		for (const entries of jsonRowLists(batch)) {
			const { creditUpdate, edgeDelete } = fencedEdgeRetirement(
				this.context.d1,
				tenant,
				cache.scope,
				entries,
				now
			);

			await this.context.d1.batch([creditUpdate, edgeDelete]);
		}

		// A shared hash retains its presence row until its final edge is retired.
		// The caller's critical section makes this Durable Object the sole writer
		// for the tenant's presence rows while the credit and delete run.
		//
		// Every hash in the claimed chunk fits in one presence batch. The statement
		// reserve above covers that batch.
		const retiredHashes = await drainStatementBatches(
			this.context.d1,
			[...new Set(batch.map((entry) => entry.narHash))],
			(hashes) =>
				jsonValueLists(hashes).flatMap((list) => {
					const { update, presenceDelete } = teardownPresenceBatch(
						this.context.d1,
						tenant,
						list,
						now
					);

					return [update, presenceDelete];
				})
		);

		await this.purgeRetiredNars(cache, retiredHashes);

		await this.discardRetiredLists(cache, removable, superseded);

		// Clear only the retired path and generation pairs. A later generation
		// keeps its queue entry, and clearing each completed chunk preserves
		// progress across a timeout.
		for (const entries of jsonRowLists(batch)) {
			this.context.db
				.delete(schema.narInfoDeletions)
				.where(
					and(
						eq(schema.narInfoDeletions.cacheId, cache.id),
						entries.matches({
							storePathHash: schema.narInfoDeletions.storePathHash,
							generation: schema.narInfoDeletions.generation
						})
					)
				)
				.run();
		}

		return removable.length;
	}

	// The attestation references filed against the exact narinfo generations this
	// chunk retires. Fetches at most one reference beyond the number the pass can
	// retire. The surplus row tells the caller to leave the chunk's queue entries
	// in place.
	private async capturedAttestationReferences(
		tenant: TenantId,
		cache: ResolvedCache,
		batch: readonly TornDownNarInfo[],
		limit: number
	): Promise<AttestationReference[]> {
		const references: AttestationReference[] = [];

		for (const entries of jsonRowLists(batch)) {
			const rows = await capturedReferenceSelect(
				this.context.d1,
				tenant,
				cache.scope,
				entries,
				limit - references.length
			).all();

			references.push(...rows.map((row) => ({ ...row, cache: cache.scope })));

			if (references.length >= limit) {
				break;
			}
		}

		return references;
	}

	/**
	 * Removes the attestation list objects left by a retired chunk.
	 *
	 * `removable` contains paths for which the retired generation was the latest
	 * commit. One bulk call removes their lists. `superseded` contains paths with
	 * a later committed generation. For those paths, the method removes a list
	 * only if it still records the retired generation.
	 *
	 * Neither step reads the reference rows, so a replay after a crash between
	 * reference removal and list removal still discards the stale object.
	 */
	private async discardRetiredLists(
		cache: ResolvedCache,
		removable: readonly TornDownNarInfo[],
		superseded: readonly TornDownNarInfo[]
	): Promise<void> {
		await this.attestations.discardLists(
			cache,
			removable.map((entry) => entry.storePathHash)
		);

		for (const entry of superseded) {
			await this.attestations.discardListOfGeneration(
				cache,
				entry.storePathHash,
				entry.generation
			);
		}
	}

	// Matches the tenant's lifecycle row for one cache by its identity columns.
	// The legacy key in the primary key encodes the access, so a cache that
	// changes access would otherwise gain a second row rather than update its
	// existing one.
	private cacheLifecycleFilter(tenant: TenantId, scope: CacheScope) {
		return and(
			eq(d1Schema.cacheLifecycle.tenant, tenant),
			cacheIdentityCondition(
				d1Schema.cacheLifecycle.cacheKind,
				d1Schema.cacheLifecycle.cacheName,
				scope
			)
		);
	}

	// Takes the resolved cache rather than its id: the queue row is keyed by the
	// legacy stored name, which needs the cache's access as well as its scope.
	enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: NarInfoGeneration,
		now: IsoTimestamp
	): void {
		this.enqueueNarInfoDeletions(
			handle,
			cache,
			[{ storePathHash, narHash, generation }],
			now
		);
	}

	/**
	 * Queues one page of narinfo versions for deletion in a single statement.
	 * A version already queued keeps its original timestamp and takes the newer
	 * NAR hash.
	 */
	enqueueNarInfoDeletions(
		handle: SchemaWriter,
		cache: ResolvedCache,
		entries: readonly TornDownNarInfo[],
		now: IsoTimestamp
	): void {
		const legacyCache = legacyCacheKey(cache.scope, cache.access);

		for (const rows of jsonRowLists(entries)) {
			handle
				.insert(schema.narInfoDeletions)
				.select(
					rows.insertSource([
						sql`${legacyCache}`,
						sql`${cache.id}`,
						rows.column('storePathHash'),
						rows.column('narHash'),
						rows.column('generation'),
						sql`${now}`
					])
				)
				.onConflictDoUpdate({
					target: [
						schema.narInfoDeletions.cache,
						schema.narInfoDeletions.storePathHash,
						schema.narInfoDeletions.generation
					],
					// Keep the original timestamp. The conflict target is the same
					// logical deletion queued again, and a row that is re-queued has
					// not been created again. Nothing reads this column today, so this
					// exists so that anything which later ages the queue by it gets the
					// age of the deletion rather than of the last re-queue.
					set: { narHash: sql`excluded.nar_hash` }
				})
				.run();
		}
	}

	// The caller must hold the critical section. The row cap and the invocation's
	// D1 allowance both bound one pass; an alarm resumes the remaining durable
	// queue entries.
	async flushQueuedNarInfoDeletions(
		origin?: RequestOrigin,
		limit: number = maxNarInfoDeletionsFlushedPerRun
	): Promise<number> {
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.orderBy(
				schema.narInfoDeletions.cacheId,
				schema.narInfoDeletions.storePathHash,
				schema.narInfoDeletions.generation
			)
			.limit(limit)
			.all();

		// A queue row whose `cache_id` the backfill has not supplied refers to no
		// cache. Grouping it under the null key defers the refusal to the resolve
		// below rather than repeating the check here.
		const byCache = new Map<CacheId | null, TornDownNarInfo[]>();

		for (const entry of queued) {
			const entries = byCache.get(entry.cacheId) ?? [];
			entries.push({
				storePathHash: entry.storePathHash,
				generation: entry.generation,
				narHash: entry.narHash
			});
			byCache.set(entry.cacheId, entries);
		}

		// Every cache in this flush draws on the same invocation allowance, so a
		// cache that exhausts it leaves the rest of the queue for the next pass.
		let deleted = 0;

		for (const [cacheId, entries] of byCache) {
			deleted += await this.retireTornDownNarInfos(
				this.context.cacheRepository.resolvedForId(cacheId),
				entries,
				origin
			);
		}

		return deleted;
	}

	// Select a real column because this driver returns undefined for a projected
	// SQL literal even when the query finds a row.
	hasQueuedNarInfoDeletions(): boolean {
		const row = this.context.db
			.select({ storePathHash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.limit(1)
			.get();

		return row !== undefined;
	}

	/**
	 * Retires the reference edge of one queued narinfo deletion and returns the
	 * queue entry it retired, or `undefined` when the queue holds no such entry.
	 *
	 * The reference edge authorises NAR reads through the cache. Retire it before
	 * deleting objects or updating accounting. A caller that reports a deletion
	 * to a client must propagate a failure here because the NAR remains readable.
	 *
	 * The caller must hold the critical section.
	 */
	async retireQueuedNarInfoEdge(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration
	): Promise<typeof schema.narInfoDeletions.$inferSelect | undefined> {
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cacheId, cache.id),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.get();

		if (queued === undefined) {
			return undefined;
		}

		await this.retireBlobRefEdge(
			cache,
			storePathHash,
			queued.generation,
			queued.narHash
		);

		return queued;
	}

	// The caller must hold the critical section because the row check, object
	// deletion, edge retirement, and queue clear span asynchronous operations.
	async deleteQueuedNarInfo(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		origin?: RequestOrigin
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		const queued = await this.retireQueuedNarInfoEdge(
			cache,
			storePathHash,
			generation
		);

		if (queued === undefined) {
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		return this.cleanUpQueuedNarInfo(
			cache,
			storePathHash,
			generation,
			queued,
			origin
		);
	}

	/**
	 * Removes the published object, cached copies, attestations and queue entry
	 * for a retired narinfo. The caller must have retired the reference edge and
	 * must hold the critical section.
	 *
	 * A path carrying more attestation references than one invocation may retire
	 * keeps its queue entry, so garbage collection retires the rest.
	 */
	async cleanUpQueuedNarInfo(
		cache: ResolvedCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		queued: typeof schema.narInfoDeletions.$inferSelect,
		_origin?: RequestOrigin
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		const current = this.context.db
			.select({ generation: schema.narInfos.generation })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
		const wasNewerCommitted =
			current !== undefined && current.generation !== queued.generation;

		// A newer generation keeps the path-keyed object and the attestation list
		// it owns. The captured generation's attestations still need to be retired.
		if (wasNewerCommitted) {
			await this.cachePurges.enqueueNarInfos(cache, [storePathHash]);

			const hasRetiredEveryReference = await this.retireAttestationRefs(
				cache,
				storePathHash,
				queued.generation
			);
			await this.attestations.discardListOfGeneration(
				cache,
				storePathHash,
				queued.generation
			);

			const isNarScheduledForDeletion = await this.blobHashUnreferenced(
				queued.narHash
			);

			if (hasRetiredEveryReference) {
				this.clearQueuedNarInfoDeletion(cache.id, storePathHash, generation);
			}

			return {
				objectDeleted: false,
				narScheduledForDeletion: isNarScheduledForDeletion
			};
		}

		await this.narInfoObjects.deleteNarInfoObject(cache, storePathHash);
		await this.cachePurges.enqueueNarInfos(cache, [storePathHash]);

		const hasRetiredEveryReference = await this.retireAttestationRefs(
			cache,
			storePathHash,
			queued.generation
		);
		// This is the latest generation for the path, so remove its list even if an
		// earlier attempt already removed the reference rows. This also removes the
		// stale object when replaying after an interruption.
		await this.attestations.discardLists(cache, [storePathHash]);

		// Re-check the live edges because another path may have committed the same
		// NAR after this row was removed. The global reaper owns NAR deletion.
		const isNarScheduledForDeletion = await this.blobHashUnreferenced(
			queued.narHash
		);

		if (hasRetiredEveryReference) {
			this.clearQueuedNarInfoDeletion(cache.id, storePathHash, generation);
		}

		return {
			objectDeleted: true,
			narScheduledForDeletion: isNarScheduledForDeletion
		};
	}

	/**
	 * Advances the lifecycle generation and records the cache as deleted in the
	 * same statement. This revokes a cache of any size before physical cleanup
	 * drains its edges. A cache with no lifecycle row yet takes one insert
	 * instead.
	 *
	 * A later cache with the same name uses the advanced generation. Its reads
	 * therefore exclude every edge left by the deleted cache.
	 *
	 * For a private cache, the deletion timestamp makes content reads return
	 * absent-object results and makes availability report every requested path as
	 * missing while path-keyed objects await teardown.
	 * {@link recordCacheRegistration} removes the timestamp when the cache name is
	 * registered again.
	 *
	 * The read revision advances with the generation. A public read the deleted
	 * cache answered can still be held in Workers Cache, and its key carries the
	 * revision, so the reader of the next cache of this name misses it.
	 */
	async revokeCacheGeneration(cache: ResolvedCache): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		const { scope, access } = cache;
		const revoked = await this.context.d1
			.update(d1Schema.cacheLifecycle)
			.set({
				cache: legacyCacheKey(scope, access),
				access,
				generation: sql`${d1Schema.cacheLifecycle.generation} + 1`,
				readRevision: sql`${d1Schema.cacheLifecycle.readRevision} + 1`,
				deletedAt: now,
				updatedAt: now
			})
			.where(this.cacheLifecycleFilter(tenant, scope))
			.run();

		if (revoked.meta.changes > 0) {
			return;
		}

		await this.context.d1.insert(d1Schema.cacheLifecycle).values({
			tenant,
			cache: legacyCacheKey(scope, access),
			...cacheIdentityColumns(scope),
			access,
			generation: secondCacheGeneration,
			readRevision: secondCacheReadRevision,
			deletedAt: now,
			updatedAt: now
		});
	}

	/**
	 * Records the lifecycle row for a cache the tenant has just registered,
	 * clearing the deletion timestamp when the name is registered again, and
	 * returns the version the row now publishes.
	 *
	 * The row says the cache exists and how it reads, which is what a request
	 * naming the cache consults. Writing it here rather than leaving it to the
	 * projection means a cache is known from its first write.
	 *
	 * The upsert also registers a cache that has never been deleted. D1 admission
	 * therefore has an authoritative access row for empty caches.
	 *
	 * The generation stays where a deletion left it, so the edges of the deleted
	 * cache remain revoked while the new cache commits its own. An insert starts
	 * at the first generation.
	 *
	 * The read revision advances only when the access recorded for the name
	 * differs from the access being registered. Advancing it on every
	 * registration would evict the cache's public responses on each commit.
	 */
	async recordCacheRegistration(
		cache: Pick<ResolvedCache, 'scope' | 'access'>
	): Promise<CacheLifecycleVersion> {
		const tenant = this.context.requireTenant();
		const { scope, access } = cache;
		const now = isoTimestamp(new Date());
		const version = {
			generation: d1Schema.cacheLifecycle.generation,
			readRevision: d1Schema.cacheLifecycle.readRevision
		};
		const updated = await this.context.d1
			.update(d1Schema.cacheLifecycle)
			.set({
				cache: legacyCacheKey(scope, access),
				access,
				readRevision: sql<CacheReadRevision>`case when ${d1Schema.cacheLifecycle.access} is ${access} then ${d1Schema.cacheLifecycle.readRevision} else ${d1Schema.cacheLifecycle.readRevision} + 1 end`,
				deletedAt: sql`null`,
				updatedAt: now
			})
			.where(this.cacheLifecycleFilter(tenant, scope))
			.returning(version)
			// `get` is typed as always returning a row, but an update that matched
			// nothing returns none. Read the first of `all` so the miss is visible.
			.all();
		const updatedVersion = updated.at(0);

		if (updatedVersion !== undefined) {
			return updatedVersion;
		}

		return this.context.d1
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant,
				cache: legacyCacheKey(scope, access),
				...cacheIdentityColumns(scope),
				access,
				generation: firstCacheGeneration,
				readRevision: firstCacheReadRevision,
				updatedAt: now
			})
			.returning(version)
			.get();
	}

	/**
	 * Queues one bounded page of reference edges from an earlier cache generation.
	 * The ordinary retirement drain removes the edges and credits their usage.
	 *
	 * A commit inserts its edge inside the same critical section that a cache
	 * deletion runs in, and it records its local narinfo before that insert, so
	 * the local transaction that queues every narinfo normally covers every
	 * committed edge. This sweep finds the revoked edges an interrupted earlier
	 * deletion left, which would otherwise hold usage against the tenant for
	 * good.
	 *
	 * The cache-generation predicate excludes the edges of the current cache of
	 * this name. Retirement then matches the exact narinfo generation, which is a
	 * separate number, so a queued deletion cannot remove a newer recommit.
	 *
	 * Returns the number of edges queued. The caller must hold the critical
	 * section.
	 */
	async queueRevokedCacheEdges(
		cache: ResolvedCache,
		limit: number
	): Promise<number> {
		const tenant = this.context.requireTenant();
		const page = await this.context.d1
			.select({
				storePathHash: d1Schema.blobReference.storePathHash,
				generation: d1Schema.blobReference.generation,
				narHash: d1Schema.blobReference.narHash
			})
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
					revokedByCacheGeneration()
				)
			)
			.limit(limit)
			.all();

		if (page.length === 0) {
			return 0;
		}

		const now = isoTimestamp(new Date());

		this.context.db.transaction((tx) => {
			for (const edge of page) {
				this.enqueueNarInfoDeletion(
					tx,
					cache,
					edge.storePathHash,
					edge.narHash,
					edge.generation,
					now
				);
			}
		});

		return page.length;
	}

	/**
	 * Retires queued narinfo deletions for one cache within the invocation's D1
	 * allowance. Returns the number of published narinfo objects removed.
	 *
	 * The caller must hold the critical section. Each chunk completes its
	 * attestation retirement, generation checks, object deletions, edge
	 * retirement, accounting, and queue clears before the next chunk starts, so
	 * a timeout can repeat at most one chunk. Exact generation filters make
	 * replays idempotent and preserve objects from later recommits.
	 *
	 * The durable queue retains every unprocessed entry for the next pass.
	 */
	async retireTornDownNarInfos(
		cache: ResolvedCache,
		entries: readonly TornDownNarInfo[],
		_origin?: RequestOrigin
	): Promise<number> {
		if (entries.length === 0) {
			return 0;
		}

		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		let deletedObjects = 0;

		for (const batch of chunk(entries, maxFencedRetireRows)) {
			const retired = await this.retireTornDownChunk(cache, tenant, batch, now);

			if (retired === undefined) {
				break;
			}

			deletedObjects += retired;
		}

		return deletedObjects;
	}

	async deleteStorePath(
		cacheScope: CacheScope,
		storePathHash: StorePathHash,
		origin: RequestOrigin
	): Promise<DeletePathResponseInput> {
		const cache = this.context.cacheRepository.resolve(cacheScope);

		if (cache === undefined) {
			return {
				storePathHash,
				deleted: false,
				narScheduledForDeletion: false
			};
		}

		// Keep row removal and opportunistic object cleanup in one critical section
		// so healing cannot recreate the object between them.
		return this.context.criticalSection(async () => {
			const row = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, storePathHash)
					)
				)
				.get();

			if (row === undefined) {
				return {
					storePathHash,
					deleted: false,
					narScheduledForDeletion: false
				};
			}

			// Remove the row and enqueue cleanup atomically. The durable queue prevents
			// an interrupted object deletion from restoring the path, and the NAR grace
			// period starts only after cleanup removes the object.
			const now = isoTimestamp(new Date());

			this.context.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, storePathHash)
						)
					)
					.run();
				tx.delete(schema.retentionGrace)
					.where(
						and(
							eq(schema.retentionGrace.cacheId, cache.id),
							eq(schema.retentionGrace.storePathHash, storePathHash)
						)
					)
					.run();
				this.enqueueNarInfoDeletion(
					tx,
					cache,
					storePathHash,
					row.narHash,
					row.generation,
					now
				);
			});

			const queued = await this.retireQueuedNarInfoEdge(
				cache,
				storePathHash,
				row.generation
			);

			if (queued === undefined) {
				return {
					storePathHash,
					deleted: true,
					narScheduledForDeletion: false
				};
			}

			let isNarScheduledForDeletion = false;

			try {
				({ narScheduledForDeletion: isNarScheduledForDeletion } =
					await this.cleanUpQueuedNarInfo(
						cache,
						storePathHash,
						row.generation,
						queued,
						origin
					));
			} catch {
				// The durable queue remains for garbage collection to retry.
			}

			return {
				storePathHash,
				deleted: true,
				narScheduledForDeletion: isNarScheduledForDeletion
			};
		});
	}

	async removeStaleNarInfo(
		row: typeof schema.narInfos.$inferSelect,
		origin: RequestOrigin
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.reconcileMissingNar(row, origin)
		);
	}

	// The caller must hold the critical section. Remove the stale row and enqueue
	// cleanup atomically so an interrupted reconciliation cannot recreate the
	// path. Garbage collection retries any object cleanup left in the queue.
	async reconcileMissingNar(
		row: typeof schema.narInfos.$inferSelect,
		origin?: RequestOrigin
	): Promise<void> {
		const now = isoTimestamp(new Date());
		const cache = this.context.cacheRepository.resolvedForId(row.cacheId);
		const wasRemoved = this.context.db.transaction((tx) => {
			const deleted = tx
				.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						eq(schema.narInfos.storePathHash, row.storePathHash),
						eq(schema.narInfos.generation, row.generation),
						eq(schema.narInfos.narHash, row.narHash)
					)
				)
				.returning({ storePathHash: schema.narInfos.storePathHash })
				.get();

			if (deleted === undefined) {
				return false;
			}

			tx.delete(schema.retentionGrace)
				.where(
					and(
						eq(schema.retentionGrace.cacheId, cache.id),
						eq(schema.retentionGrace.storePathHash, row.storePathHash)
					)
				)
				.run();
			this.enqueueNarInfoDeletion(
				tx,
				cache,
				row.storePathHash,
				row.narHash,
				row.generation,
				now
			);

			return true;
		});

		if (!wasRemoved) {
			return;
		}

		try {
			await this.deleteQueuedNarInfo(
				cache,
				row.storePathHash,
				row.generation,
				origin
			);
		} catch {
			// The durable queue remains for garbage collection to retry.
		}
	}
}
