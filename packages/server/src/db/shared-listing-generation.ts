import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	eq,
	exists,
	gt,
	isNull,
	lte,
	ne,
	not,
	or,
	sql
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import {
	type SharedListingGenerationClaim,
	type SharedListingGenerationClaimResult,
	sharedListingGenerationClaimSchema
} from '../blob/shared-listing-generation.ts';
import {
	type SharedListingTaskClaim,
	sharedListingTaskClaimSchema
} from '../blob/shared-listing-tasks.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';

const leaseDurationMs = 60_000;
type Row = typeof schema.sharedListingGeneration.$inferSelect;

/**
Computation ownership creates no cache authority or physical retention.
*/
export class SharedListingGenerationStore {
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

	private identity(task: SharedListingTaskClaim) {
		return and(
			eq(schema.sharedListingGeneration.narHash, task.narHash),
			eq(
				schema.sharedListingGeneration.generatorRevision,
				task.generatorRevision
			)
		);
	}

	private source(task: SharedListingTaskClaim, now: IsoTimestamp) {
		const owned = this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingTask)
			.where(new SharedListingTaskStore(this.database).owns(task, now));
		const source = this.database
			.select({ one: sql`1` })
			.from(schema.blobState)
			.where(
				and(
					eq(schema.blobState.narHash, task.narHash),
					eq(schema.blobState.incarnation, task.sourceIncarnation),
					eq(schema.blobState.narSize, task.narSize),
					eq(schema.blobState.fileSize, task.fileSize),
					registeredLiveObjectIncarnation(
						this.database,
						'nar',
						task.narHash,
						task.sourceIncarnation
					)
				)
			);
		const retained = this.database
			.select({ one: sql`1` })
			.from(schema.blobReference)
			.where(eq(schema.blobReference.narHash, task.narHash));
		return and(exists(owned), exists(source), exists(retained));
	}

	private captured(claim: SharedListingGenerationClaim) {
		const task = claim.task;
		return and(
			this.identity(task),
			eq(
				schema.sharedListingGeneration.sourceIncarnation,
				task.sourceIncarnation
			),
			eq(schema.sharedListingGeneration.generation, claim.generation),
			eq(schema.sharedListingGeneration.jobId, task.job.id),
			eq(schema.sharedListingGeneration.jobGeneration, task.job.generation),
			eq(schema.sharedListingGeneration.taskId, task.id),
			eq(schema.sharedListingGeneration.taskGeneration, task.generation),
			eq(schema.sharedListingGeneration.owner, task.owner)
		);
	}

	private previousTaskActive(now: IsoTimestamp) {
		const owned = this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingTask)
			.innerJoin(
				schema.sharedListingJob,
				eq(schema.sharedListingJob.id, schema.sharedListingTask.jobId)
			)
			.where(
				and(
					eq(
						schema.sharedListingTask.id,
						schema.sharedListingGeneration.taskId
					),
					eq(
						schema.sharedListingTask.jobId,
						schema.sharedListingGeneration.jobId
					),
					eq(
						schema.sharedListingJob.generation,
						schema.sharedListingGeneration.jobGeneration
					),
					eq(schema.sharedListingJob.state, 'running'),
					eq(schema.sharedListingTask.state, 'running'),
					eq(
						schema.sharedListingTask.claimGeneration,
						schema.sharedListingGeneration.taskGeneration
					),
					eq(
						schema.sharedListingTask.claimJobGeneration,
						schema.sharedListingGeneration.jobGeneration
					),
					eq(
						schema.sharedListingTask.claimOwner,
						schema.sharedListingGeneration.owner
					),
					gt(schema.sharedListingTask.leaseExpiresAt, now)
				)
			);
		return exists(owned);
	}

	private decoded(
		row: Row,
		task: SharedListingTaskClaim
	): SharedListingGenerationClaim {
		return sharedListingGenerationClaimSchema.parse({
			task,
			generation: row.generation,
			leaseExpiresAt: row.leaseExpiresAt
		});
	}

	async claim(
		input: SharedListingTaskClaim,
		now: IsoTimestamp
	): Promise<SharedListingGenerationClaimResult> {
		const task = sharedListingTaskClaimSchema.parse(input);
		const deadline = isoTimestamp(new Date(Date.parse(now) + leaseDurationMs));
		return this.execute(async () => {
			const source = this.source(task, now);
			const expiry = this.database
				.select({ at: schema.sharedListingTask.leaseExpiresAt })
				.from(schema.sharedListingTask)
				.where(eq(schema.sharedListingTask.id, task.id));
			const deadlineSql = sql<IsoTimestamp>`min(${deadline}, (${expiry}))`;
			const selected = this.database
				.select({
					narHash: schema.sharedListingTask.narHash,
					generatorRevision: sql<
						typeof task.generatorRevision
					>`${task.generatorRevision}`.as('generator_revision'),
					sourceIncarnation: schema.sharedListingTask.sourceIncarnation,
					generation: sql<number>`1`.as('generation'),
					jobId: schema.sharedListingTask.jobId,
					jobGeneration: sql<
						typeof task.job.generation
					>`${task.job.generation}`.as('job_generation'),
					taskId: schema.sharedListingTask.id,
					taskGeneration: sql<typeof task.generation>`${task.generation}`.as(
						'task_generation'
					),
					owner: schema.sharedListingTask.claimOwner,
					leaseExpiresAt: deadlineSql.as('lease_expires_at'),
					updatedAt: sql<IsoTimestamp>`${now}`.as('updated_at')
				})
				.from(schema.sharedListingTask)
				.where(and(eq(schema.sharedListingTask.id, task.id), source));
			const previousTaskActive = this.previousTaskActive(now);
			const replaceable = and(
				sql`${schema.sharedListingGeneration.generation} < ${Number.MAX_SAFE_INTEGER}`,
				or(
					isNull(schema.sharedListingGeneration.owner),
					lte(schema.sharedListingGeneration.leaseExpiresAt, now),
					ne(
						schema.sharedListingGeneration.sourceIncarnation,
						task.sourceIncarnation
					),
					not(previousTaskActive)
				)
			);
			const rows = await this.database
				.insert(schema.sharedListingGeneration)
				.select(selected)
				.onConflictDoUpdate({
					target: [
						schema.sharedListingGeneration.narHash,
						schema.sharedListingGeneration.generatorRevision
					],
					set: {
						sourceIncarnation: task.sourceIncarnation,
						generation: sql`${schema.sharedListingGeneration.generation} + 1`,
						jobId: task.job.id,
						jobGeneration: task.job.generation,
						taskId: task.id,
						taskGeneration: task.generation,
						owner: task.owner,
						leaseExpiresAt: deadlineSql,
						updatedAt: now
					},
					setWhere: replaceable
				})
				.returning();
			if (rows[0] !== undefined) {
				return { kind: 'claimed', claim: this.decoded(rows[0], task) };
			}
			const current = await this.database
				.select()
				.from(schema.sharedListingGeneration)
				.where(and(this.identity(task), source))
				.get();
			if (
				current?.owner === task.owner &&
				current.jobId === task.job.id &&
				current.jobGeneration === task.job.generation &&
				current.taskId === task.id &&
				current.taskGeneration === task.generation &&
				current.leaseExpiresAt !== null &&
				current.leaseExpiresAt > now
			) {
				return { kind: 'claimed', claim: this.decoded(current, task) };
			}
			if (
				current?.owner !== null &&
				current?.leaseExpiresAt !== null &&
				current?.leaseExpiresAt !== undefined &&
				current.leaseExpiresAt > now
			) {
				return { kind: 'busy', retryAt: current.leaseExpiresAt };
			}
			const tenant = await this.database
				.select({ at: schema.listingGeneration.leaseExpiresAt })
				.from(schema.listingGeneration)
				.where(
					and(
						eq(schema.listingGeneration.narHash, task.narHash),
						eq(
							schema.listingGeneration.generatorRevision,
							task.generatorRevision
						),
						eq(
							schema.listingGeneration.sourceIncarnation,
							task.sourceIncarnation
						),
						gt(schema.listingGeneration.leaseExpiresAt, now),
						source
					)
				)
				.get();
			return tenant?.at === undefined || tenant.at === null
				? { kind: 'unavailable' }
				: { kind: 'busy', retryAt: tenant.at };
		});
	}

	async renew(
		claim: SharedListingGenerationClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		const deadline = isoTimestamp(new Date(Date.parse(now) + leaseDurationMs));
		return this.execute(async () => {
			const taskLease = this.database
				.select({ at: schema.sharedListingTask.leaseExpiresAt })
				.from(schema.sharedListingTask)
				.where(eq(schema.sharedListingTask.id, claim.task.id));
			const rows = await this.database
				.update(schema.sharedListingGeneration)
				.set({
					leaseExpiresAt: sql`max(${schema.sharedListingGeneration.leaseExpiresAt}, min(${deadline}, (${taskLease})))`,
					updatedAt: sql`max(${schema.sharedListingGeneration.updatedAt}, ${now})`
				})
				.where(
					and(
						this.captured(claim),
						gt(schema.sharedListingGeneration.leaseExpiresAt, now),
						this.source(claim.task, now)
					)
				)
				.returning({ at: schema.sharedListingGeneration.leaseExpiresAt });
			return rows[0]?.at ?? undefined;
		});
	}

	async release(
		claim: SharedListingGenerationClaim,
		now: IsoTimestamp
	): Promise<boolean> {
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.sharedListingGeneration)
				.set({
					owner: sql`null`,
					leaseExpiresAt: sql`null`,
					updatedAt: sql`max(${schema.sharedListingGeneration.updatedAt}, ${now})`
				})
				.where(this.captured(claim))
				.returning({ generation: schema.sharedListingGeneration.generation });
			return rows.length === 1;
		});
	}
}
