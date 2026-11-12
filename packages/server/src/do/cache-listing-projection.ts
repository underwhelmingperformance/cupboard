import { eq, sql } from 'drizzle-orm';

import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { CacheListingProjectionPendingError } from '../errors.ts';

import { type SchemaDatabase, type ServerContext } from './context.ts';

export const cacheListingProjectionRowsPerPass = 48;

/**
Whether the migration has counted every narinfo row that existed before
`cache_narinfo_count`, so that the projection counts every row.
*/
export function hasNarInfoCounts(database: SchemaDatabase): boolean {
	const state = database
		.select({
			narinfoComplete: schema.cacheListingProjectionMigration.narinfoComplete
		})
		.from(schema.cacheListingProjectionMigration)
		.where(eq(schema.cacheListingProjectionMigration.id, 1))
		.get();

	return state?.narinfoComplete === true;
}

/**
Refuses with `CacheListingProjectionPendingError` until the projection
counts every narinfo row.
*/
export function requireNarInfoCounts(database: SchemaDatabase): void {
	if (!hasNarInfoCounts(database)) {
		throw new CacheListingProjectionPendingError();
	}
}

/**
Returns the number of store paths in `cache` from `cache_narinfo_count`,
which triggers keep equal to the number of the cache's narinfo rows. The
read costs the same however many paths the cache has.
*/
export function projectedStorePathCount(
	database: SchemaDatabase,
	cache: ResolvedCache
): number {
	requireNarInfoCounts(database);

	return (
		database
			.select({ count: schema.cacheNarInfoCounts.count })
			.from(schema.cacheNarInfoCounts)
			.where(eq(schema.cacheNarInfoCounts.cacheId, cache.id))
			.get()?.count ?? 0
	);
}

export class CacheListingProjection {
	private complete = false;

	constructor(private readonly context: ServerContext) {}

	isReady(): boolean {
		if (this.complete) {
			return true;
		}

		const state = this.context.db
			.select({
				narinfoComplete: schema.cacheListingProjectionMigration.narinfoComplete,
				graceComplete: schema.cacheListingProjectionMigration.graceComplete
			})
			.from(schema.cacheListingProjectionMigration)
			.where(eq(schema.cacheListingProjectionMigration.id, 1))
			.get();

		this.complete = state?.narinfoComplete === true && state.graceComplete;

		return this.complete;
	}

	hasPending(): boolean {
		return !this.isReady();
	}

	advance(): void {
		const state = this.context.db
			.select()
			.from(schema.cacheListingProjectionMigration)
			.where(eq(schema.cacheListingProjectionMigration.id, 1))
			.get();

		if (state === undefined) {
			throw new Error('Cache listing projection migration has no state row.');
		}

		if (!state.narinfoComplete) {
			const rows = this.context.db.all<{ rowid: number }>(sql`
				SELECT rowid FROM narinfo
				WHERE rowid > ${state.narinfoCursor}
					AND rowid <= ${state.narinfoInitialRowidHighWater}
				ORDER BY rowid
				LIMIT ${cacheListingProjectionRowsPerPass}
			`);
			const last = rows.at(-1)?.rowid ?? state.narinfoInitialRowidHighWater;
			this.context.db.transaction((tx) => {
				tx.run(sql`
					INSERT INTO cache_narinfo_count (cache_id, count)
					SELECT cache_id, count(*) FROM narinfo
					WHERE cache_id IS NOT NULL
						AND rowid > ${state.narinfoCursor}
						AND rowid <= ${last}
					GROUP BY cache_id
					ON CONFLICT (cache_id) DO UPDATE SET count = count + excluded.count
				`);
				tx.update(schema.cacheListingProjectionMigration)
					.set({
						narinfoCursor: last,
						narinfoComplete: rows.length < cacheListingProjectionRowsPerPass
					})
					.where(eq(schema.cacheListingProjectionMigration.id, 1))
					.run();
			});
			return;
		}

		if (state.graceComplete) {
			return;
		}

		const rows = this.context.db.all<{ rowid: number }>(sql`
			SELECT rowid FROM retention_grace
			WHERE rowid > ${state.graceCursor}
				AND rowid <= ${state.graceInitialRowidHighWater}
			ORDER BY rowid
			LIMIT ${cacheListingProjectionRowsPerPass}
		`);
		const last = rows.at(-1)?.rowid ?? state.graceInitialRowidHighWater;
		this.context.db.transaction((tx) => {
			tx.run(sql`
				INSERT OR REPLACE INTO retention_grace_by_deadline
					(cache_id, retain_until, store_path_hash)
				SELECT cache_id, retain_until, store_path_hash FROM retention_grace
				WHERE cache_id IS NOT NULL
					AND rowid > ${state.graceCursor}
					AND rowid <= ${last}
			`);
			tx.update(schema.cacheListingProjectionMigration)
				.set({
					graceCursor: last,
					graceComplete: rows.length < cacheListingProjectionRowsPerPass
				})
				.where(eq(schema.cacheListingProjectionMigration.id, 1))
				.run();
		});
	}
}
