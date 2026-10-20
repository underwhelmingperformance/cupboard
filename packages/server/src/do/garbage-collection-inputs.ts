import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';

import { type CacheId, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { minScanIntervalMs } from '../policy/garbage-collection.ts';

import { CacheListingProjection } from './cache-listing-projection.ts';
import { type ServerContext } from './context.ts';

const fallbackGraceRows = 64;

export interface CollectionInputState {
	readonly inputsChanged: boolean;
	readonly scanCompletedAt: IsoTimestamp | undefined;
}

/**
Whether a cache without a scan in progress needs a new scan. A cache that
needs one is `waiting` until the minimum interval since its last completed
scan has elapsed, and `due` from then on. A cache that needs no scan is
`current`.
*/
export type ScanDecision = 'due' | 'waiting' | 'current';

/**
The `garbage_collection_input` row of each cache, and the rule that decides
when a cache needs a new collection scan.

Triggers set `inputs_changed` on each write that can change which paths a
scan keeps: to narinfos, root targets, grace rows, uploads in flight, cache
closes and the grace-managed mark. Root and grace deadlines have no
trigger; a pass reads them directly. A new scan clears the flag because
it reads every input as it is then. The scan clears the flag again after
its own writes, if the flag was clear when the invocation started. Only a
deleted cache with nothing left to collect has no row, and the tenant-wide
sweep does not visit it.
*/
export class GarbageCollectionInputs {
	private readonly listingProjection: CacheListingProjection;

	constructor(private readonly context: ServerContext) {
		this.listingProjection = new CacheListingProjection(context);
	}

	private write(
		cache: ResolvedCache,
		set: Partial<
			Pick<
				typeof schema.garbageCollectionInputs.$inferInsert,
				'inputsChanged' | 'scanCompletedAt'
			>
		>
	): void {
		this.context.db
			.insert(schema.garbageCollectionInputs)
			.values({ cacheId: cache.id, ...set })
			.onConflictDoUpdate({
				target: schema.garbageCollectionInputs.cacheId,
				set
			})
			.run();
	}

	// Both lookups seek an index on the cache and the deadline. Before the
	// cache listing projection is complete, `retention_grace` has no such
	// index. Its primary key would read every grace row of the cache, and its
	// deadline index every passed deadline of the tenant. The lookup therefore
	// reads at most `fallbackGraceRows` passed deadlines of the tenant. It
	// counts the cache as due when one of them belongs to the cache, or when it
	// reads that many and none does. A wrong answer only makes the cache scan
	// once the interval allows.
	private hasPassedDeadline(cache: ResolvedCache, now: IsoTimestamp): boolean {
		const root = this.context.db
			.select({ name: schema.retentionRoots.name })
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cacheId, cache.id),
					lte(schema.retentionRoots.expiresAt, now)
				)
			)
			.limit(1)
			.get();

		if (root !== undefined) {
			return true;
		}

		if (!this.listingProjection.isReady()) {
			const passed = this.context.db.all<{ cacheId: number }>(sql`
				SELECT cache_id AS cacheId
				FROM retention_grace INDEXED BY retention_grace_retain_until_idx
				WHERE retain_until <= ${now}
				LIMIT ${fallbackGraceRows}
			`);

			return (
				passed.length === fallbackGraceRows ||
				passed.some((row) => row.cacheId === cache.id)
			);
		}

		const grace = schema.retentionGraceByDeadline;

		return (
			this.context.db
				.select({ storePathHash: grace.storePathHash })
				.from(grace)
				.where(and(eq(grace.cacheId, cache.id), lte(grace.retainUntil, now)))
				.limit(1)
				.get() !== undefined
		);
	}

	// The earliest root expiry or grace deadline of the tenant, and its cache.
	// Each lookup seeks the global index on the deadline.
	private earliestDeadline():
		{ readonly at: IsoTimestamp; readonly cacheId: CacheId } | undefined {
		const root = this.context.db
			.select({
				at: schema.retentionRoots.expiresAt,
				cacheId: schema.retentionRoots.cacheId
			})
			.from(schema.retentionRoots)
			.where(isNotNull(schema.retentionRoots.expiresAt))
			.orderBy(asc(schema.retentionRoots.expiresAt))
			.limit(1)
			.get();
		const grace = this.context.db
			.select({
				at: schema.retentionGrace.retainUntil,
				cacheId: schema.retentionGrace.cacheId
			})
			.from(schema.retentionGrace)
			.orderBy(asc(schema.retentionGrace.retainUntil))
			.limit(1)
			.get();
		const deadlines = [
			...(root?.at === undefined || root.at === null
				? []
				: [{ at: root.at, cacheId: root.cacheId }]),
			...(grace === undefined ? [] : [grace])
		];

		return deadlines.toSorted((left, right) =>
			byCodeUnit(left.at, right.at)
		)[0];
	}

	private allowedAt(scanCompletedAt: IsoTimestamp | null | undefined): number {
		return scanCompletedAt === null || scanCompletedAt === undefined
			? 0
			: Date.parse(scanCompletedAt) + minScanIntervalMs(this.context.env);
	}

	state(cache: ResolvedCache): CollectionInputState | undefined {
		const row = this.context.db
			.select({
				inputsChanged: schema.garbageCollectionInputs.inputsChanged,
				scanCompletedAt: schema.garbageCollectionInputs.scanCompletedAt
			})
			.from(schema.garbageCollectionInputs)
			.where(eq(schema.garbageCollectionInputs.cacheId, cache.id))
			.get();

		return row === undefined
			? undefined
			: {
					inputsChanged: row.inputsChanged,
					scanCompletedAt: row.scanCompletedAt ?? undefined
				};
	}

	clearChanged(cache: ResolvedCache): void {
		this.write(cache, { inputsChanged: false });
	}

	recordCompletion(cache: ResolvedCache, completedAt: IsoTimestamp): void {
		this.write(cache, { scanCompletedAt: completedAt });
	}

	/**
	Marks the caches as changed and clears their last completion time, so
	that the next pass starts a scan of each cache that has none in
	progress. When `cacheId` is omitted, marks every cache.
	*/
	requestScan(cacheId?: CacheId): void {
		this.context.db
			.update(schema.garbageCollectionInputs)
			.set({ inputsChanged: true, scanCompletedAt: sql`null` })
			.where(
				cacheId === undefined
					? undefined
					: eq(schema.garbageCollectionInputs.cacheId, cacheId)
			)
			.run();
	}

	/**
	Decides whether a cache without a scan in progress needs a new scan. It
	needs one when its inputs have changed or one of its root or grace
	deadlines has passed.
	*/
	scanDecision(cache: ResolvedCache, now: IsoTimestamp): ScanDecision {
		const state = this.state(cache);
		const requiresScan =
			state === undefined ||
			state.inputsChanged ||
			this.hasPassedDeadline(cache, now);

		if (!requiresScan) {
			return 'current';
		}

		return Date.parse(now) < this.allowedAt(state?.scanCompletedAt)
			? 'waiting'
			: 'due';
	}

	/**
	Deletes the row of a deleted cache that has nothing left to collect: no
	scan in progress, no change, and no close event, root, grace row,
	narinfo or pending upload. Each condition is one index seek. The
	tenant-wide sweep visits only the caches that have a row. Every input
	trigger recreates a missing row as changed, so a forgotten cache that
	receives a write, or becomes live again, is visited again.
	*/
	forgetIfDeleted(cache: ResolvedCache): void {
		const deleted = this.context.db
			.select({ deletedAt: schema.cacheIdentities.deletedAt })
			.from(schema.cacheIdentities)
			.where(
				and(
					eq(schema.cacheIdentities.id, cache.id),
					isNotNull(schema.cacheIdentities.deletedAt)
				)
			)
			.get();

		if (deleted === undefined) {
			return;
		}

		this.context.db.run(sql`
			DELETE FROM garbage_collection_input
			WHERE cache_id = ${cache.id}
				AND NOT inputs_changed
				AND NOT EXISTS (SELECT 1 FROM garbage_collection_scan WHERE cache_id = ${cache.id})
				AND NOT EXISTS (SELECT 1 FROM cache_close_event WHERE cache_id = ${cache.id})
				AND NOT EXISTS (SELECT 1 FROM retention_root WHERE cache_id = ${cache.id})
				AND NOT EXISTS (SELECT 1 FROM retention_grace WHERE cache_id = ${cache.id})
				AND NOT EXISTS (SELECT 1 FROM narinfo WHERE cache_id = ${cache.id})
				AND NOT EXISTS (SELECT 1 FROM pending_upload WHERE cache_id = ${cache.id})
		`);
	}

	scanAllowedAt(cache: ResolvedCache): IsoTimestamp {
		const allowedAt = this.allowedAt(this.state(cache)?.scanCompletedAt);

		return isoTimestamp(new Date(allowedAt));
	}

	/**
	When a scan of some cache can next start, for the maintenance wake.
	
	This is the earlier of two times. The first is the end of the interval
	of the changed cache that was scanned longest ago, found through
	`garbage_collection_input_changed_idx`. The second is the later of the
	tenant's earliest root or grace deadline and the end of the interval of
	the cache that has that deadline.
	
	A cache with a later deadline can become scannable before the interval
	of the cache with the earliest deadline ends, so this time can be up to
	one interval late. It is never before a scan of some cache is allowed.
	The cost does not depend on the number of caches.
	*/
	nextScanAt(): IsoTimestamp | undefined {
		const changed = this.context.db
			.select({
				scanCompletedAt: schema.garbageCollectionInputs.scanCompletedAt
			})
			.from(schema.garbageCollectionInputs)
			.where(eq(schema.garbageCollectionInputs.inputsChanged, true))
			.orderBy(asc(schema.garbageCollectionInputs.scanCompletedAt))
			.limit(1)
			.get();
		const deadline = this.earliestDeadline();
		const owner =
			deadline === undefined
				? undefined
				: this.context.db
						.select({
							scanCompletedAt: schema.garbageCollectionInputs.scanCompletedAt
						})
						.from(schema.garbageCollectionInputs)
						.where(eq(schema.garbageCollectionInputs.cacheId, deadline.cacheId))
						.get();
		const candidates = [
			...(changed === undefined
				? []
				: [this.allowedAt(changed.scanCompletedAt)]),
			...(deadline === undefined
				? []
				: [
						Math.max(
							Date.parse(deadline.at),
							this.allowedAt(owner?.scanCompletedAt)
						)
					])
		];

		return candidates.length === 0
			? undefined
			: isoTimestamp(new Date(Math.min(...candidates)));
	}
}
