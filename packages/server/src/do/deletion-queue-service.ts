import {
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type DeletePathResponse } from '@cupboard/protocol/upload';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { and, eq, exists, inArray, notExists, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoCachePath } from '../http/http.ts';

import { type AttestationCasService } from './attestation-cas-service.ts';
import { type AttestationsService } from './attestations-service.ts';
import { chunk, maxInClauseValues, maxOutgoingConnections } from './bulk.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';

// One queued teardown deletion, the captured narinfo version its retirement is
// fenced on.
export interface TornDownNarInfo {
	readonly storePathHash: StorePathHash;
	readonly generation: number;
	readonly narHash: NixSha256HashString;
}

// A fenced edge retirement binds two parameters per row (the path and its
// generation), so the OR-of-AND list is chunked to stay within D1's
// bound-parameter limit with headroom for the fixed tenant and cache. Each such
// chunk is also one durable-progress unit of a teardown drain.
export const maxFencedRetireRows = Math.floor(maxInClauseValues / 2);

// A capped flush retires at most this many queued deletions per pass: a few
// fenced-retire chunks' worth, so one pass's gated subrequests stay well inside
// the section budget while a backlog drains across alarm-resumed passes.
export const maxNarInfoDeletionsFlushedPerRun = 4 * maxFencedRetireRows;

// The presence sweep credit UPDATE embeds droppableFilter twice (in the
// droppedBytes and droppedCount subqueries), each binding tenant(1) + IN(N) +
// the notExists subquery's tenant(1) = N+2 parameters. The two embeds plus
// updatedAt(1) and the outer WHERE tenant(1) total 2(N+2)+2 = 2N+6 parameters.
// Solving 2N+6 <= 100 gives N <= 47; 45 matches maxFencedRetireRows and leaves
// a margin.
export const maxTeardownPresenceChunk = 45;

