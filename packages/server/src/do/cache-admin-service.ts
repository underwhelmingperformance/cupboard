import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	type CacheName,
	type CachePriority,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type CacheListResponse,
	type CacheRemoveResponse,
	type CacheSummary,
	type CacheUpdateBody
} from '@cupboard/protocol/caches';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, count, eq, gt, isNull, min, sql } from 'drizzle-orm';

import {
	type CacheId,
	cacheIdentityCondition,
	cacheIdSchema,
	cacheScopeFromRow,
	type ResolvedCache
} from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	CacheAlreadyExistsError,
	CacheNotEmptyError,
	CacheNotFoundError
} from '../errors.ts';
import {
	narObjectKey,
	type RequestOrigin,
	requestOriginSchema
} from '../http/http.ts';

import { deleteObjects } from './bulk.ts';
import { type ServerContext } from './context.ts';
import {
	type DeletionQueueService,
	maxFencedRetireRows,
	minimumStatementsPerTeardownChunk
} from './deletion-queue-service.ts';
import { maintenancePassStatements } from './maintenance-eligibility-service.ts';
// Bound each narinfo retirement pass so large caches release the input gate
// between R2 deletions and D1 edge updates, and so one pass fits the D1
// statements a single Worker invocation may run.

// Once the chunk empties the queue, the pass sweeps for revoked edges.
const revokedEdgeSweepStatementsPerPass = 1;

/**
 * The most paths one pass reads from the teardown queue.
 *
 * This caps the rows read, not the statements executed. The drain can retire
 * the entire page when its paths have no attestation references. Otherwise the
 * remaining D1 allowance can stop it earlier. The calculation reserves one
 * statement for the revoked-edge sweep.
 */
export const maxPathsTornDownPerRun =
	Math.floor(
		(maintenancePassStatements - revokedEdgeSweepStatementsPerPass) /
			minimumStatementsPerTeardownChunk
	) * maxFencedRetireRows;

// Each cache being torn down has its own durable marker because several cache
// deletion queues can be active at once. The complete suffix is the cache name,
// so names containing colons remain unambiguous.
export const teardownEntryPrefix = 'maintenance:teardown:';

