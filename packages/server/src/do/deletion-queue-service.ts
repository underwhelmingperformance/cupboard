import {
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type DeletePathResponse } from '@cupboard/protocol/upload';
import { and, eq, exists, inArray, notExists, or, sql } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { narInfoCachePath, narInfoObjectKey } from '../http/http.ts';

import { type AttestationCasService } from './attestation-cas-service.ts';
import { type AttestationsService } from './attestations-service.ts';
import {
	chunk,
	deleteObjects,
	mapWithConcurrency,
	maxInClauseValues,
	maxOutgoingConnections
} from './bulk.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';

// One queued teardown deletion, the captured narinfo version its retirement is
// fenced on.
export interface TornDownNarInfo {
	readonly storePathHash: StorePathHash;
	readonly generation: number;
	readonly narHash: NixSha256HashString;
}

// A fenced edge retirement binds two parameters per row (the path and its
// generation), so the OR-of-AND list is chunked to stay within D1's
// bound-parameter limit with headroom for the fixed tenant and cache.
const maxFencedRetireRows = Math.floor(maxInClauseValues / 2);

export class DeletionQueueService {
	constructor(
		private readonly context: ServerContext,
		private readonly attestationCas: AttestationCasService,
		private readonly attestations: AttestationsService
	) {}

