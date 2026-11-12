import { type StorePathHash } from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, inArray, isNull, notExists } from 'drizzle-orm';

import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import { CacheClosureService } from './cache-closure-service.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';
import { jsonValueList } from './json-list.ts';
import {
	liveRootTargets,
	type RootIncarnationKey
} from './live-root-targets.ts';
import { type RetentionService } from './retention-service.ts';
import { isRowBudgetExhausted } from './row-budget.ts';

// The most target rows that one step of the drain reads, as in a collection
// scan's phases.
const pageSize = 128;

const releases = schema.retentionRootReleases;
const targets = schema.retentionRootTargets;

type Release = typeof releases.$inferSelect;

/**
The grace deadline for the paths of a release, decided when the root
releases them. A closed-root release grants its deadline only to narinfo
rows of the root's retention epoch or an earlier one.
*/
export interface ReleaseGrace {
	readonly retainUntil: IsoTimestamp | undefined;
	readonly closeRetentionEpoch: number | undefined;
}

const noGrace: ReleaseGrace = {
	retainUntil: undefined,
	closeRetentionEpoch: undefined
};

/**
What one run of the drain did.
*/
export interface ReleaseDrainProgress {
	readonly targetsReleased: number;
	// Whether a release of the drained scope remains.
	readonly hasMore: boolean;
}

/**
Records the incarnations that roots release, and deletes their target rows
in pages.

A replacement, a removal or an expiry of a root records one release row and
leaves the released target rows in place, so its cost does not depend on
the number of targets. Those rows remain collection seeds until the drain
deletes them. Each page of the drain grants the release's deadline to the
paths of the page in the transaction that deletes their target rows, so a
released path has a seed or a deadline until the deadline passes.
*/
export class RootReleaseService {
	constructor(
		private readonly context: ServerContext,
		private readonly retention: RetentionService
	) {}

	private nextRelease(cache: ResolvedCache | undefined): Release | undefined {
		const teardown = this.context.db
			.select({ cacheId: schema.cacheTeardowns.cacheId })
			.from(schema.cacheTeardowns)
			.where(eq(schema.cacheTeardowns.cacheId, releases.cacheId));

		return this.context.db
			.select()
			.from(releases)
			.where(
				cache === undefined
					? notExists(teardown)
					: eq(releases.cacheId, cache.id)
			)
			.orderBy(asc(releases.id))
			.limit(1)
			.get();
	}

	// One page of a release's target rows, read through the index of the
	// released incarnation's rows, so every row read belongs to the release.
	// The step deletes every row of the page, and a row that a root takes back
	// leaves the incarnation, so the next page starts at the first remaining
	// row.
	private page(
		reader: SchemaWriter,
		release: Release
	): readonly StorePathHash[] {
		const rows =
			release.incarnation === null
				? and(
						eq(targets.cacheId, release.cacheId),
						eq(targets.rootName, release.rootName),
						isNull(targets.incarnation)
					)
				: eq(targets.incarnation, release.incarnation);

		return reader
			.select({ storePathHash: targets.storePathHash })
			.from(targets)
			.where(rows)
			.limit(pageSize)
			.all()
			.map((row) => row.storePathHash);
	}

	// Grants the deadline of a release to one page of its paths and deletes
	// their target rows in one transaction. A short page ends the release.
	private step(release: Release): number {
		const cache = this.context.cacheRepository.resolvedForId(release.cacheId);

		return this.context.db.transaction((tx) => {
			const released = this.page(tx, release);

			if (released.length > 0) {
				if (release.retainUntil !== null) {
					this.retention.extendReleasedGraceDeadlines(
						cache,
						released,
						{
							releasedAt: release.releasedAt,
							retainUntil: release.retainUntil,
							closeRetentionEpoch: release.closeRetentionEpoch ?? undefined
						},
						tx
					);
				}

				const releasedRows = liveRootTargets({
					cacheId: release.cacheId,
					name: release.rootName,
					incarnation: release.incarnation ?? undefined
				});
				const page = inArray(
					targets.storePathHash,
					jsonValueList([...released])
				);

				tx.delete(targets).where(and(releasedRows, page)).run();
			}

			if (released.length < pageSize) {
				tx.delete(releases).where(eq(releases.id, release.id)).run();
			}

			return released.length;
		});
	}

