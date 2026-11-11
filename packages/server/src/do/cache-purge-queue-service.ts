import type {
	NixSha256HashString,
	StorePathHash
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { z } from 'zod';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	legacyNarCacheTag,
	narCacheTag,
	narInfoCacheTag
} from '../http/cache-tags.ts';
import { narCacheTtlSeconds, narInfoCacheTtlSeconds } from '../http/http.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import { chunk } from './bulk.ts';
import { CachePurgeBackoff } from './cache-purge-backoff.ts';
import { CachePurgeRetryPolicy } from './cache-purge-retry.ts';
import { type ServerContext, tagsPerPurgeRequest } from './context.ts';
import { jsonValueList } from './json-list.ts';

// Do not bound the length: see `purgeEntriesSchema` in
// `signing-keys-service.ts`. A row is never written empty.
const tagsSchema = z.array(z.string()).min(1);

const purgeableCacheToken: unique symbol = Symbol('PurgeableCache');

/**
How soon the queue sends a purge. The queue sends every queued `urgent`
purge before any `routine` one, and the oldest first within each priority.
Use `urgent` for a change that a user requested and expects to see at once,
such as an explicit deletion or a read revocation.
*/
export type CachePurgePriority = 'urgent' | 'routine';

// The values of the `priority` column. Ascending order is sending order, so
// the queue reads both priorities through one index.
const priorityValues: Readonly<Record<CachePurgePriority, number>> = {
	urgent: 0,
	routine: 1
};

// The most rows that the query for one request returns after its first row.
// The query also reads past the rows with a recorded failure count that it
// skips, so a run reads these rows as well.
const rowsMergedAfterHead = tagsPerPurgeRequest;

const sendingOrder = [
	schema.cachePurgeContinuations.priority,
	schema.cachePurgeContinuations.createdAt
];

/**
Persists cache-tag purges so failed requests can be retried.
*/
export class CachePurgeQueueService {
	private readonly backoff: CachePurgeBackoff;

	constructor(
		private readonly context: ServerContext,
		retryPolicy: CachePurgeRetryPolicy = new CachePurgeRetryPolicy()
	) {
		this.backoff = new CachePurgeBackoff(
			context.ctx.storage,
			context.db,
			retryPolicy
		);
	}

	private checked(
		cache: ResolvedCache | PurgeableCache
	): PurgeableCache | undefined {
		return cache instanceof PurgeableCache ? cache : this.purgeableCache(cache);
	}

	// A queued purge is abandoned once the response it invalidates has expired
	// on its own, so each kind of tag carries the lifetime of the responses it
	// covers.
	private async enqueueTags(
		tags: readonly string[],
		ttlSeconds: number,
		priority: CachePurgePriority
	): Promise<void> {
		const createdAt = isoTimestamp(new Date());
		const expiresAt = isoTimestamp(new Date(Date.now() + ttlSeconds * 1000));

		this.context.db.transaction((tx) => {
			for (const batch of chunk(tags, tagsPerPurgeRequest)) {
				tx.insert(schema.cachePurgeContinuations)
					.values({
						id: crypto.randomUUID(),
						kind: 'mutation',
						entriesJson: JSON.stringify(batch),
						createdAt,
						expiresAt,
						priority: priorityValues[priority]
					})
					.run();
			}
		});

		await this.context.ctx.storage.setAlarm(Date.now());
	}

