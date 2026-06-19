import { CacheInfo } from '@cupboard/nix/cache-info';
import {
	type CacheName,
	type CachePriority,
	cachePrioritySchema,
	DEFAULT_CACHE
} from '@cupboard/nix/scalars';
import {
	type CacheListResponse,
	type CacheRemoveResponse,
	type CacheSummary
} from '@cupboard/protocol/caches';
import { and, count, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { CacheNotEmptyError } from '../errors.ts';
import { narObjectKey } from '../http/http.ts';

import { compareStrings, type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';

export class CacheAdminService {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService
	) {}

	/** Renders a cache's nix-cache-info body from its registry priority. */
	cacheInfoBody(cache: string): string {
		const row = this.context.db
			.select({ priority: schema.caches.priority })
			.from(schema.caches)
			.where(eq(schema.caches.name, cache))
			.get();
		const info = new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.wantMassQuery,
			row?.priority ?? CacheInfo.default.priority
		);

		return info.render();
	}

	listCaches(): CacheListResponse {
		const registered = this.context.db.select().from(schema.caches).all();
		const caches = registered
			.map((row) => this.cacheSummary(row.name, row.priority))
			.toSorted((left, right) => compareStrings(left.name, right.name));

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
		force: boolean,
		origin: string
	): Promise<CacheRemoveResponse> {
		const committedCount = this.cacheStorePathCount(cache);

		if (committedCount > 0 && !force) {
			throw new CacheNotEmptyError(cache);
		}

		const registered =
			this.context.db
				.select()
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get() !== undefined;
		const storePathsRemoved = await this.tearDownCache(cache, origin);

		return {
			name: cache,
			removed: registered || committedCount > 0,
			storePathsRemoved
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

	// Drops a named cache: removes its narinfo rows (row-first, queuing each for
	// edge retirement), its roots, and the registry entry, then flushes the deletion
	// queue to retire the edges. The reaper later collects the now-unreferenced
	// shared blobs. Returns the number of store paths removed.
	tearDownCache(cache: string, origin: string): Promise<number> {
		return this.context.ctx.blockConcurrencyWhile(async () => {
			const timestamp = new Date();
			const now = timestamp.toISOString();
			const committed = this.context.db
				.select({
					storePathHash: schema.narInfos.storePathHash,
					narHash: schema.narInfos.narHash,
					generation: schema.narInfos.generation
				})
				.from(schema.narInfos)
				.where(eq(schema.narInfos.cache, cache))
				.all();
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

			for (const upload of pending) {
				if (upload.r2Key !== narObjectKey(upload.narHash)) {
					await this.context.env.BLOBS.delete(upload.r2Key);
				}
			}

			for (const upload of pendingAttestations) {
				await this.context.env.BLOBS.delete(upload.r2Key);
			}

			this.context.db.transaction((tx) => {
				for (const path of committed) {
					tx.delete(schema.narInfos)
						.where(
							and(
								eq(schema.narInfos.cache, cache),
								eq(schema.narInfos.storePathHash, path.storePathHash)
							)
						)
						.run();
					this.deletionQueue.enqueueNarInfoDeletion(
						tx,
						cache,
						path.storePathHash,
						path.narHash,
						path.generation,
						now
					);
				}

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

			await this.deletionQueue.flushQueuedNarInfoDeletions(origin);

			return committed.length;
		});
	}
}
