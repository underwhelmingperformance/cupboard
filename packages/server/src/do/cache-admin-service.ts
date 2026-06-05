import { CacheInfo } from '@cupboard/nix/cache-info';
import { cacheNameSchema, DEFAULT_CACHE } from '@cupboard/nix/scalars';
import {
	type CacheListResponse,
	cachePutBodySchema,
	type CacheRemoveResponse,
	type CacheSummary
} from '@cupboard/protocol/caches';
import { and, count, eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { CacheNotEmptyError } from '../errors.ts';
import { narObjectKey, textResponse } from '../http/http.ts';
import { parseRequestBody, parseRequestValue } from '../http/parse.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';

export class CacheAdminService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly deletionQueue: DeletionQueueService
	) {}

	async handleCacheInfo(
		request: Request,
		cacheName: string
	): Promise<Response> {
		const cache = parseRequestValue(cacheNameSchema, cacheName);
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

		return textResponse(request, info.render(), {
			'content-type': 'text/x-nix-cache-info; charset=utf-8'
		});
	}

	async handleListCaches(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const registered = this.context.db.select().from(schema.caches).all();
		const caches = registered
			.map((row) => this.cacheSummary(row.name, row.priority))
			.toSorted((left, right) => (left.name > right.name ? 1 : -1));

		return Response.json({ caches } satisfies CacheListResponse);
	}

	async handlePutCache(request: Request, cacheName: string): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const cache = parseRequestValue(cacheNameSchema, cacheName);
		const body = await parseRequestBody(cachePutBodySchema, request);

		this.context.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority: body.priority,
				createdAt: new Date().toISOString()
			})
			.onConflictDoUpdate({
				target: schema.caches.name,
				set: { priority: body.priority }
			})
			.run();

		return Response.json(
			this.cacheSummary(cache, body.priority) satisfies CacheSummary
		);
	}

	async handleRemoveCache(
		request: Request,
		cacheName: string
	): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const cache = parseRequestValue(cacheNameSchema, cacheName);
		const url = new URL(request.url);
		const force = url.searchParams.get('force') === 'true';
		const committedCount = this.cacheStorePathCount(cache);
		const registered =
			this.context.db
				.select()
				.from(schema.caches)
				.where(eq(schema.caches.name, cache))
				.get() !== undefined;

		if (committedCount > 0 && !force) {
			throw new CacheNotEmptyError(cache);
		}

		const storePathsRemoved = await this.tearDownCache(cache, url.origin);

		return Response.json({
			name: cache,
			removed: registered || committedCount > 0,
			storePathsRemoved
		} satisfies CacheRemoveResponse);
	}

	cacheStorePathCount(cache: string): number {
		const result = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cache, cache))
			.get();

		return result?.count ?? 0;
	}

	cacheSummary(cache: string, priority: number): CacheSummary {
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

		this.context.db
			.insert(schema.caches)
			.values({
				name: cache,
				priority: CacheInfo.default.priority,
				createdAt: new Date().toISOString()
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
			const now = new Date().toISOString();
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

			for (const upload of pending) {
				if (upload.r2Key !== narObjectKey(upload.narHash)) {
					await this.context.env.BLOBS.delete(upload.r2Key);
				}
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
			});

			await this.deletionQueue.flushQueuedNarInfoDeletions(origin);

			return committed.length;
		});
	}
}