	// Retires the D1 reference edge for one captured narinfo version, then drops the
	// tenant's `tenant_blob` presence once it holds no more edges for the hash. The
	// edge delete targets the exact `(tenant, cache, store_path_hash, generation)`,
	// so a newer recommitted edge is never touched.
	private async retireBlobRefEdge(
		cache: string,
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

		const stillReferenced = await this.context.d1
			.select({ narHash: d1Schema.blobReference.narHash })
			.from(d1Schema.blobReference)
			.where(
				and(
					eq(d1Schema.blobReference.tenant, tenant),
					eq(d1Schema.blobReference.narHash, narHash)
				)
			)
			.get();

		if (stillReferenced !== undefined) {
			return;
		}

		// The tenant's last edge for this hash is gone: read the charged size, then
		// credit the bytes and the unique-blob count and drop the presence row in one
		// atomic batch. The credit is gated on the presence still existing, so a replay
		// does not double-credit.
		const presence = await this.context.d1
			.select({ fileSize: d1Schema.tenantBlob.fileSize })
			.from(d1Schema.tenantBlob)
			.where(
				and(
					eq(d1Schema.tenantBlob.tenant, tenant),
					eq(d1Schema.tenantBlob.narHash, narHash)
				)
			)
			.get();

		if (presence === undefined) {
			return;
		}

		const presenceFilter = and(
			eq(d1Schema.tenantBlob.tenant, tenant),
			eq(d1Schema.tenantBlob.narHash, narHash)
		);

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
		cache: string,
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
		cache: string,
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
			await caches.default.delete(url);
		} catch {
			/* edge purge is best-effort */
		}
	}

	enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: string,
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
	async flushQueuedNarInfoDeletions(origin?: string): Promise<number> {
		const queued = this.context.db.select().from(schema.narInfoDeletions).all();
		let deleted = 0;

		for (const entry of queued) {
			const { objectDeleted: isObjectDeleted } = await this.deleteQueuedNarInfo(
				entry.cache,
				entry.storePathHash,
				entry.generation,
				origin
			);

			if (isObjectDeleted) {
				deleted += 1;
			}
		}

		return deleted;
	}

	// Runs inside the caller's critical section; must not open its own.
	async deleteQueuedNarInfo(
		cache: string,
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

		await this.context.env.BLOBS.delete(
			narInfoObjectKey(tenant, storePathHash, cache)
		);

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

	// Retires a whole chunk of a cache teardown's queued deletions in batched
	// D1 operations: the per-path form costs three or four round-trips per path
	// inside the gate, which for a large cache holds it for minutes. The chunk
	// shares one removed cache, so the work batches cleanly: one bulk R2 delete
	// for the narinfo objects, one fenced credit-and-delete batch per edge
	// sub-chunk, one presence sweep per hash sub-chunk, and a synchronous queue
	// clear. A path recommitted since its row was removed keeps its live object
	// (the generation fence skips its object delete), while the captured
	// generation's edge and references are still retired.
	//
	// Runs inside the caller's critical section; must not open its own.
	async retireTornDownNarInfos(
		cache: string,
		entries: readonly TornDownNarInfo[],
		origin?: string
	): Promise<void> {
		if (entries.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const clock = new Date();
		const now = clock.toISOString();

		// The generation fence, against the DO's own live rows (synchronous).
		const liveGenerations = new Map(
			chunk(
				entries.map((entry) => entry.storePathHash),
				maxInClauseValues
			).flatMap((batch) =>
				this.context.db
					.select({
						storePathHash: schema.narInfos.storePathHash,
						generation: schema.narInfos.generation
					})
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							inArray(schema.narInfos.storePathHash, batch)
						)
					)
					.all()
					.map((row) => [row.storePathHash, row.generation] as const)
			)
		);
		const removable = entries.filter((entry) => {
			const live = liveGenerations.get(entry.storePathHash);

			return live === undefined || live === entry.generation;
		});

		// The served objects go in bulk, then their edge-cache entries
		// (best-effort, bounded fan-out).
		await deleteObjects(
			this.context.env.BLOBS,
			removable.map((entry) =>
				narInfoObjectKey(tenant, entry.storePathHash, cache)
			)
		);

		if (origin !== undefined) {
			await mapWithConcurrency(removable, maxOutgoingConnections, (entry) =>
				this.purgeCachedNarInfo(
					`${origin}${narInfoCachePath(tenant, entry.storePathHash, cache)}`
				)
			);
		}

		// Retire every captured edge, crediting the narinfo count by how many
		// actually existed, atomically per sub-chunk so a replay cannot
		// double-credit.
		for (const batch of chunk(entries, maxFencedRetireRows)) {
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
		}

		// Drop the presence rows whose hashes the tenant no longer references
		// anywhere, crediting bytes and blob counts by what is actually dropped.
		// This runs in the caller's critical section and this Durable Object is
		// the single writer of its tenant's presence rows, so the select and the
		// batch cannot be interleaved by another charge.
		const narHashes = [...new Set(entries.map((entry) => entry.narHash))];

		for (const batch of chunk(narHashes, maxInClauseValues)) {
			const stillReferenced = this.context.d1
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
				inArray(d1Schema.tenantBlob.narHash, batch),
				notExists(stillReferenced)
			);
			const droppable = await this.context.d1
				.select({
					narHash: d1Schema.tenantBlob.narHash,
					fileSize: d1Schema.tenantBlob.fileSize
				})
				.from(d1Schema.tenantBlob)
				.where(droppableFilter)
				.all();

			if (droppable.length === 0) {
				continue;
			}

			const bytes = droppable.reduce((total, row) => total + row.fileSize, 0);
			const dropFilter = and(
				eq(d1Schema.tenantBlob.tenant, tenant),
				inArray(
					d1Schema.tenantBlob.narHash,
					droppable.map((row) => row.narHash)
				)
			);

			await this.context.d1.batch([
				this.context.d1
					.update(d1Schema.tenantUsage)
					.set({
						bytes: sql`${d1Schema.tenantUsage.bytes} - ${bytes}`,
						blobs: sql`${d1Schema.tenantUsage.blobs} - ${droppable.length}`,
						updatedAt: now
					})
					.where(eq(d1Schema.tenantUsage.tenant, tenant)),
				this.context.d1.delete(d1Schema.tenantBlob).where(dropFilter)
			]);
		}

		// Attestation references are rare on most paths; read them per sub-chunk
		// and retire each, re-rendering the affected paths' list objects.
		for (const batch of chunk(entries, maxFencedRetireRows)) {
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
		}

		// The queue rows clear synchronously, exactly the retired (path,
		// generation) pairs: a later-queued generation of the same path keeps its
		// row, and with it the retirement it is still owed.
		for (const batch of chunk(entries, maxFencedRetireRows)) {
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
		}
	}

	deleteStorePath(
		cache: string,
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
