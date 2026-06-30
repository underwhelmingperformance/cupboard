import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheName,
	type CachePriority,
	cachePrioritySchema,
	DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type CacheListResponse,
	type CacheRemoveResponse,
	type CacheSummary
} from '@cupboard/protocol/caches';
import { count, eq, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { CacheNotEmptyError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';

import { deleteObjects } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';

// One teardown drain pass retires at most this many queued deletions before
// yielding the gate. The narinfo rows are all removed atomically up front; only
// the per-path R2 and edge retirement is chunked here, so the gate is never held
// over an unbounded network fan-out.
export const maxPathsTornDownPerRun = 1000;

// DO storage KV holds one entry per cache whose teardown deletions are still
// draining, keyed by the cache name with the purge origin as the value. The
// single variable component is the whole suffix after the fixed prefix, so a
// cache name containing a colon is recovered unambiguously. More than one
// teardown can be in flight, so a per-cache key tracks each independently.
export const teardownEntryPrefix = 'maintenance:teardown:';

export class CacheAdminService {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService
	) {}

	private teardownKey(cache: string): string {
		return `${teardownEntryPrefix}${cache}`;
	}

	// Whether any teardown deletion for this cache is still queued, so the drain
	// re-arms only while there is more to retire.
	private hasQueuedDeletions(cache: string): boolean {
		const row = this.context.db
			.select({ cache: schema.narInfoDeletions.cache })
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cache, cache))
			.limit(1)
			.get();

		return row !== undefined;
	}

	// Retires one bounded chunk of a cache's queued teardown deletions: each path's
	// edge and R2 object. `deleteQueuedNarInfo` is fenced on the captured
	// generation, so a path recommitted since its row was removed (a fresh commit
	// the client was told succeeded) is left intact: its live generation no longer
	// matches the queued one. Returns how many it retired.
	//
	// Runs inside the caller's critical section; must not open its own.
	private async drainTeardownChunk(
		cache: string,
		origin: string,
		limit: number
	): Promise<number> {
		const queued = this.context.db
			.select({
				storePathHash: schema.narInfoDeletions.storePathHash,
				generation: schema.narInfoDeletions.generation
			})
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cache, cache))
			.limit(limit)
			.all();

		for (const entry of queued) {
			await this.deletionQueue.deleteQueuedNarInfo(
				cache,
				entry.storePathHash,
				entry.generation,
				origin
			);
		}

		return queued.length;
	}

	/** Renders a cache's nix-cache-info body from its registry priority. */
	cacheInfoBody(cache: string): string {
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
		const caches = registered
			.map((row) => this.cacheSummary(row.name, row.priority))
			.toSorted((left, right) => byCodeUnit(left.name, right.name));

		return { caches };
	}

	putCache(cache: CacheName, priority: CachePriority): CacheSummary {
		const now = new Date();

		this.context.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority,
				createdAt: now.toISOString()
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
		origin: string
	): Promise<CacheRemoveResponse> {
		const committedCount = this.cacheStorePathCount(cache);

		if (committedCount > 0 && !shouldForce) {
			throw new CacheNotEmptyError(cache);
		}

		const isRegistered =
			this.context.db
				.select()
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get() !== undefined;
		await this.tearDownCache(cache, origin);

		// The count is the cache's committed paths at the request, the number being
		// removed: a large cache drains the remainder across alarm firings, but the
		// reported total is the true count, not the first chunk's.
		return {
			name: cache,
			removed: isRegistered || committedCount > 0,
			storePathsRemoved: committedCount
		};
	}

	cacheStorePathCount(cache: string): number {
		const result = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.get();

		return result?.count ?? 0;
	}

	cacheSummary(cache: string, priority: CachePriority): CacheSummary {
		return {
			name: cache,
			priority,
			storePaths: this.cacheStorePathCount(cache)
		};
	}

	loadOrCreateCache(cache: string): void {
		// The default cache is seeded at init; a named cache is registered with
		// the default priority on first write and adjusted later via PUT /caches.
		if (cache === DEFAULT_CACHE) {
			return;
		}

		const now = new Date();

		this.context.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: now.toISOString()
			})
			.onConflictDoNothing()
			.run();
	}

	// The next cache awaiting (more) teardown drain and the origin to purge its edge
	// cache with, or undefined when none remain. The alarm claims one per firing.
	async claimTeardown(): Promise<
		{ cache: string; origin: string } | undefined
	> {
		const entries = await this.context.ctx.storage.list<string>({
			prefix: teardownEntryPrefix,
			limit: 1
		});

		for (const [key, origin] of entries) {
			return { cache: key.slice(teardownEntryPrefix.length), origin };
		}

		return undefined;
	}

	// Whether any cache still has a teardown marker, so the alarm re-arms only
	// while there is more to drain.
	async hasPendingTeardown(): Promise<boolean> {
		const remaining = await this.context.ctx.storage.list({
			prefix: teardownEntryPrefix,
			limit: 1
		});

		return remaining.size > 0;
	}

	// Drops a named cache: in one transaction it removes every committed narinfo
	// row, queues each path's retirement, and clears the roots, registry and
	// in-flight uploads. It then retires a first bounded chunk of the queue; a cache
	// within the cap is fully gone when the call returns, while a larger one writes a
	// durable marker and arms the alarm to drain the rest off the gate. A crash after
	// the transaction but before the marker leaves the queued retirements for the
	// periodic garbage collector to flush, the same backstop a single-path delete
	// relies on. The reaper later collects the now-unreferenced shared blobs. The
	// optional limit caps the first chunk for tests, mirroring the resume.
	tearDownCache(
		cache: string,
		origin: string,
		limit: number = maxPathsTornDownPerRun
	): Promise<void> {
		return this.context.ctx.blockConcurrencyWhile(async () => {
			const now = new Date().toISOString();
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

			// Queue every committed path's retirement and drop all the rows, roots,
			// registry and in-flight uploads in one transaction. Removing every narinfo
			// row atomically is what makes the teardown race-free: a path committed
			// afterwards is a fresh row with no queued deletion, so no drain pass can
			// sweep it, and a recommit of a torn-down path lands a new generation the
			// generation-fenced drain leaves alone. Only the R2 and edge retirement is
			// chunked off the gate.
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
				tx.delete(schema.caches).where(eq(schema.caches.name, cache)).run();
				// Drop in-flight uploads negotiated under this cache so a pending
				// commit cannot resurrect it after teardown.
				tx.delete(schema.pendingUploads)
					.where(eq(schema.pendingUploads.cache, cache))
					.run();
				tx.delete(schema.pendingAttestations)
					.where(eq(schema.pendingAttestations.cache, cache))
					.run();
			});

			// Retire a first bounded chunk now, so a cache within the cap is fully gone
			// when the call returns; a larger one leaves a marker and arms the alarm to
			// drain the rest off the gate.
			await this.drainTeardownChunk(cache, origin, limit);

			if (this.hasQueuedDeletions(cache)) {
				await this.context.ctx.storage.put(this.teardownKey(cache), origin);
				await this.context.ctx.storage.setAlarm(Date.now());
			} else {
				await this.context.ctx.storage.delete(this.teardownKey(cache));
			}
		});
	}

	// Resumes a teardown from the alarm: retires one more bounded chunk of the
	// cache's queued deletions and clears the marker once the queue is drained. The
	// optional limit is a test seam, mirroring {@link runGarbageCollection}. The
	// caller re-arms the alarm while any marker remains.
	async resumeTeardownPass(
		cache: string,
		origin: string,
		limit: number = maxPathsTornDownPerRun
	): Promise<void> {
		await this.context.ctx.blockConcurrencyWhile(async () => {
			await this.drainTeardownChunk(cache, origin, limit);

			// The queue is the source of truth: a concurrent re-teardown re-enqueues
			// idempotently and re-arms, so the marker clears exactly when nothing is
			// left to retire.
			if (!this.hasQueuedDeletions(cache)) {
				await this.context.ctx.storage.delete(this.teardownKey(cache));
			}
		});
	}
}
