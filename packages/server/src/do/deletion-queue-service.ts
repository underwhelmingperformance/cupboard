import {
	type NarInfoGeneration,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type DeletePathResponse } from '@cupboard/protocol/upload';
import { and, eq, exists, inArray, notExists, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { type RequestOrigin } from '../http/http.ts';

import { type AttestationCasService } from './attestation-cas-service.ts';
import { type AttestationsService } from './attestations-service.ts';
import { chunk, maxInClauseValues } from './bulk.ts';
import { CachePurgeQueueService } from './cache-purge-queue-service.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import { type NarInfoObjectsService } from './narinfo-objects-service.ts';

export interface TornDownNarInfo {
	readonly storePathHash: StorePathHash;
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

// Each fenced edge binds a path and generation. Reserve parameters for the
// tenant and cache when calculating the largest safe D1 batch.
export const maxFencedRetireRows = Math.floor(maxInClauseValues / 2);

// Limit each flush to a few retirement batches. An alarm continues any backlog
// without keeping the critical section open for the entire queue.
export const maxNarInfoDeletionsFlushedPerRun = 4 * maxFencedRetireRows;

// The credit update embeds the tenant and hash filter twice. Together with the
// fixed bindings, a chunk uses 2N+6 parameters; 45 stays below D1's limit of 100.
export const maxTeardownPresenceChunk = 45;

// The credit update and presence delete use the same filter in one transaction.
// Keep the update first so its subqueries measure the rows that the delete will
// remove. Exported for the D1 parameter-limit test.
export function teardownPresenceBatch(
	d1: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	narHashes: readonly NixSha256HashString[],
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
		cache: StoredCache,
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

	// Reports whether the hash has no committed reference in any tenant. The
	// global reaper, not this deletion path, decides when to remove the NAR.
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
		generation: NarInfoGeneration
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
		generation: NarInfoGeneration
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

	enqueueNarInfoDeletion(
		handle: SchemaWriter,
		cache: StoredCache,
		storePathHash: StorePathHash,
		narHash: NixSha256HashString,
		generation: NarInfoGeneration,
		now: IsoTimestamp
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

	// The caller must hold the critical section. The deterministic cap bounds one
	// pass; an alarm resumes the remaining durable queue entries.
	async flushQueuedNarInfoDeletions(
		origin?: RequestOrigin,
		limit: number = maxNarInfoDeletionsFlushedPerRun
	): Promise<number> {
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

	// The caller must hold the critical section because the row check, object
	// deletion, edge retirement, and queue clear span asynchronous operations.
	async deleteQueuedNarInfo(
		cache: StoredCache,
		storePathHash: StorePathHash,
		generation: NarInfoGeneration,
		_origin?: RequestOrigin
	): Promise<{ objectDeleted: boolean; narScheduledForDeletion: boolean }> {
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

		// A newer generation keeps the path-keyed object. The captured generation's
		// reference edge and attestations still need to be retired.
		if (wasNewerCommitted) {
			await this.cachePurges.enqueueNarInfos(cache, [storePathHash]);
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

		await this.narInfoObjects.deleteNarInfoObject(cache, storePathHash);
		await this.cachePurges.enqueueNarInfos(cache, [storePathHash]);

		await this.retireBlobRefEdge(
			cache,
			storePathHash,
			queued.generation,
			queued.narHash
		);
		await this.retireAttestationRefs(cache, storePathHash, queued.generation);
		await this.attestations.materialiseList(cache, storePathHash);

		// Re-check the live edges because another path may have committed the same
		// NAR after this row was removed. The global reaper owns NAR deletion.
		const isNarScheduledForDeletion = await this.blobHashUnreferenced(
			queued.narHash
		);

		this.clearQueuedNarInfoDeletion(cache, storePathHash, generation);

		return {
			objectDeleted: true,
			narScheduledForDeletion: isNarScheduledForDeletion
		};
	}

	// The caller must hold the critical section. Each bounded chunk completes its
	// generation checks, object deletions, edge and attestation retirement,
	// accounting, and queue clears before the next chunk starts. A timeout can
	// therefore repeat at most one chunk. Exact generation filters make replays
	// idempotent and preserve objects from later recommits.
	async retireTornDownNarInfos(
		cache: StoredCache,
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

			await this.narInfoObjects.deleteNarInfoObjects(
				cache,
				removable.map((entry) => entry.storePathHash)
			);

			await this.cachePurges.enqueueNarInfos(
				cache,
				batch.map((entry) => entry.storePathHash)
			);

			// Compute the credit from edges that still exist, then delete those exact
			// generations in the same transaction. Replays cannot double-credit.
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

			// A shared hash retains its presence row until its final edge is retired.
			// The caller's critical section makes this Durable Object the sole writer
			// for the tenant's presence rows while the credit and delete run.
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

			// Re-render every retired path. After a crash following reference removal,
			// a retry finds no reference rows but must still replace the stale list.
			const affected = [...new Set(batch.map((entry) => entry.storePathHash))];

			for (const storePathHash of affected) {
				await this.attestations.materialiseList(cache, storePathHash);
			}

			// Clear only the retired path and generation pairs. A later generation
			// keeps its queue entry, and clearing each completed chunk preserves
			// progress across a timeout.
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
		origin: RequestOrigin
	): Promise<DeletePathResponse> {
		// Keep row removal and opportunistic object cleanup in one critical section
		// so healing cannot recreate the object between them.
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

			// Remove the row and enqueue cleanup atomically. The durable queue prevents
			// an interrupted object deletion from restoring the path, and the NAR grace
			// period starts only after cleanup removes the object.
			const now = isoTimestamp(new Date());

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
			// The durable queue remains for garbage collection to retry.
		}
	}
}
