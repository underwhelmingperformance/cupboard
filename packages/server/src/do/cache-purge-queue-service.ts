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

// The most rows that the query for one request returns after its first row,
// so a run reads a bounded number of rows however long the queue is.
const rowsMergedAfterHead = tagsPerPurgeRequest;

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
			for (const batch of chunk(tags, tagsPerPurgeRequest)) {
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

	private head(): CachePurgeContinuation | undefined {
		return this.context.db
			.select()
			.from(schema.cachePurgeContinuations)
			.where(eq(schema.cachePurgeContinuations.kind, 'mutation'))
			.orderBy(schema.cachePurgeContinuations.createdAt)
			.get();
	}

	// Starts from `head` and takes the rows after it in the same order, as long
	// as their distinct tags fit in one request. A row whose tags are already
	// in the request adds none and joins even a full request, so the tag limit
	// does not bound the rows; `rowsMergedAfterHead` does.
	private nextRequest(head: CachePurgeContinuation): CachePurgeRequest {
		const ids = [head.id];
		let tags = new Set(
			tagsSchema.parse(JSON.parse(head.entriesJson) as unknown)
		);
		const rows = this.context.db
			.select({
				id: schema.cachePurgeContinuations.id,
				entriesJson: schema.cachePurgeContinuations.entriesJson
			})
			.from(schema.cachePurgeContinuations)
			.where(
				and(
					eq(schema.cachePurgeContinuations.kind, 'mutation'),
					ne(schema.cachePurgeContinuations.id, head.id)
				)
			)
			.orderBy(schema.cachePurgeContinuations.createdAt)
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
				.orderBy(schema.cachePurgeContinuations.createdAt)
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
	Queues the invalidation of this cache's responses for the NAR hashes and
	schedules the first attempt. Call this once the cache stops referencing a
	hash, so Workers Cache cannot serve a response after the exact reference
	check would refuse the read.
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
			narHashes.flatMap((narHash) => [
				narCacheTag(tenant, cache.scope, narHash),
				legacyNarCacheTag(tenant, narHash)
			]),
			narCacheTtlSeconds
		);
	}

	/**
	Sends one purge request for the oldest queued rows, with as many rows as
	fit in the platform's tag limit, and deletes those rows when the request
	succeeds. Rows queued while the request is in flight remain queued. A
	failed purge remains queued until its TTL expires. After a failure,
	{@link CachePurgeBackoff} decides the earliest time for the next attempt,
	and the queue sends nothing before that time. The alarm is armed for it.
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

// One purge request: the distinct tags of the queued rows, and the IDs of
// those rows.
interface CachePurgeRequest {
	readonly ids: readonly string[];
	readonly tags: readonly string[];
}
