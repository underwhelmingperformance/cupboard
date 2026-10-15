import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ArtifactJobVersion,
	type ArtifactTaskId
} from '@cupboard/protocol/artifact-jobs';
import { type ListingGeneratorRevision } from '@cupboard/protocol/artifacts';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, exists, gt, lt, lte, or, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type SharedListingTaskClaim,
	type SharedListingTaskClaimResult,
	sharedListingTaskClaimSchema,
	type SharedListingTaskRequest,
	sharedListingTaskRequestSchema
} from '../blob/shared-listing-tasks.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const readyPageSize = 8;
const leaseDurationMs = 60_000;
type Task = typeof schema.sharedListingTask.$inferSelect;
interface ReadyTask {
	readonly id: ArtifactTaskId;
	readonly availableAt: IsoTimestamp;
}

export interface SharedListingReadyTasks {
	readonly tasks: readonly ArtifactTaskId[];
	readonly hasMore: boolean;
}

/**
 * Execution ownership is separate from NAR availability and cache authority.
 * Executors must recheck the physical source before reading or completing work.
 */
export class SharedListingTaskStore {
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

	private jobVersion(
		job: ArtifactJobVersion,
		revision?: ListingGeneratorRevision
	) {
		return and(
			eq(schema.sharedListingJob.id, job.id),
			eq(schema.sharedListingJob.generation, job.generation),
			eq(schema.sharedListingJob.state, 'running'),
			revision === undefined
				? undefined
				: eq(schema.sharedListingJob.generatorRevision, revision)
		);
	}
	private activeJob(
		job: ArtifactJobVersion,
		revision?: ListingGeneratorRevision
	) {
		const current = this.database
			.select({ one: sql`1` })
			.from(schema.sharedListingJob)
			.where(this.jobVersion(job, revision));
		return exists(current);
	}
	private identity(request: Pick<SharedListingTaskRequest, 'job' | 'id'>) {
		return and(
			eq(schema.sharedListingTask.id, request.id),
			eq(schema.sharedListingTask.jobId, request.job.id)
		);
	}
	private captured(claim: SharedListingTaskClaim) {
		return and(
			this.identity(claim),
			this.activeJob(claim.job, claim.generatorRevision),
			eq(schema.sharedListingTask.claimGeneration, claim.generation),
			eq(schema.sharedListingTask.claimJobGeneration, claim.job.generation),
			eq(schema.sharedListingTask.claimOwner, claim.owner),
			eq(schema.sharedListingTask.narHash, claim.narHash),
			eq(schema.sharedListingTask.sourceIncarnation, claim.sourceIncarnation),
			eq(schema.sharedListingTask.narSize, claim.narSize),
			eq(schema.sharedListingTask.fileSize, claim.fileSize)
		);
	}
	private current(claim: SharedListingTaskClaim, now: IsoTimestamp) {
		return and(
			this.captured(claim),
			eq(schema.sharedListingTask.state, 'running'),
			gt(schema.sharedListingTask.leaseExpiresAt, now)
		);
	}
	private decoded(
		row: Task,
		request: SharedListingTaskRequest,
		revision: ListingGeneratorRevision
	): SharedListingTaskClaim {
		return sharedListingTaskClaimSchema.parse({
			job: request.job,
			id: row.id,
			owner: row.claimOwner,
			generation: row.claimGeneration,
			generatorRevision: revision,
			narHash: row.narHash,
			sourceIncarnation: row.sourceIncarnation,
			narSize: row.narSize,
			fileSize: row.fileSize,
			leaseExpiresAt: row.leaseExpiresAt
		});
	}

	async ready(
		job: ArtifactJobVersion,
		now: IsoTimestamp
	): Promise<SharedListingReadyTasks> {
		const pending = and(
			eq(schema.sharedListingTask.jobId, job.id),
			eq(schema.sharedListingTask.state, 'pending'),
			lte(schema.sharedListingTask.readyAt, now)
		);
		const expired = and(
			eq(schema.sharedListingTask.jobId, job.id),
			eq(schema.sharedListingTask.state, 'running'),
			lte(schema.sharedListingTask.leaseExpiresAt, now)
		);
		const superseded = and(
			eq(schema.sharedListingTask.jobId, job.id),
			eq(schema.sharedListingTask.state, 'running'),
			lt(schema.sharedListingTask.claimJobGeneration, job.generation)
		);
		return this.execute(async () => {
			const [jobs, waiting, elapsed, stale] = await this.database.batch([
				this.database
					.select({ id: schema.sharedListingJob.id })
					.from(schema.sharedListingJob)
					.where(this.jobVersion(job)),
				this.database
					.select({
						id: schema.sharedListingTask.id,
						availableAt: schema.sharedListingTask.readyAt
					})
					.from(schema.sharedListingTask)
					.where(pending)
					.orderBy(
						asc(schema.sharedListingTask.readyAt),
						asc(schema.sharedListingTask.id)
					)
					.limit(readyPageSize + 1),
				this.database
					.select({
						id: schema.sharedListingTask.id,
						availableAt: schema.sharedListingTask.leaseExpiresAt
					})
					.from(schema.sharedListingTask)
					.where(expired)
					.orderBy(
						asc(schema.sharedListingTask.leaseExpiresAt),
						asc(schema.sharedListingTask.id)
					)
					.limit(readyPageSize + 1),
				this.database
					.select({
						id: schema.sharedListingTask.id,
						availableAt: schema.sharedListingTask.readyAt
					})
					.from(schema.sharedListingTask)
					.where(superseded)
					.orderBy(
						asc(schema.sharedListingTask.claimJobGeneration),
						asc(schema.sharedListingTask.id)
					)
					.limit(readyPageSize + 1)
			]);
			if (jobs.length === 0) {
				return { tasks: [], hasMore: false };
			}
			const unique = new Map<ArtifactTaskId, ReadyTask>();
			for (const candidate of [...waiting, ...elapsed, ...stale]) {
				if (candidate.availableAt === null) {
					continue;
				}
				const existing = unique.get(candidate.id);
				if (
					existing === undefined ||
					candidate.availableAt < existing.availableAt
				) {
					unique.set(candidate.id, {
						id: candidate.id,
						availableAt: candidate.availableAt
					});
				}
			}
			const ordered = unique
				.values()
				.toArray()
				.toSorted(
					(first, second) =>
						byCodeUnit(first.availableAt, second.availableAt) ||
						byCodeUnit(first.id, second.id)
				);
			return {
				tasks: ordered.slice(0, readyPageSize).map(({ id }) => id),
				hasMore: ordered.length > readyPageSize
			};
		});
	}

