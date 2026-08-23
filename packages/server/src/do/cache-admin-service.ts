import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheName,
	type CachePriority,
	cachePrioritySchema,
	DEFAULT_CACHE,
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type CacheListResponse,
	type CacheRemoveResponse,
	type CacheSummary
} from '@cupboard/protocol/caches';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, count, eq, gt, min, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { CacheNotEmptyError } from '../errors.ts';
import {
	narObjectKey,
	type RequestOrigin,
	requestOriginSchema
} from '../http/http.ts';

import { deleteObjects } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';

// Bound each narinfo retirement pass so large caches release the input gate
// between R2 deletions and D1 edge updates.
export const maxPathsTornDownPerRun = 1000;

// Each cache being torn down has its own durable marker because several cache
// deletion queues can be active at once. The complete suffix is the cache name,
// so names containing colons remain unambiguous.
export const teardownEntryPrefix = 'maintenance:teardown:';

export class CacheAdminService {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService
	) {}

	private teardownKey(cache: StoredCache): string {
		return `${teardownEntryPrefix}${cache}`;
	}

	private hasQueuedDeletions(cache: StoredCache): boolean {
		const row = this.context.db
			.select({ cache: schema.narInfoDeletions.cache })
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cache, cache))
			.limit(1)
			.get();

		return row !== undefined;
	}

	// The caller holds the input gate. The retirement service applies the
	// generation fence that protects a recommitted path.
	private async drainTeardownChunk(
		cache: StoredCache,
		origin: RequestOrigin,
		limit: number
	): Promise<number> {
		const queued = this.context.db
			.select({
				storePathHash: schema.narInfoDeletions.storePathHash,
				generation: schema.narInfoDeletions.generation,
				narHash: schema.narInfoDeletions.narHash
			})
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cache, cache))
			.limit(limit)
			.all();

		await this.deletionQueue.retireTornDownNarInfos(cache, queued, origin);

		return queued.length;
	}

	// Canonical UTC timestamps sort chronologically as strings.
	private earliestLiveGraceDeadline(
		cache: StoredCache
	): IsoTimestamp | undefined {
		const now = isoTimestamp(new Date());
		const row = this.context.db
			.select({ earliest: min(schema.retentionGrace.retainUntil) })
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cache, cache),
					gt(schema.retentionGrace.retainUntil, now)
				)
			)
			.get();

		return row?.earliest ?? undefined;
	}

	cacheInfoBody(cache: StoredCache): string {
		const row = this.context.db
			.select({ priority: schema.caches.priority })
			.from(schema.caches)
			.where(eq(schema.caches.name, cache))
			.get();
		const info = new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.hasMassQuery,
			row?.priority ?? CacheInfo.default.priority
		);

		return info.render();
	}

	listCaches(): CacheListResponse {
		const registered = this.context.db.select().from(schema.caches).all();
		const counts = new Map(
			this.context.db
				.select({ cache: schema.narInfos.cache, count: count() })
				.from(schema.narInfos)
				.groupBy(schema.narInfos.cache)
				.all()
				.map((row) => [row.cache, row.count])
		);
		const now = isoTimestamp(new Date());
		const earliestDeadlines = new Map(
			this.context.db
				.select({
					cache: schema.retentionGrace.cache,
					earliest: min(schema.retentionGrace.retainUntil)
				})
				.from(schema.retentionGrace)
				.where(gt(schema.retentionGrace.retainUntil, now))
				.groupBy(schema.retentionGrace.cache)
				.all()
				.flatMap((row) =>
					row.earliest === null ? [] : [[row.cache, row.earliest] as const]
				)
		);
		const caches = registered
			.map((row) => {
				const earliestGraceDeadline = earliestDeadlines.get(row.name);

				return {
					name: row.name,
					priority: row.priority,
					storePaths: counts.get(row.name) ?? 0,
					graceManaged: row.graceManaged,
					...(earliestGraceDeadline !== undefined && {
						earliestGraceDeadline
					})
				};
			})
			.toSorted((left, right) => byCodeUnit(left.name, right.name));

		return { caches };
	}

	putCache(cache: CacheName, priority: CachePriority): CacheSummary {
		this.context.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoUpdate({
				target: schema.caches.name,
				set: { priority }
			})
			.run();

		return this.cacheSummary(cache, priority);
	}

	async removeCache(
		cache: CacheName,
		shouldForce: boolean,
		origin: RequestOrigin
	): Promise<CacheRemoveResponse> {
		const committedCount = this.cacheStorePathCount(cache);

		if (!shouldForce && committedCount > 0) {
			throw new CacheNotEmptyError(cache);
		}

		const isRegistered =
			this.context.db
				.select()
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get() !== undefined;
		await this.tearDownCache(cache, origin);

		// Report the number removed from the registry, even when object and edge
		// cleanup continues across later alarms.
		return {
			name: cache,
			removed: isRegistered || committedCount > 0,
			storePathsRemoved: committedCount
		};
	}

	cacheStorePathCount(cache: StoredCache): number {
		const result = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.get();

		return result?.count ?? 0;
	}

	cacheSummary(cache: StoredCache, priority: CachePriority): CacheSummary {
		const managed = this.context.db
			.select({ graceManaged: schema.caches.graceManaged })
			.from(schema.caches)
			.where(eq(schema.caches.name, cache))
			.get();
		const earliest = this.earliestLiveGraceDeadline(cache);

		return {
			name: cache,
			priority,
			storePaths: this.cacheStorePathCount(cache),
			graceManaged: managed?.graceManaged ?? false,
			...(earliest !== undefined && { earliestGraceDeadline: earliest })
		};
	}

	loadOrCreateCache(cache: StoredCache): void {
		if (cache === DEFAULT_CACHE) {
			return;
		}

		this.context.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();
	}

	// Claim one cache marker per alarm so several large teardowns make progress
	// independently.
	async claimTeardown(): Promise<
		{ cache: StoredCache; origin: RequestOrigin } | undefined
	> {
		const entries = await this.context.ctx.storage.list<string>({
			prefix: teardownEntryPrefix,
			limit: 1
		});

		for (const [key, origin] of entries) {
			return {
				cache: storedCacheSchema.parse(key.slice(teardownEntryPrefix.length)),
				origin: requestOriginSchema.parse(origin)
			};
		}

		return undefined;
	}

	async hasPendingTeardown(): Promise<boolean> {
		const remaining = await this.context.ctx.storage.list({
			prefix: teardownEntryPrefix,
			limit: 1
		});

		return remaining.size > 0;
	}

	// Remove the cache's local state atomically, then retire its published objects
	// and D1 reference edges in bounded chunks. The deletion queue is durable, so
	// garbage collection can resume it after a crash before the alarm marker is
	// written. The blob reaper later collects unreferenced canonical objects.
	tearDownCache(
		cache: StoredCache,
		origin: RequestOrigin,
		limit: number = maxPathsTornDownPerRun
	): Promise<void> {
		return this.context.criticalSection(async () => {
			const now = isoTimestamp(new Date());
			const pending = this.context.db
				.select({
					r2Key: schema.pendingUploads.r2Key,
					narHash: schema.pendingUploads.narHash
				})
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.cache, cache))
				.all();
			const pendingAttestations = this.context.db
				.select({ r2Key: schema.pendingAttestations.r2Key })
				.from(schema.pendingAttestations)
				.where(eq(schema.pendingAttestations.cache, cache))
				.all();

			await deleteObjects(
				this.context.env.BLOBS,
				pending
					.filter((upload) => upload.r2Key !== narObjectKey(upload.narHash))
					.map((upload) => upload.r2Key)
			);
			await deleteObjects(
				this.context.env.BLOBS,
				pendingAttestations.map((upload) => upload.r2Key)
			);

			// Remove every narinfo row in the same transaction that queues its
			// retirement. A later recommit creates a new generation that the queued
			// deletion cannot remove.
			this.context.db.transaction((tx) => {
				tx.run(
					sql`INSERT INTO narinfo_deletion (cache, store_path_hash, nar_hash, generation, created_at)
						SELECT cache, store_path_hash, nar_hash, generation, ${now}
						FROM narinfo WHERE cache = ${cache}
						ON CONFLICT (cache, store_path_hash, generation)
						DO UPDATE SET nar_hash = excluded.nar_hash, created_at = excluded.created_at`
				);
				tx.delete(schema.narInfos)
					.where(eq(schema.narInfos.cache, cache))
					.run();
				tx.delete(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.cache, cache))
					.run();
				tx.delete(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cache, cache))
					.run();
				// Deleting the cache is the only transition out of grace-managed state;
				// released paths receive no grace deadline.
				tx.delete(schema.retentionGrace)
					.where(eq(schema.retentionGrace.cache, cache))
					.run();
				tx.delete(schema.caches).where(eq(schema.caches.name, cache)).run();
				// Remove in-flight uploads so a later commit cannot recreate the cache.
				tx.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.cache, cache))
					.run();
				tx.delete(schema.pendingAttestations)
					.where(eq(schema.pendingAttestations.cache, cache))
					.run();
			});

			// Retire the first chunk immediately. Mark only caches whose queues need
			// another alarm pass.
			await this.drainTeardownChunk(cache, origin, limit);

			if (this.hasQueuedDeletions(cache)) {
				await this.context.ctx.storage.put(this.teardownKey(cache), origin);
				await this.context.ctx.storage.setAlarm(Date.now());
			} else {
				await this.context.ctx.storage.delete(this.teardownKey(cache));
			}
		});
	}

	// Retire one more chunk from an alarm. The caller re-arms the alarm while any
	// cache marker remains.
	async resumeTeardownPass(
		cache: StoredCache,
		origin: RequestOrigin,
		limit: number = maxPathsTornDownPerRun
	): Promise<void> {
		await this.context.criticalSection(async () => {
			await this.drainTeardownChunk(cache, origin, limit);

			// The queue, not the marker, decides when teardown is complete. A concurrent
			// repeated deletion can safely enqueue the same generation again.
			if (!this.hasQueuedDeletions(cache)) {
				await this.context.ctx.storage.delete(this.teardownKey(cache));
			}
		});
	}
}
