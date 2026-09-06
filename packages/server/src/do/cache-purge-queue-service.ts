import type {
	NixSha256HashString,
	StorePathHash
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { narCacheTag, narInfoCacheTag } from '../http/cache-tags.ts';
import { narCacheTtlSeconds, narInfoCacheTtlSeconds } from '../http/http.ts';

import { armAlarmNoLaterThan, noProgressRetryMs } from './alarm.ts';
import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';

const cachePurgeBatchSize = 100;
const tagsSchema = z.array(z.string()).min(1).max(cachePurgeBatchSize);

/**
Persists cache-tag purges so failed requests can be retried.
*/
export class CachePurgeQueueService {
	constructor(private readonly context: ServerContext) {}

	// A queued purge is abandoned once the response it invalidates has expired
	// on its own, so each kind of tag carries the lifetime of the responses it
	// covers.
	private async enqueueTags(
		tags: readonly string[],
		ttlSeconds: number
	): Promise<void> {
		if (tags.length === 0) {
			return;
		}

		const createdAt = isoTimestamp(new Date());
		const expiresAt = isoTimestamp(new Date(Date.now() + ttlSeconds * 1000));

		this.context.db.transaction((tx) => {
			for (const batch of chunk(tags, cachePurgeBatchSize)) {
				tx.insert(schema.cachePurgeContinuations)
					.values({
						id: crypto.randomUUID(),
						kind: 'mutation',
						entriesJson: JSON.stringify(batch),
						createdAt,
						expiresAt
					})
					.run();
			}
		});

		await this.context.ctx.storage.setAlarm(Date.now());
	}

	/**
	Queues exact narinfo invalidations and schedules the first attempt.
	*/
	async enqueueNarInfos(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<void> {
		if (storePathHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();

		await this.enqueueTags(
			storePathHashes.map((storePathHash) =>
				narInfoCacheTag(tenant, cache.scope, storePathHash)
			),
			narInfoCacheTtlSeconds
		);
	}

	/**
	 * Queues the invalidation of this cache's responses for the NAR hashes and
	 * schedules the first attempt. Call this once the cache stops referencing a
	 * hash, so Workers Cache cannot serve a response after the exact reference
	 * check would refuse the read.
	 */
	async enqueueNars(
		cache: ResolvedCache,
		narHashes: readonly NixSha256HashString[]
	): Promise<void> {
		if (narHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();

		await this.enqueueTags(
			narHashes.map((narHash) => narCacheTag(tenant, cache.scope, narHash)),
			narCacheTtlSeconds
		);
	}

	/**
	 * Runs one queued invalidation. A failed purge remains queued until its TTL
	 * expires.
	 */
	async runOnce(): Promise<void> {
		const continuation = this.context.db
			.select()
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'mutation'))
			.orderBy(schema.cachePurgeContinuations.createdAt)
			.get();

		if (continuation === undefined) {
			return;
		}

		const tags = tagsSchema.parse(
			JSON.parse(continuation.entriesJson) as unknown
		);
		const isExpired = Date.now() >= Date.parse(continuation.expiresAt);

		if (!isExpired) {
			try {
				await this.context.purgeCacheTags(tags);
			} catch (error) {
				const attemptedAt = isoTimestamp(new Date());
				const message = error instanceof Error ? error.message : String(error);

				this.context.db
					.update(schema.cachePurgeContinuations)
					.set({ lastAttemptAt: attemptedAt, lastError: message })
					.where(eq(schema.cachePurgeContinuations.id, continuation.id))
					.run();
				await armAlarmNoLaterThan(
					this.context.ctx.storage,
					Math.min(
						Date.parse(continuation.expiresAt),
						Date.now() + noProgressRetryMs
					)
				);

				return;
			}
		}

		this.context.db
			.delete(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.id, continuation.id))
			.run();

		const more = this.context.db
			.select({ id: schema.cachePurgeContinuations.id })
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'mutation'))
			.get();

		if (more !== undefined) {
			await this.context.ctx.storage.setAlarm(Date.now());
		}
	}
}
