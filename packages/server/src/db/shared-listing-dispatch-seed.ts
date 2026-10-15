import { type ArtifactJobId } from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, desc, eq, exists, gt, isNull, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const pageSize = 32;
type Checkpoint = typeof schema.sharedListingDispatchSeed.$inferSelect;
export type SharedListingDispatchSeedResult =
	| {
			readonly kind: 'advanced';
			readonly scanned: number;
			readonly enrolled: number;
			readonly isComplete: boolean;
	  }
	| { readonly kind: 'complete' | 'stale' };

/**
Recovers dispatch for jobs that precede the dispatch projection.
*/
export class SharedListingDispatchSeedStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private stateQuery() {
		return this.database
			.select()
			.from(schema.sharedListingDispatchSeed)
			.where(eq(schema.sharedListingDispatchSeed.id, 1));
	}
	private async checkpoint(): Promise<Checkpoint> {
		const stored = await this.stateQuery().get();
		if (stored !== undefined) {
			return stored;
		}
		const highest = this.database
			.select({ id: schema.sharedListingJob.id })
			.from(schema.sharedListingJob)
			.orderBy(desc(schema.sharedListingJob.id))
			.limit(1);
		const source = sql`SELECT 1,NULL,boundary,boundary IS NULL FROM (SELECT (${highest}) AS boundary) WHERE true`;
		await this.database
			.insert(schema.sharedListingDispatchSeed)
			.select(source)
			.onConflictDoNothing();
		const row = await this.stateQuery().get();
		if (row === undefined) {
			throw new Error('The global listing dispatch seed checkpoint is missing');
		}
		return row;
	}
	private fence(row: Checkpoint) {
		const table = schema.sharedListingDispatchSeed;
		return and(
			eq(table.id, 1),
			eq(table.isComplete, false),
			row.after === null ? isNull(table.after) : eq(table.after, row.after),
			row.through === null
				? isNull(table.through)
				: eq(table.through, row.through)
		);
	}
	private async enrol(
		row: Checkpoint,
		ids: readonly ArtifactJobId[],
		isComplete: boolean,
		now: IsoTimestamp
	): Promise<SharedListingDispatchSeedResult> {
		const current = this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingDispatchSeed)
			.where(this.fence(row));
		const selected = jsonValueList(ids);
		const source = sql`SELECT NULL,job.id,job.generation,${now},0,NULL,NULL,0,NULL,NULL FROM shared_listing_job AS job WHERE job.id IN (${selected}) AND job.state='running' AND ${exists(current)}`;
		const [enrolled, updated] = await this.database.batch([
			this.database
				.insert(schema.sharedListingJobDispatch)
				.select(source)
				.onConflictDoNothing()
				.returning({ id: schema.sharedListingJobDispatch.jobId }),
			this.database
				.update(schema.sharedListingDispatchSeed)
				.set({
					after: (isComplete ? row.through : ids.at(-1)) ?? sql`null`,
					isComplete
				})
				.where(this.fence(row))
				.returning({ id: schema.sharedListingDispatchSeed.id })
		]);
		if (updated.length === 0) {
			return { kind: 'stale' };
		}
		return {
			kind: 'advanced',
			scanned: ids.length,
			enrolled: enrolled.length,
			isComplete
		};
	}
	async advance(now: IsoTimestamp): Promise<SharedListingDispatchSeedResult> {
		try {
			const row = await this.checkpoint();
			if (row.isComplete) {
				return { kind: 'complete' };
			}
			if (row.through === null) {
				throw new Error('The global listing dispatch seed boundary is missing');
			}
			const page = await this.database
				.select({ id: schema.sharedListingJob.id })
				.from(schema.sharedListingJob)
				.where(
					and(
						row.after === null
							? undefined
							: gt(schema.sharedListingJob.id, row.after),
						lte(schema.sharedListingJob.id, row.through)
					)
				)
				.orderBy(asc(schema.sharedListingJob.id))
				.limit(pageSize + 1);
			return await this.enrol(
				row,
				page.slice(0, pageSize).map((item) => item.id),
				page.length <= pageSize,
				now
			);
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
}