	async claim(
		input: SharedListingTaskRequest,
		now: IsoTimestamp
	): Promise<SharedListingTaskClaimResult> {
		const request = sharedListingTaskRequestSchema.parse(input);
		const deadline = isoTimestamp(new Date(Date.parse(now) + leaseDurationMs));
		return this.execute(async () => {
			const job = await this.database
				.select({
					generatorRevision: schema.sharedListingJob.generatorRevision
				})
				.from(schema.sharedListingJob)
				.where(this.jobVersion(request.job))
				.get();
			if (job === undefined) {
				return { kind: 'unavailable' };
			}
			const active = this.activeJob(request.job, job.generatorRevision);
			const pending = and(
				eq(schema.sharedListingTask.state, 'pending'),
				lte(schema.sharedListingTask.readyAt, now)
			);
			const running = and(
				eq(schema.sharedListingTask.state, 'running'),
				or(
					lte(schema.sharedListingTask.leaseExpiresAt, now),
					lt(
						schema.sharedListingTask.claimJobGeneration,
						request.job.generation
					)
				)
			);
			const available = and(
				this.identity(request),
				active,
				lt(schema.sharedListingTask.claimGeneration, Number.MAX_SAFE_INTEGER),
				or(pending, running)
			);
			const rows = await this.database
				.update(schema.sharedListingTask)
				.set({
					state: 'running',
					claimGeneration: sql`${schema.sharedListingTask.claimGeneration} + 1`,
					claimJobGeneration: request.job.generation,
					claimOwner: request.owner,
					leaseExpiresAt: deadline,
					updatedAt: sql`max(coalesce(${schema.sharedListingTask.updatedAt}, ${schema.sharedListingTask.createdAt}), ${now})`
				})
				.where(available)
				.returning();
			if (rows[0] !== undefined) {
				return {
					kind: 'claimed',
					claim: this.decoded(rows[0], request, job.generatorRevision)
				};
			}
			const row = await this.database
				.select()
				.from(schema.sharedListingTask)
				.where(and(this.identity(request), active))
				.get();
			if (row === undefined) {
				return { kind: 'unavailable' };
			}
			if (
				row.state === 'running' &&
				row.claimJobGeneration === request.job.generation &&
				row.leaseExpiresAt !== null &&
				row.leaseExpiresAt > now
			) {
				return row.claimOwner === request.owner
					? {
							kind: 'claimed',
							claim: this.decoded(row, request, job.generatorRevision)
						}
					: { kind: 'busy', retryAt: row.leaseExpiresAt };
			}
			if (row.claimGeneration >= Number.MAX_SAFE_INTEGER) {
				return { kind: 'unavailable' };
			}
			if (row.state === 'pending' && row.readyAt > now) {
				return { kind: 'busy', retryAt: row.readyAt };
			}
			return { kind: 'unavailable' };
		});
	}

	async renew(
		claim: SharedListingTaskClaim,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		const deadline = isoTimestamp(new Date(Date.parse(now) + leaseDurationMs));
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.sharedListingTask)
				.set({
					leaseExpiresAt: sql`max(${schema.sharedListingTask.leaseExpiresAt}, ${deadline})`,
					updatedAt: sql`max(coalesce(${schema.sharedListingTask.updatedAt}, ${schema.sharedListingTask.createdAt}), ${now})`
				})
				.where(this.current(claim, now))
				.returning({ at: schema.sharedListingTask.leaseExpiresAt });
			return rows[0]?.at ?? undefined;
		});
	}

	async defer(
		claim: SharedListingTaskClaim,
		retryAt: IsoTimestamp,
		now: IsoTimestamp
	): Promise<IsoTimestamp | undefined> {
		return this.execute(async () => {
			const rows = await this.database
				.update(schema.sharedListingTask)
				.set({
					state: 'pending',
					leaseExpiresAt: sql`null`,
					readyAt: sql`max(${now}, ${retryAt})`,
					updatedAt: sql`max(coalesce(${schema.sharedListingTask.updatedAt}, ${schema.sharedListingTask.createdAt}), ${now})`
				})
				.where(this.current(claim, now))
				.returning({ at: schema.sharedListingTask.readyAt });
			if (rows[0] !== undefined) {
				return rows[0].at;
			}
			const pending = and(
				this.captured(claim),
				eq(schema.sharedListingTask.state, 'pending')
			);
			const row = await this.database
				.select({ at: schema.sharedListingTask.readyAt })
				.from(schema.sharedListingTask)
				.where(pending)
				.get();
			return row?.at;
		});
	}
}
