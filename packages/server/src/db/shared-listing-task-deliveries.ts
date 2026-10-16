import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	artifactJobVersionSchema,
	type ArtifactTaskId
} from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, exists, lt, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const pageSize = 8;
const retryMs = 60_000;
type Delivery = typeof schema.sharedListingTaskDelivery.$inferSelect;

export interface SharedListingTaskHint {
	readonly job: ArtifactJobVersion;
	readonly id: ArtifactTaskId;
}

/**
 * Reservations defer repeat delivery without granting execution ownership.
 * Task claims and their source checks remain authoritative after delivery.
 */
export class SharedListingTaskDeliveryStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private active(job: ArtifactJobVersion) {
		return this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingJob)
			.where(
				and(
					eq(schema.sharedListingJob.id, job.id),
					eq(schema.sharedListingJob.generation, job.generation),
					eq(schema.sharedListingJob.state, 'running')
				)
			);
	}

	private candidates(job: ArtifactJobVersion, now?: IsoTimestamp) {
		const table = schema.sharedListingTaskDelivery;
		const pending = and(
			eq(table.jobId, job.id),
			eq(table.state, 'pending'),
			now === undefined ? undefined : lte(table.nextAt, now)
		);
		const running = and(
			eq(table.jobId, job.id),
			eq(table.state, 'running'),
			eq(table.jobGeneration, job.generation),
			now === undefined ? undefined : lte(table.nextAt, now)
		);
		const superseded = and(
			eq(table.jobId, job.id),
			eq(table.state, 'running'),
			lt(table.jobGeneration, job.generation)
		);
		return [
			this.active(job),
			this.database
				.select()
				.from(table)
				.where(pending)
				.orderBy(asc(table.nextAt), asc(table.taskId))
				.limit(pageSize),
			this.database
				.select()
				.from(table)
				.where(running)
				.orderBy(asc(table.nextAt), asc(table.taskId))
				.limit(pageSize),
			this.database
				.select()
				.from(table)
				.where(superseded)
				.orderBy(asc(table.jobGeneration), asc(table.nextAt), asc(table.taskId))
				.limit(pageSize)
		] as const;
	}

	private reservation(
		row: Delivery,
		job: ArtifactJobVersion,
		deadline: IsoTimestamp
	) {
		const table = schema.sharedListingTaskDelivery;
		const current = this.active(job);
		return this.database
			.update(table)
			.set({
				jobGeneration: job.generation,
				nextAt: deadline,
				epoch: sql`lower(hex(randomblob(16)))`
			})
			.where(
				and(
					eq(table.taskId, row.taskId),
					eq(table.jobId, job.id),
					eq(table.epoch, row.epoch),
					eq(table.state, row.state),
					eq(table.jobGeneration, row.jobGeneration),
					eq(table.nextAt, row.nextAt),
					exists(current)
				)
			)
			.returning({ taskId: table.taskId });
	}

	async reserve(
		input: ArtifactJobVersion,
		now: IsoTimestamp
	): Promise<readonly SharedListingTaskHint[]> {
		const job = artifactJobVersionSchema.parse(input);
		return this.execute(async () => {
			const [jobs, pending, running, superseded] = await this.database.batch(
				this.candidates(job, now)
			);
			if (jobs.length === 0) {
				return [];
			}
			const available = [...pending, ...running].toSorted(
				(first, second) =>
					byCodeUnit(first.nextAt, second.nextAt) ||
					byCodeUnit(first.taskId, second.taskId)
			);
			const selected = [...superseded, ...available].slice(0, pageSize);
			const first = selected[0];
			if (first === undefined) {
				return [];
			}
			const deadline = isoTimestamp(new Date(Date.parse(now) + retryMs));
			const results = await this.database.batch([
				this.reservation(first, job, deadline),
				...selected.slice(1).map((row) => this.reservation(row, job, deadline))
			]);
			return results.flat().map((row) => ({ job, id: row.taskId }));
		});
	}

	async next(
		input: ArtifactJobVersion,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		const job = artifactJobVersionSchema.parse(input);
		return this.execute(async () => {
			const [jobs, pending, running, superseded] = await this.database.batch(
				this.candidates(job)
			);
			if (jobs.length === 0) {
				return;
			}
			if (superseded.length > 0) {
				return now;
			}
			const times = [...pending, ...running]
				.map((row) => row.nextAt)
				.toSorted(byCodeUnit);
			const next = times[0];
			if (next === undefined) {
				return;
			}
			const nextMs = Math.max(Date.parse(next), Date.parse(now));
			return isoTimestamp(new Date(nextMs));
		});
	}
}