	/**
	The grace for targets that a replacement or a removal releases at
	`releasedAt`. The first close after the root's retention epoch decides
	the deadline when there is one. Otherwise the cache's grace period from
	`releasedAt` decides it.
	*/
	graceOnRelease(
		cache: ResolvedCache,
		root: { readonly retentionEpoch: number },
		releasedAt: IsoTimestamp,
		writer: SchemaWriter
	): ReleaseGrace {
		const close = new CacheClosureService(this.context).firstClose(
			cache,
			root.retentionEpoch
		);

		if (close !== undefined) {
			return {
				retainUntil: close.graceUntil,
				closeRetentionEpoch: root.retentionEpoch
			};
		}

		return this.gracePeriodFrom(cache, releasedAt, writer);
	}

	/**
	The cache's grace period from `anchor`. A cache without a grace period,
	or with a zero one, grants no deadline. A cache with a grace period
	becomes grace-managed.
	*/
	gracePeriodFrom(
		cache: ResolvedCache,
		anchor: IsoTimestamp,
		writer: SchemaWriter
	): ReleaseGrace {
		return this.gracePeriods(cache, writer)(anchor);
	}

	/**
	Returns {@link gracePeriodFrom} for one cache. The cache's grace period is
	read at the first call and reused for every later anchor.
	*/
	gracePeriods(
		cache: ResolvedCache,
		writer: SchemaWriter
	): (anchor: IsoTimestamp) => ReleaseGrace {
		let resolved: { readonly graceSeconds: number | undefined } | undefined;

		return (anchor) => {
			if (resolved === undefined) {
				const graceSeconds = this.retention.resolveGraceSeconds(cache);
				resolved = { graceSeconds };

				if (graceSeconds !== undefined) {
					this.retention.markCacheGraceManaged(cache, writer);
				}
			}

			if (resolved.graceSeconds === undefined || resolved.graceSeconds === 0) {
				return noGrace;
			}

			return {
				retainUntil: isoTimestamp(
					new Date(new Date(anchor).getTime() + resolved.graceSeconds * 1000)
				),
				closeRetentionEpoch: undefined
			};
		};
	}

	/**
	Records that a root releases its incarnation, when the incarnation still
	has a target row, and returns whether it did. Reads at most one target
	row, and decides the grace only when it records the release.
	*/
	record(
		writer: SchemaWriter,
		root: RootIncarnationKey,
		releasedAt: IsoTimestamp,
		grace: () => ReleaseGrace
	): boolean {
		const remaining = writer
			.select({ storePathHash: targets.storePathHash })
			.from(targets)
			.where(liveRootTargets(root))
			.limit(1)
			.get();

		if (remaining === undefined) {
			return false;
		}

		const decided = grace();

		writer
			.insert(releases)
			.values({
				cacheId: root.cacheId,
				rootName: root.name,
				incarnation: root.incarnation,
				releasedAt,
				retainUntil: decided.retainUntil,
				closeRetentionEpoch: decided.closeRetentionEpoch
			})
			.run();

		return true;
	}

	/**
	Whether a release of a cache that is not being torn down remains. The
	teardown drain deletes the releases of a removed cache.
	*/
	hasPending(): boolean {
		return this.nextRelease(undefined) !== undefined;
	}

	/**
	Drains releases, oldest first, of one cache or of every cache that is not
	being torn down, until none is left or the row budget is spent. The first
	step runs whatever the budget.
	*/
	drain(cache?: ResolvedCache): ReleaseDrainProgress {
		let targetsReleased = 0;

		for (;;) {
			const release = this.nextRelease(cache);

			if (release === undefined) {
				return { targetsReleased, hasMore: false };
			}

			targetsReleased += this.step(release);

			if (isRowBudgetExhausted()) {
				return {
					targetsReleased,
					hasMore: this.nextRelease(cache) !== undefined
				};
			}
		}
	}
}