// Builds the credit UPDATE and presence DELETE for one narHash sub-chunk of a
// teardown sweep. The UPDATE credits back the exact bytes and count the DELETE
// drops, computed as subqueries over the same `droppableFilter`: the batch runs
// its update before its delete in one transaction, so the subqueries read the
// rows the delete then removes and the credit matches the drop with no separate
// read. Exported for the D1 parameter guard test.
export function teardownPresenceBatch(
	d1: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: readonly NixSha256HashString[],
	now: string
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
		private readonly narInfoObjects: NarInfoObjectsService
	) {}

	// Retires the D1 reference edge for one captured narinfo version, then drops the
	// tenant's `tenant_blob` presence once it holds no more edges for the hash. The
	// edge delete targets the exact `(tenant, cache, store_path_hash, generation)`,
	// so a newer recommitted edge is never touched.
	private async retireBlobRefEdge(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: number,
		narHash: NixSha256HashString
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const clock = new Date();
		const now = clock.toISOString();

		// Retire the captured edge and credit a narinfo back in one atomic batch. The
		// credit is gated on the edge still existing, so a replayed retirement (the edge
		// already gone) does not double-credit; it charges before the delete so the gate
		// sees the pre-delete state.
		const edgeFilter = and(
			eq(d1Schema.blobReference.tenant, tenant),
			eq(d1Schema.blobReference.cache, cache),
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

		// Read whether any edge still references the hash and, eagerly, the presence
		// row's charged size in one round-trip. The presence read is a harmless
		// point-read discarded when the hash is still referenced, so reading it
		// alongside costs nothing but the request it saves.
		const [stillReferencedRows, presenceRows] = await this.context.d1.batch([
			this.context.d1
				.select({ narHash: d1Schema.blobReference.narHash })
				.from(d1Schema.blobReference)
				.where(hashReferencedFilter),
			this.context.d1
				.select({ fileSize: d1Schema.tenantBlob.fileSize })
				.from(d1Schema.tenantBlob)
				.where(presenceFilter)
		]);

		if (stillReferencedRows[0] !== undefined) {
			return;
		}

		// The tenant's last edge for this hash is gone: credit the bytes and the
		// unique-blob count and drop the presence row in one atomic batch, gated on
		// the presence still existing so a replay does not double-credit.
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

	// Whether no committed narinfo, in any tenant, still references this NAR hash:
	// the "safe to reclaim" probe, on `blob_ref` (its indexed `nar_hash`) across
	// all tenants' narinfos. The reaper does the actual reclamation against
	// `blob_state.delete_after`; a delete only reports this so a client learns its
	// NAR became unreferenced.
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
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: number
	): void {
		this.context.db
			.delete(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.run();
	}

	private async retireAttestationRefs(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: number
	): Promise<void> {
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
					eq(d1Schema.attestationReference.cache, cache),
					eq(d1Schema.attestationReference.storePathHash, storePathHash),
					eq(d1Schema.attestationReference.generation, generation)
				)
			)
			.all();

		for (const reference of references) {
			await this.attestationCas.removeCapturedReference(reference);
		}
	}

	private async purgeCachedNarInfo(url: string): Promise<void> {
		// Best-effort and colo-local: recovery correctness rests on the R2 delete
		// and row cleanup, so a failed edge purge must not abort them. Other colos
		// serve the stale narinfo until its TTL expires.
		try {
			await this.context.cache.delete(url);
		} catch {
			/* edge purge is best-effort */
		}
	}

	enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: StoredCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: number,
		now: string
	): void {
		handle
			.insert(schema.narInfoDeletions)
			.values({ cache, storePathHash, narHash, generation, createdAt: now })
			.onConflictDoUpdate({
				target: [
					schema.narInfoDeletions.cache,
					schema.narInfoDeletions.storePathHash,
					schema.narInfoDeletions.generation
				],
				set: { narHash, createdAt: now }
			})
			.run();
	}

	// Runs inside the caller's critical section; must not open its own.
	async flushQueuedNarInfoDeletions(
		origin?: string,
		limit: number = maxNarInfoDeletionsFlushedPerRun
	): Promise<number> {
		// Read a capped, deterministically ordered slice grouped per cache, so one
		// pass drains a bounded number of entries and a backlog carries over to the
		// next alarm-resumed pass instead of holding the gate.
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.orderBy(
				schema.narInfoDeletions.cache,
				schema.narInfoDeletions.storePathHash,
				schema.narInfoDeletions.generation
			)
			.limit(limit)
			.all();

		// Group by cache so each cache's slice drains through the batched teardown
		// retirement, whose generation fence and origin purge match the per-path
		// form with a bounded number of round-trips per cache.
		const byCache = new Map<StoredCache, TornDownNarInfo[]>();

		for (const entry of queued) {
			const entries = byCache.get(entry.cache) ?? [];
			entries.push({
				storePathHash: entry.storePathHash,
				generation: entry.generation,
				narHash: entry.narHash
			});
			byCache.set(entry.cache, entries);
		}

		let deleted = 0;

		for (const [cache, entries] of byCache) {
			deleted += await this.retireTornDownNarInfos(cache, entries, origin);
		}

		return deleted;
	}

	// Whether any teardown deletion is still queued, so a capped flush's caller
	// re-arms only while there is more to retire. A real column is selected
	// because a `select({ one: sql`1` })` probe reads as undefined even when rows
	// exist under this driver.
	hasQueuedNarInfoDeletions(): boolean {
		const row = this.context.db
			.select({ storePathHash: schema.narInfoDeletions.storePathHash })
			.from(schema.narInfoDeletions)
			.limit(1)
			.get();

		return row !== undefined;
	}

	// Runs inside the caller's critical section; must not open its own.
	async deleteQueuedNarInfo(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: number,
		origin?: string
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
		// Must run inside a DO critical section: the row check, object delete, NAR
		// scheduling and queue clear span awaits and must not interleave with a
		// commit or another flush.
		const queued = this.context.db
			.select()
			.from(schema.narInfoDeletions)
			.where(
				and(
					eq(schema.narInfoDeletions.cache, cache),
					eq(schema.narInfoDeletions.storePathHash, storePathHash),
					eq(schema.narInfoDeletions.generation, generation)
				)
			)
			.get();

		if (queued === undefined) {
			return { objectDeleted: false, narScheduledForDeletion: false };
		}

		const current = this.context.db
			.select({ generation: schema.narInfos.generation })
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();
		const wasNewerCommitted =
			current !== undefined && current.generation !== queued.generation;

		if (wasNewerCommitted) {
			await this.retireBlobRefEdge(
				cache,
				storePathHash,
				queued.generation,
				queued.narHash
			);
			await this.retireAttestationRefs(cache, storePathHash, queued.generation);
			await this.attestations.materialiseList(cache, storePathHash);

			const isNarScheduledForDeletion = await this.blobHashUnreferenced(
				queued.narHash
			);
			this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);
			return {
				objectDeleted: false,
				narScheduledForDeletion: isNarScheduledForDeletion
			};
		}

		const tenant = this.context.requireTenant();

		await this.narInfoObjects.deleteNarInfoObject(cache, storePathHash);

		if (origin !== undefined) {
			await this.purgeCachedNarInfo(
				`${origin}${narInfoCachePath(tenant, storePathHash, cache)}`
			);
		}

		await this.retireBlobRefEdge(
			cache,
			storePathHash,
			queued.generation,
			queued.narHash
		);
		await this.retireAttestationRefs(cache, storePathHash, queued.generation);
		await this.attestations.materialiseList(cache, storePathHash);

		// Report whether the NAR is now unreferenced (the reaper will reclaim it).
		// Re-check against the live edges: a path may have committed the same NAR
		// since the row was removed.
		const isNarScheduledForDeletion = await this.blobHashUnreferenced(
			queued.narHash
		);

		this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);

		return {
			objectDeleted: true,
			narScheduledForDeletion: isNarScheduledForDeletion
		};
	}

	// Retires a cache teardown's queued deletions in batched D1 operations: the
	// per-path form costs three or four round-trips per path inside the gate,
	// which for a large cache holds it for minutes. The entries share one removed
	// cache, so the work batches cleanly. Each chunk of `maxFencedRetireRows`
	// runs a self-contained pipeline: its generation fence, one bulk R2 delete
	// for the narinfo objects, its edge-cache purges, one fenced credit-and-delete
	// batch, its presence sweep, its attestation retirement and list re-render,
	// then a synchronous clear of exactly that chunk's queue rows. Because a chunk
	// finishes before the next starts, a mid-pass SubrequestTimeoutError redoes at
	// most one chunk on the next pass rather than the whole cache. A path
	// recommitted since its row was removed keeps its live object (the generation
	// fence skips its object delete), while the captured generation's edge and
	// references are still retired. Returns how many served objects it deleted:
	// the entries whose generation the DO's live row had not superseded.
	//
	// Runs inside the caller's critical section; must not open its own.
	async retireTornDownNarInfos(
		cache: StoredCache,
		entries: readonly TornDownNarInfo[],
		origin?: string
	): Promise<number> {
		if (entries.length === 0) {
			return 0;
		}

		const tenant = this.context.requireTenant();
		const clock = new Date();
		const now = clock.toISOString();

		let deletedObjects = 0;

		for (const batch of chunk(entries, maxFencedRetireRows)) {
			// The generation fence, against the DO's own live rows (synchronous). A
			// chunk never exceeds maxFencedRetireRows, well within the IN-clause
			// limit, so the fence reads in one query.
			const storePathHashes = batch.map((entry) => entry.storePathHash);
			const liveRows = this.context.db
				.select({
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation
				})
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						inArray(schema.narInfos.storePathHash, storePathHashes)
					)
				)
				.all();
			const liveGenerations = new Map(
				liveRows.map((row) => [row.storePathHash, row.generation] as const)
			);
			const removable = batch.filter((entry) => {
				const live = liveGenerations.get(entry.storePathHash);

				return live === undefined || live === entry.generation;
			});

			// The served objects go in bulk, then their edge-cache entries
			// (best-effort, bounded fan-out).
			await this.narInfoObjects.deleteNarInfoObjects(
				cache,
				removable.map((entry) => entry.storePathHash)
			);

			if (origin !== undefined) {
				await mapWithConcurrency(removable, maxOutgoingConnections, (entry) =>
					this.purgeCachedNarInfo(
						`${origin}${narInfoCachePath(tenant, entry.storePathHash, cache)}`
					)
				);
			}

			// Retire the chunk's captured edges, crediting the narinfo count by how
			// many actually existed, atomically so a replay cannot double-credit.
			const edgeFilter = and(
				eq(d1Schema.blobReference.tenant, tenant),
				eq(d1Schema.blobReference.cache, cache),
				or(
					...batch.map((entry) =>
						and(
							eq(d1Schema.blobReference.storePathHash, entry.storePathHash),
							eq(d1Schema.blobReference.generation, entry.generation)
						)
					)
				)
			);
			const edgeCount = this.context.d1
				.select({ count: sql<number>`count(*)` })
				.from(d1Schema.blobReference)
				.where(edgeFilter);

			await this.context.d1.batch([
				this.context.d1
					.update(d1Schema.tenantUsage)
					.set({
						narinfos: sql`${d1Schema.tenantUsage.narinfos} - (${edgeCount})`,
						updatedAt: now
					})
					.where(eq(d1Schema.tenantUsage.tenant, tenant)),
				this.context.d1.delete(d1Schema.blobReference).where(edgeFilter)
			]);

			// Drop the presence rows whose hashes the tenant no longer references
			// anywhere, crediting bytes and blob counts by what is actually dropped.
			// A presence row drops only once no reference edge remains anywhere, and
			// a hash shared with a later chunk still has that chunk's edge until it
			// runs, so sweeping per chunk keeps the credit exact. This runs in the
			// caller's critical section and this Durable Object is the single writer
			// of its tenant's presence rows, so the select and the batch cannot be
			// interleaved by another charge.
			const narHashes = [...new Set(batch.map((entry) => entry.narHash))];

			for (const hashes of chunk(narHashes, maxTeardownPresenceChunk)) {
				const { update, presenceDelete } = teardownPresenceBatch(
					this.context.d1,
					tenant,
					hashes,
					now
				);
				await this.context.d1.batch([update, presenceDelete]);
			}

			// Attestation references are rare on most paths; read the chunk's and
			// retire each, re-rendering the affected paths' list objects.
			const pairFilters = batch.map((entry) =>
				and(
					eq(d1Schema.attestationReference.storePathHash, entry.storePathHash),
					eq(d1Schema.attestationReference.generation, entry.generation)
				)
			);
			const referenceFilter = and(
				eq(d1Schema.attestationReference.tenant, tenant),
				eq(d1Schema.attestationReference.cache, cache),
				or(...pairFilters)
			);
			const references = await this.context.d1
				.select({
					cache: d1Schema.attestationReference.cache,
					storePathHash: d1Schema.attestationReference.storePathHash,
					generation: d1Schema.attestationReference.generation,
					predicateType: d1Schema.attestationReference.predicateType,
					digest: d1Schema.attestationReference.digest
				})
				.from(d1Schema.attestationReference)
				.where(referenceFilter)
				.all();

			for (const reference of references) {
				await this.attestationCas.removeCapturedReference(reference);
			}

			// Re-render every retired path's list object, not just those whose
			// reference rows were found: a replayed chunk that crashed between the
			// reference removal and this render finds no rows, and its stale list
			// object must still go.
			const affected = [...new Set(batch.map((entry) => entry.storePathHash))];

			for (const storePathHash of affected) {
				await this.attestations.materialiseList(cache, storePathHash);
			}

			// The chunk's queue rows clear synchronously, exactly the retired (path,
			// generation) pairs: a later-queued generation of the same path keeps its
			// row, and with it the retirement it is still owed. Clearing per chunk is
			// what makes progress durable across a mid-pass timeout.
			const retiredPairs = batch.map((entry) =>
				and(
					eq(schema.narInfoDeletions.storePathHash, entry.storePathHash),
					eq(schema.narInfoDeletions.generation, entry.generation)
				)
			);

			this.context.db
				.delete(schema.narInfoDeletions)
				.where(
					and(eq(schema.narInfoDeletions.cache, cache), or(...retiredPairs))
				)
				.run();

			deletedObjects += removable.length;
		}

		return deletedObjects;
	}

	deleteStorePath(
		cache: StoredCache,
		storePathHash: StorePathHash,
		origin: string
	): Promise<DeletePathResponse> {
		// One critical section so the row transaction and the opportunistic object
		// cleanup cannot interleave with a heal that would re-materialise the
		// object.
		return this.context.criticalSection(async () => {
			const row = this.context.db
				.select()
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
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

			// Row-first: once this transaction commits the path is logically gone.
			// The narinfo object cleanup, and with it the NAR scheduling, runs
			// afterwards and is best-effort; the grace clock for the NAR only starts
			// once the object is actually removed.
			const clock = new Date();
			const now = clock.toISOString();

			this.context.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, row.cache),
							eq(schema.narInfos.storePathHash, storePathHash)
						)
					)
					.run();
				tx.delete(schema.retentionGrace)
					.where(
						and(
							eq(schema.retentionGrace.cache, row.cache),
							eq(schema.retentionGrace.storePathHash, storePathHash)
						)
					)
					.run();
				this.enqueueNarInfoDeletion(
					tx,
					row.cache,
					storePathHash,
					row.narHash,
					row.generation,
					now
				);
			});

			let isNarScheduledForDeletion = false;

			try {
				({ narScheduledForDeletion: isNarScheduledForDeletion } =
					await this.deleteQueuedNarInfo(
						row.cache,
						storePathHash,
						row.generation,
						origin
					));
			} catch {
				// the durable queue row remains for GC to retry
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
		origin: string
	): Promise<void> {
		await this.context.criticalSection(() =>
			this.reconcileMissingNar(row, origin)
		);
	}

	// Removes a narinfo whose NAR is gone, row-first, as for deleteStorePath: the
	// transaction removes the row and queues the narinfo object cleanup, so an
	// interrupted recovery cannot resurrect the path through a heal. The object
	// delete that follows is opportunistic and GC finishes anything left in the
	// queue. The caller owns the critical section so verification can reconcile a
	// whole batch in one without nesting `blockConcurrencyWhile`.
	//
	// Runs inside the caller's critical section; must not open its own.
	async reconcileMissingNar(
		row: typeof schema.narInfos.$inferSelect,
		origin?: string
	): Promise<void> {
		const clock = new Date();
		const now = clock.toISOString();

		this.context.db.transaction((tx) => {
			tx.delete(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, row.cache),
						eq(schema.narInfos.storePathHash, row.storePathHash)
					)
				)
				.run();
			tx.delete(schema.retentionGrace)
				.where(
					and(
						eq(schema.retentionGrace.cache, row.cache),
						eq(schema.retentionGrace.storePathHash, row.storePathHash)
					)
				)
				.run();
			this.enqueueNarInfoDeletion(
				tx,
				row.cache,
				row.storePathHash,
				row.narHash,
				row.generation,
				now
			);
		});

		try {
			await this.deleteQueuedNarInfo(
				row.cache,
				row.storePathHash,
				row.generation,
				origin
			);
		} catch {
			// the durable queue row remains for GC to retry
		}
	}
}