export class CacheAdminService {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService
	) {}

	private teardownKey(cache: ResolvedCache): string {
		return `${teardownEntryPrefix}${String(cache.id)}`;
	}

	private hasQueuedDeletions(cache: ResolvedCache): boolean {
		const row = this.context.db
			.select({ cacheId: schema.narInfoDeletions.cacheId })
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cacheId, cache.id))
			.limit(1)
			.get();

		return row !== undefined;
	}

	// The caller holds the input gate. The retirement service applies the
	// generation fence that protects a recommitted path.
	//
	// The drain sizes its page from the current allowance and keeps one D1
	// statement for the sweep below. The binding enforces the invocation limit if
	// the page estimate drifts.
	//
	// After the queue becomes empty, sweep for reference edges left by an
	// interrupted deletion and queue them for the next pass. Check the queue after
	// the drain because the last full chunk may have emptied it. A missed sweep
	// would leave the storage and tenant charge in place indefinitely.
	private async drainTeardownChunk(
		cache: ResolvedCache,
		origin: RequestOrigin,
		limit: number
	): Promise<void> {
		const queued = this.context.db
			.select({
				storePathHash: schema.narInfoDeletions.storePathHash,
				generation: schema.narInfoDeletions.generation,
				narHash: schema.narInfoDeletions.narHash
			})
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cacheId, cache.id))
			.limit(limit)
			.all();

		await this.deletionQueue.retireTornDownNarInfos(cache, queued, origin);

		if (this.hasQueuedDeletions(cache)) {
			return;
		}

		await this.deletionQueue.queueRevokedCacheEdges(cache, limit);
	}

	// Canonical UTC timestamps sort chronologically as strings.
	private earliestLiveGraceDeadline(
		cache: ResolvedCache
	): IsoTimestamp | undefined {
		const now = isoTimestamp(new Date());
		const row = this.context.db
			.select({ earliest: min(schema.retentionGrace.retainUntil) })
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cacheId, cache.id),
					gt(schema.retentionGrace.retainUntil, now)
				)
			)
			.get();

		return row?.earliest ?? undefined;
	}

	private async clearCacheReadCredential(scope: CacheScope): Promise<void> {
		const tenant = this.context.requireTenant();

		await this.context.d1
			.delete(d1Schema.tenantCacheReadCredential)
			.where(
				and(
					eq(d1Schema.tenantCacheReadCredential.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.tenantCacheReadCredential.cacheKind,
						d1Schema.tenantCacheReadCredential.cacheName,
						scope
					)
				)
			)
			.run();
	}

	cacheInfoBody(scope: CacheScope): string {
		const cache = this.context.cacheRepository.require(scope);
		const row = this.context.db
			.select({ priority: schema.caches.priority })
			.from(schema.caches)
			.where(eq(schema.caches.id, cache.id))
			.get();

		if (row === undefined) {
			throw new CacheNotFoundError(scope);
		}

		const info = new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.hasMassQuery,
			row.priority
		);

		return info.render();
	}

	listCaches(): CacheListResponse {
		const registered = this.context.db
			.select()
			.from(schema.caches)
			.where(isNull(schema.caches.deletedAt))
			.all();
		const counts = new Map(
			this.context.db
				.select({ cacheId: schema.narInfos.cacheId, count: count() })
				.from(schema.narInfos)
				.groupBy(schema.narInfos.cacheId)
				.all()
				.map((row) => [row.cacheId, row.count])
		);
		const now = isoTimestamp(new Date());
		const earliestDeadlines = new Map<CacheId, IsoTimestamp>();
		const deadlineRows = this.context.db
			.select({
				cacheId: schema.retentionGrace.cacheId,
				earliest: min(schema.retentionGrace.retainUntil)
			})
			.from(schema.retentionGrace)
			.where(gt(schema.retentionGrace.retainUntil, now))
			.groupBy(schema.retentionGrace.cacheId)
			.all();

		for (const row of deadlineRows) {
			if (row.earliest !== null) {
				earliestDeadlines.set(row.cacheId, row.earliest);
			}
		}
		const caches = registered
			.map((row): CacheSummary => {
				const earliestGraceDeadline = earliestDeadlines.get(row.id);

				return {
					scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
					access: row.access,
					priority: row.priority,
					storePaths: counts.get(row.id) ?? 0,
					graceManaged: row.graceManaged,
					...(earliestGraceDeadline !== undefined && {
						earliestGraceDeadline
					})
				};
			})
			.toSorted((left, right) =>
				byCodeUnit(
					left.scope.kind === 'default' ? '' : left.scope.name,
					right.scope.kind === 'default' ? '' : right.scope.name
				)
			);

		return { caches };
	}

	getCache(scope: CacheScope): CacheSummary {
		const cache = this.context.cacheRepository.require(scope);
		const row = this.context.db
			.select({ priority: schema.caches.priority })
			.from(schema.caches)
			.where(eq(schema.caches.id, cache.id))
			.get();

		if (row === undefined) {
			throw new CacheNotFoundError(scope);
		}

		return this.cacheSummary(cache, row.priority);
	}

	async createCache(
		scope: CacheScope,
		access: CacheAccessMode,
		priority: CachePriority
	): Promise<CacheSummary> {
		return this.context.criticalSection(async () => {
			if (this.context.cacheRepository.resolve(scope) !== undefined) {
				throw new CacheAlreadyExistsError(scope);
			}

			const lifecycle = await this.deletionQueue.clearCacheDeletion({
				scope,
				access
			});

			if (access === 'public') {
				await this.clearCacheReadCredential(scope);
			}

			const cache = this.context.cacheRepository.create(
				scope,
				access,
				priority,
				lifecycle.generation,
				lifecycle.readRevision
			);

			return this.cacheSummary(cache, priority);
		});
	}

	async updateCache(
		scope: CacheScope,
		update: CacheUpdateBody
	): Promise<CacheSummary> {
		if (update.kind === 'priority') {
			const cache = this.context.cacheRepository.require(scope);

			this.context.db
				.update(schema.caches)
				.set({ priority: update.priority })
				.where(eq(schema.caches.id, cache.id))
				.run();

			return this.cacheSummary(cache, update.priority);
		}

		return this.context.criticalSection(async () => {
			const existing = this.context.cacheRepository.require(scope);
			const lifecycle = await this.deletionQueue.clearCacheDeletion({
				scope,
				access: update.access
			});
			const cache = this.context.cacheRepository.setAccess(
				existing,
				update.access,
				lifecycle.readRevision
			);

			if (update.access === 'public') {
				await this.clearCacheReadCredential(cache.scope);
			}

			const row = this.context.db
				.select({ priority: schema.caches.priority })
				.from(schema.caches)
				.where(eq(schema.caches.id, cache.id))
				.get();

			if (row === undefined) {
				throw new CacheNotFoundError(scope);
			}

			return this.cacheSummary(cache, row.priority);
		});
	}

	async removeCache(
		name: CacheName,
		shouldForce: boolean,
		origin: RequestOrigin
	): Promise<CacheRemoveResponse> {
		const scope: CacheScope = { kind: 'named', name };
		const cache = this.context.cacheRepository.resolve(scope);
		const committedCount =
			cache === undefined ? 0 : this.cacheStorePathCount(cache);

		if (!shouldForce && committedCount > 0) {
			throw new CacheNotEmptyError(scope);
		}

		if (cache !== undefined) {
			await this.tearDownCache(cache, origin);
		}

		// Report the number removed from the registry, even when object and edge
		// cleanup continues across later alarms.
		return {
			scope,
			removed: cache !== undefined,
			storePathsRemoved: committedCount
		};
	}

	cacheStorePathCount(cache: ResolvedCache): number {
		const result = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();

		return result?.count ?? 0;
	}

	cacheSummary(cache: ResolvedCache, priority: CachePriority): CacheSummary {
		const managed = this.context.db
			.select({ graceManaged: schema.caches.graceManaged })
			.from(schema.caches)
			.where(eq(schema.caches.id, cache.id))
			.get();
		const earliest = this.earliestLiveGraceDeadline(cache);

		return {
			scope: cache.scope,
			access: cache.access,
			priority,
			storePaths: this.cacheStorePathCount(cache),
			graceManaged: managed?.graceManaged ?? false,
			...(earliest !== undefined && { earliestGraceDeadline: earliest })
		};
	}

	resolveCache(scope: CacheScope): ResolvedCache | undefined {
		return this.context.cacheRepository.resolve(scope);
	}

	requireCache(scope: CacheScope): ResolvedCache {
		return this.context.cacheRepository.require(scope);
	}

	// Claim one cache marker per alarm so several large teardowns make progress
	// independently.
	async claimTeardown(): Promise<
		{ cache: ResolvedCache; origin: RequestOrigin } | undefined
	> {
		const entries = await this.context.ctx.storage.list<string>({
			prefix: teardownEntryPrefix,
			limit: 1
		});

		for (const [key, origin] of entries) {
			const cacheId = cacheIdSchema.parse(
				Number(key.slice(teardownEntryPrefix.length))
			);

			return {
				cache: this.context.cacheRepository.resolvedForId(cacheId),
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

	/**
	 * Deletes a cache by revoking its read authority and removing its local state
	 * atomically. Bounded alarm passes run by {@link resumeTeardownPass} retire the
	 * published state.
	 *
	 * Revocation advances the cache generation and records the deletion in one D1
	 * statement, independently of the number of reference edges. The local
	 * transaction starts after this statement succeeds. Read queries then exclude
	 * earlier generations while cleanup continues.
	 *
	 * The request runs one D1 statement regardless of the number of committed
	 * paths. It always writes the teardown marker because the first pass must also
	 * sweep for edges left by an interrupted earlier deletion.
	 *
	 * The deletion queue is durable, so garbage collection can resume it after a
	 * crash before the alarm marker is written. The blob reaper later collects
	 * unreferenced canonical objects.
	 */
	tearDownCache(cache: ResolvedCache, origin: RequestOrigin): Promise<void> {
		return this.context.criticalSection(async () => {
			await this.deletionQueue.revokeCacheGeneration(cache);

			const now = isoTimestamp(new Date());
			const pending = this.context.db
				.select({
					r2Key: schema.pendingUploads.r2Key,
					narHash: schema.pendingUploads.narHash
				})
				.from(schema.pendingUploads)
				.where(eq(schema.pendingUploads.cacheId, cache.id))
				.all();
			const pendingAttestations = this.context.db
				.select({ r2Key: schema.pendingAttestations.r2Key })
				.from(schema.pendingAttestations)
				.where(eq(schema.pendingAttestations.cacheId, cache.id))
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
					sql`INSERT INTO narinfo_deletion (cache_id, store_path_hash, nar_hash, generation, created_at)
						SELECT cache_id, store_path_hash, nar_hash, generation, ${now}
						FROM narinfo WHERE cache_id = ${cache.id}
						ON CONFLICT (cache_id, store_path_hash, generation)
						DO UPDATE SET nar_hash = excluded.nar_hash, created_at = excluded.created_at`
				);
				tx.delete(schema.narInfos)
					.where(eq(schema.narInfos.cacheId, cache.id))
					.run();
				tx.delete(schema.verificationCursor)
					.where(eq(schema.verificationCursor.cacheId, cache.id))
					.run();
				tx.delete(schema.retentionRootTargets)
					.where(eq(schema.retentionRootTargets.cacheId, cache.id))
					.run();
				tx.delete(schema.retentionRoots)
					.where(eq(schema.retentionRoots.cacheId, cache.id))
					.run();
				// Deleting the cache is the only transition out of grace-managed state;
				// released paths receive no grace deadline.
				tx.delete(schema.retentionGrace)
					.where(eq(schema.retentionGrace.cacheId, cache.id))
					.run();
				tx.update(schema.caches)
					.set({ deletedAt: now })
					.where(eq(schema.caches.id, cache.id))
					.run();
				// Remove in-flight uploads so a later commit cannot recreate the cache.
				tx.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.cacheId, cache.id))
					.run();
				tx.delete(schema.pendingAttestations)
					.where(eq(schema.pendingAttestations.cacheId, cache.id))
					.run();
			});

			await this.context.ctx.storage.put(this.teardownKey(cache), origin);
			await this.context.ctx.storage.setAlarm(Date.now());
		});
	}

	// Retire one more chunk from an alarm. The caller re-arms the alarm while any
	// cache marker remains.
	async resumeTeardownPass(
		cache: ResolvedCache,
		origin: RequestOrigin,
		limit: number = maxPathsTornDownPerRun
	): Promise<void> {
		await this.context.criticalSection(async () => {
			await this.drainTeardownChunk(cache, origin, limit);

			// The queue, not the marker, decides when teardown is complete. The pass
			// leaves it empty only once the sweep has also found no revoked edge to
			// queue. A concurrent repeated deletion can safely enqueue the same
			// generation again.
			if (!this.hasQueuedDeletions(cache)) {
				await this.context.ctx.storage.delete(this.teardownKey(cache));
				this.context.db
					.delete(schema.caches)
					.where(eq(schema.caches.id, cache.id))
					.run();
			}
		});
	}
}
