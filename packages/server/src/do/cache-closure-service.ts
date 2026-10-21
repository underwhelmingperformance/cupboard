import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, gt, lt, type SQL, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { CacheClosedError } from '../errors.ts';

import type { ServerContext } from './context.ts';

export class CacheClosureService {
	constructor(private readonly context: ServerContext) {}

	assertWritable(cache: ResolvedCache): void {
		const retirement = this.context.db
			.select({ startedAt: schema.managedCacheRetirements.retirementStartedAt })
			.from(schema.managedCacheRetirements)
			.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
			.get();
		if (retirement?.startedAt !== undefined && retirement.startedAt !== null) {
			throw new CacheClosedError(cache.scope);
		}
	}

	epoch(cache: ResolvedCache): number {
		return (
			this.context.db
				.select({ epoch: schema.cacheIdentities.retentionEpoch })
				.from(schema.cacheIdentities)
				.where(eq(schema.cacheIdentities.id, cache.id))
				.get()?.epoch ?? 0
		);
	}

	firstClose(
		cache: ResolvedCache,
		epoch: number
	): typeof schema.cacheCloseEvents.$inferSelect | undefined {
		return this.context.db
			.select()
			.from(schema.cacheCloseEvents)
			.where(
				and(
					eq(schema.cacheCloseEvents.cacheId, cache.id),
					gt(schema.cacheCloseEvents.epoch, epoch)
				)
			)
			.orderBy(asc(schema.cacheCloseEvents.epoch))
			.limit(1)
			.get();
	}

	effectiveRootExpiry(): SQL<IsoTimestamp | null> {
		return sql`CASE WHEN (SELECT closed_at FROM cache_close_event WHERE cache_id = retention_root.cache_id AND epoch > retention_root.retention_epoch ORDER BY epoch LIMIT 1) IS NULL
   THEN retention_root.expires_at
   ELSE min(coalesce(retention_root.expires_at, '9999'), (SELECT closed_at FROM cache_close_event WHERE cache_id = retention_root.cache_id AND epoch > retention_root.retention_epoch ORDER BY epoch LIMIT 1)) END`;
	}

	materialiseRoots(cache: ResolvedCache, limit: number): boolean {
		const epoch = this.epoch(cache);
		const candidates = this.context.db
			.select()
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cacheId, cache.id),
					lt(schema.retentionRoots.closeAppliedEpoch, epoch)
				)
			)
			.orderBy(
				asc(schema.retentionRoots.closeAppliedEpoch),
				asc(schema.retentionRoots.name)
			)
			.limit(limit + 1)
			.all();
		for (const root of candidates.slice(0, limit)) {
			const close = this.firstClose(cache, root.retentionEpoch);
			const expiresAt =
				close !== undefined &&
				(root.expiresAt === null || root.expiresAt > close.closedAt)
					? close.closedAt
					: root.expiresAt;
			this.context.db
				.update(schema.retentionRoots)
				.set({
					expiresAt,
					closeAppliedEpoch: epoch,
					...(close?.closedAt === expiresAt && {
						closeGraceUntil: close.graceUntil
					})
				})
				.where(
					and(
						eq(schema.retentionRoots.cacheId, cache.id),
						eq(schema.retentionRoots.name, root.name)
					)
				)
				.run();
		}
		return candidates.length > limit;
	}

	restartHistory(cache: ResolvedCache): void {
		this.context.db
			.update(schema.cacheIdentities)
			.set({ closeHistoryCursor: 0 })
			.where(
				and(
					eq(schema.cacheIdentities.id, cache.id),
					gt(schema.cacheIdentities.closeHistoryCursor, 0)
				)
			)
			.run();
	}

	/**
	Deletes the close events on one page that no root or pending upload of an
	older retention epoch needs any more. `close_history_cursor` keeps the
	position between calls, and a short page resets it to the first event.
	Returns true after a full page, when more events may follow. A caller
	that repeats the call until it returns false therefore visits every event
	once, and stops even when every event is still needed.
	*/
	cleanHistory(cache: ResolvedCache, limit: number): boolean {
		const cursor =
			this.context.db
				.select({ cursor: schema.cacheIdentities.closeHistoryCursor })
				.from(schema.cacheIdentities)
				.where(eq(schema.cacheIdentities.id, cache.id))
				.get()?.cursor ?? 0;
		const page = this.context.db
			.select({ epoch: schema.cacheCloseEvents.epoch })
			.from(schema.cacheCloseEvents)
			.where(
				and(
					eq(schema.cacheCloseEvents.cacheId, cache.id),
					gt(schema.cacheCloseEvents.epoch, cursor)
				)
			)
			.orderBy(asc(schema.cacheCloseEvents.epoch))
			.limit(limit)
			.all();
		for (const event of page) {
			this.context.db
				.run(sql`DELETE FROM cache_close_event WHERE cache_id = ${cache.id} AND epoch = ${event.epoch}
    AND NOT EXISTS (SELECT 1 FROM retention_root WHERE cache_id = ${cache.id}
     AND retention_epoch >= coalesce((SELECT epoch FROM cache_close_event WHERE cache_id = ${cache.id} AND epoch < ${event.epoch} ORDER BY epoch DESC LIMIT 1), 0)
     AND retention_epoch < ${event.epoch})
    AND NOT EXISTS (SELECT 1 FROM pending_upload WHERE cache_id = ${cache.id}
     AND retention_epoch >= coalesce((SELECT epoch FROM cache_close_event WHERE cache_id = ${cache.id} AND epoch < ${event.epoch} ORDER BY epoch DESC LIMIT 1), 0)
     AND retention_epoch < ${event.epoch})`);
		}
		const hasMore = page.length === limit;
		const next = hasMore ? (page.at(-1)?.epoch ?? 0) : 0;

		if (next !== cursor) {
			this.context.db
				.update(schema.cacheIdentities)
				.set({ closeHistoryCursor: next })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();
		}

		return hasMore;
	}
}
