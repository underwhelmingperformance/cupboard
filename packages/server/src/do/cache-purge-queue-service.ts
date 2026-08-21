import type { StoredCache, StorePathHash } from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import { narInfoCacheTag } from '../http/cache-tags.ts';
import { narInfoCacheTtlSeconds } from '../http/http.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import { chunk } from './bulk.ts';
import { type ServerContext } from './context.ts';

const cachePurgeBatchSize = 100;
const cachePurgeRetryMs = 30_000;
const tagsSchema = z.array(z.string()).min(1).max(cachePurgeBatchSize);

/**
Persists and runs global Workers Cache purges for updated narinfos.
*/
export class CachePurgeQueueService {
	constructor(private readonly context: ServerContext) {}

	/**
	Queues exact narinfo invalidations and schedules their continuation.
	*/
	async enqueueNarInfos(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): Promise<void> {
		if (storePathHashes.length === 0) {
			return;
		}

		const tenant = this.context.requireTenant();
		const createdAt = isoTimestamp(new Date());
		const expiresAt = isoTimestamp(
			new Date(Date.now() + narInfoCacheTtlSeconds * 1000)
		);

		this.context.db.transaction((tx) => {
			for (const batch of chunk(storePathHashes, cachePurgeBatchSize)) {
				tx.insert(schema.cachePurgeContinuations)
					.values({
						id: crypto.randomUUID(),
						kind: 'mutation',
						entriesJson: JSON.stringify(
							batch.map((storePathHash) =>
								narInfoCacheTag(tenant, cache, storePathHash)
							)
						),
						createdAt,
						expiresAt
					})
					.run();
			}
		});

		await this.context.ctx.storage.setAlarm(Date.now());
	}

	/**
	Runs one queued invalidation, retrying until purge succeeds or its TTL ends.
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
						Date.now() + cachePurgeRetryMs
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