	private head(): CachePurgeContinuation | undefined {
		return this.context.db
			.select()
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'mutation'))
			.orderBy(...sendingOrder)
			.get();
	}

	// Starts from `head` and takes the rows after it in the same order, as long
	// as their distinct tags fit in one request. A row whose tags are already
	// in the request adds none and joins even a full request, so the tag limit
	// does not bound the rows; `rowsMergedAfterHead` does.
	//
	// Only the head of a failed request records the failure, and a row's
	// failure could be specific to that row. A request therefore never mixes a
	// row that could fail it with a head that the failure would delay:
	//
	// - A row with a recorded failure count, including a count that it took
	//   over from an expired row, joins no other row's request.
	// - A head with a recorded failure count is sent alone, so a row that
	//   joined it cannot keep its retries failing.
	// - Only rows of the head's priority join it, so a routine row cannot back
	//   off an urgent head.
	private nextRequest(head: CachePurgeContinuation): CachePurgeRequest {
		const ids = [head.id];
		let tags = new Set(
			tagsSchema.parse(JSON.parse(head.entriesJson) as unknown)
		);

		if (head.failedAttempts > 0) {
			return { ids, tags: [...tags] };
		}

		const table = schema.cachePurgeContinuations;
		const rows = this.context.db
			.select({ id: table.id, entriesJson: table.entriesJson })
			.from(table)
			.where(
				and(
					eq(table.kind, 'mutation'),
					eq(table.priority, head.priority),
					ne(table.id, head.id),
					eq(table.failedAttempts, 0)
				)
			)
			.orderBy(...sendingOrder)
			.limit(rowsMergedAfterHead)
			.all();

		for (const row of rows) {
			const merged = new Set([
				...tags,
				...tagsSchema.parse(JSON.parse(row.entriesJson) as unknown)
			]);

			if (merged.size > tagsPerPurgeRequest) {
				break;
			}

			ids.push(row.id);
			tags = merged;
		}

		return { ids, tags: [...tags] };
	}

	// A row that expires while it waits passes its retry time and failure count
	// to the next row. Otherwise each expiry during a run of failures would send
	// the next row's purge at once.
	private removeExpired(continuation: CachePurgeContinuation): void {
		this.context.db.transaction((tx) => {
			tx.delete(schema.cachePurgeContinuations)
				.where(eq(schema.cachePurgeContinuations.id, continuation.id))
				.run();

			if (continuation.failedAttempts === 0) {
				return;
			}

			const next = tx
				.select({ id: schema.cachePurgeContinuations.id })
				.from(schema.cachePurgeContinuations)
				.where(eq(schema.cachePurgeContinuations.kind, 'mutation'))
				.orderBy(...sendingOrder)
				.get();

			if (next === undefined) {
				return;
			}

			tx.update(schema.cachePurgeContinuations)
				.set({
					nextAttemptAt: continuation.nextAttemptAt,
					failedAttempts: continuation.failedAttempts
				})
				.where(eq(schema.cachePurgeContinuations.id, next.id))
				.run();
		});
	}

	private async continueWithNext(): Promise<void> {
		const more = this.context.db
			.select({ id: schema.cachePurgeContinuations.id })
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'mutation'))
			.get();

		if (more !== undefined) {
			await this.context.ctx.storage.setAlarm(Date.now());
		}
	}

	/**
	Returns `cache` as a {@link PurgeableCache} when Workers Cache can contain
	its responses, so that a purge of its tags can invalidate something, and
	undefined otherwise. Workers Cache stores no response of a private cache.
	Reads the access from storage, not from `cache`: the caller's copy can
	predate a change to public, and skipping a purge would then leave a stale
	public response.
	*/
	purgeableCache(cache: ResolvedCache): PurgeableCache | undefined {
		const stored = this.context.cacheRepository.resolvedForId(cache.id);

		return stored.access === 'private'
			? undefined
			: new PurgeableCache(purgeableCacheToken, stored);
	}

	/**
	Queues exact narinfo invalidations and schedules the first attempt. Queues
	nothing while the cache is private, because Workers Cache stores no private
	response.
	*/
	async enqueueNarInfos(
		cache: ResolvedCache | PurgeableCache,
		storePathHashes: readonly StorePathHash[],
		priority: CachePurgePriority = 'routine'
	): Promise<void> {
		if (storePathHashes.length === 0) {
			return;
		}

		const purgeable = this.checked(cache);

		if (purgeable === undefined) {
			return;
		}

		const tenant = this.context.requireTenant();
		const { scope } = purgeable.cache;

		await this.enqueueTags(
			storePathHashes.map((storePathHash) =>
				narInfoCacheTag(tenant, scope, storePathHash)
			),
			narInfoCacheTtlSeconds,
			priority
		);
	}

	/**
	Queues the invalidation of this cache's responses for the NAR hashes and
	schedules the first attempt. Call this once the cache stops referencing a
	hash, so Workers Cache cannot serve a response after the exact reference
	check would refuse the read. Queues nothing while the cache is private.
	*/
	async enqueueNars(
		cache: ResolvedCache | PurgeableCache,
		narHashes: readonly NixSha256HashString[],
		priority: CachePurgePriority = 'routine'
	): Promise<void> {
		if (narHashes.length === 0) {
			return;
		}

		const purgeable = this.checked(cache);

		if (purgeable === undefined) {
			return;
		}

		const tenant = this.context.requireTenant();
		const { scope } = purgeable.cache;

		await this.enqueueTags(
			narHashes.flatMap((narHash) => [
				narCacheTag(tenant, scope, narHash),
				legacyNarCacheTag(tenant, narHash)
			]),
			narCacheTtlSeconds,
			priority
		);
	}

	/**
	Sends one purge request for the first queued rows in sending order (see
	{@link CachePurgePriority}), with as many rows as fit in the platform's tag
	limit, and deletes those rows when the request succeeds. Rows queued while
	the request is in flight remain queued. A failed purge remains queued until
	its TTL expires. After a failure, {@link CachePurgeBackoff} decides the
	earliest time for the next attempt, and the queue sends nothing before that
	time. The alarm is armed for it.
	*/
	async runOnce(): Promise<void> {
		const continuation = this.head();

		if (continuation === undefined) {
			return;
		}

		const now = Date.now();
		const expiresAt = Date.parse(continuation.expiresAt);

		if (now >= expiresAt) {
			this.removeExpired(continuation);
			await this.backoff.forgetWhenIdle();
			await this.continueWithNext();

			return;
		}

		const dueAt = await this.backoff.dueAt(continuation, now);

		if (dueAt > now) {
			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				Math.min(dueAt, expiresAt)
			);

			return;
		}

		const request = this.nextRequest(continuation);

		try {
			await this.context.purgeCacheTags(request.tags);
		} catch (error) {
			const failedAt = Date.now();
			const retry = await this.backoff.recordFailure(
				error,
				continuation,
				failedAt
			);
			const message = error instanceof Error ? error.message : String(error);

			this.context.db
				.update(schema.cachePurgeContinuations)
				.set({
					lastAttemptAt: isoTimestamp(new Date(failedAt)),
					lastError: message,
					...retry
				})
				.where(eq(schema.cachePurgeContinuations.id, continuation.id))
				.run();
			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				Math.min(await this.backoff.dueAt(retry, failedAt), expiresAt)
			);

			return;
		}

		await this.backoff.recordSuccess();
		this.context.db
			.delete(schema.cachePurgeContinuations)
			.where(
				inArray(schema.cachePurgeContinuations.id, jsonValueList(request.ids))
			)
			.run();
		await this.continueWithNext();
	}
}

type CachePurgeContinuation =
	typeof schema.cachePurgeContinuations.$inferSelect;

/**
A cache that {@link CachePurgeQueueService.purgeableCache} found not to be
private. The enqueue methods take it in place of a `ResolvedCache` and do not
read the access again. The constructor requires a value private to this
module, so no other code can create one.
*/
export class PurgeableCache {
	constructor(
		_token: typeof purgeableCacheToken,
		readonly cache: ResolvedCache
	) {}
}

// One purge request: the distinct tags of the queued rows, and the IDs of
// those rows.
interface CachePurgeRequest {
	readonly ids: readonly string[];
	readonly tags: readonly string[];
}
