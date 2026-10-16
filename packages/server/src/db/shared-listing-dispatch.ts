import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import {
	type ArtifactJobVersion,
	artifactJobVersionSchema,
	type ArtifactTaskOwner
} from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	isNull,
	lt,
	lte,
	or,
	type SQL,
	sql,
	type SQLWrapper
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type SharedListingDispatchClaim,
	type SharedListingDispatchClaimResult,
	sharedListingDispatchClaimSchema
} from '../blob/shared-listing-dispatch.ts';
import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';

const pageSize = 8;
const seedPageSize = 32;
const leaseMs = 60_000;
type Scope = typeof schema.sharedListingJobDispatch.$inferSelect;
interface SqlJob {
	readonly id: SQLWrapper;
	readonly generation: SQLWrapper;
}

/**
 * Persists fair dispatch turns and bounded discovery of legacy tasks.
 * Dispatch claims permit metadata updates; task executors claim their own work.
 */
export class SharedListingDispatchStore {
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
	private identity(job: ArtifactJobVersion): SqlJob {
		return { id: sql`${job.id}`, generation: sql`${job.generation}` };
	}
	private scopeIdentity(): SqlJob {
		return {
			id: schema.sharedListingJobDispatch.jobId,
			generation: schema.sharedListingJobDispatch.jobGeneration
		};
	}
	private active(job: SqlJob) {
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
	private nextAt(job: SqlJob, now: IsoTimestamp) {
		const delivery = schema.sharedListingTaskDelivery;
		const pending = this.database
			.select({ at: delivery.nextAt })
			.from(delivery)
			.where(and(eq(delivery.jobId, job.id), eq(delivery.state, 'pending')))
			.orderBy(asc(delivery.nextAt), asc(delivery.taskId))
			.limit(1);
		const running = this.database
			.select({ at: delivery.nextAt })
			.from(delivery)
			.where(
				and(
					eq(delivery.jobId, job.id),
					eq(delivery.state, 'running'),
					eq(delivery.jobGeneration, job.generation)
				)
			)
			.orderBy(asc(delivery.nextAt), asc(delivery.taskId))
			.limit(1);
		const obsolete = this.database
			.select({ one: sql`1` })
			.from(delivery)
			.where(
				and(
					eq(delivery.jobId, job.id),
					eq(delivery.state, 'running'),
					lt(delivery.jobGeneration, job.generation)
				)
			)
			.limit(1);
		const discovery = this.database
			.select({
				at: sql`CASE WHEN ${schema.sharedListingJob.phase} IN ('historical','catchup') THEN max(${now},coalesce(${schema.sharedListingJob.leaseExpiresAt},${now})) END`
			})
			.from(schema.sharedListingJob)
			.where(
				and(
					eq(schema.sharedListingJob.id, job.id),
					eq(schema.sharedListingJob.generation, job.generation),
					eq(schema.sharedListingJob.state, 'running')
				)
			);
		return sql<IsoTimestamp | null>`max(${now},(SELECT min(at) FROM (
   SELECT (${pending}) AS at UNION ALL SELECT (${running})
   UNION ALL SELECT CASE WHEN ${exists(obsolete)} THEN ${now} END
   UNION ALL SELECT (${discovery})
   UNION ALL SELECT CASE WHEN ${schema.sharedListingJobDispatch.isSeeded}=0 THEN ${now} END
  )))`;
	}
	private owns(claim: SharedListingDispatchClaim, now: IsoTimestamp) {
		const table = schema.sharedListingJobDispatch;
		const active = this.active(this.identity(claim.job));
		return and(
			eq(table.id, claim.id),
			eq(table.jobId, claim.job.id),
			eq(table.jobGeneration, claim.job.generation),
			eq(table.claimGeneration, claim.generation),
			eq(table.owner, claim.owner),
			eq(table.leaseExpiresAt, claim.leaseExpiresAt),
			gt(table.leaseExpiresAt, now),
			exists(active)
		);
	}
	private decoded(row: Scope): SharedListingDispatchClaim {
		return sharedListingDispatchClaimSchema.parse({
			id: row.id,
			job: { id: row.jobId, generation: row.jobGeneration },
			generation: row.claimGeneration,
			owner: row.owner,
			leaseExpiresAt: row.leaseExpiresAt
		});
	}
	private rotate(where: SQL | undefined, next: SQL, now: IsoTimestamp) {
		const table = schema.sharedListingJobDispatch;
		const source = sql`SELECT NULL,${table.jobId},${table.jobGeneration},${next},${table.claimGeneration},NULL,NULL,${table.isSeeded},${table.seedAfter},${table.seedThrough}
   FROM ${table} WHERE ${where}`;
		const readyAt = this.nextAt(this.scopeIdentity(), now);
		return this.database
			.insert(table)
			.select(source)
			.onConflictDoUpdate({
				target: table.jobId,
				set: {
					id: sql`excluded.id`,
					jobGeneration: sql`excluded.job_generation`,
					nextDeliveryAt: sql`excluded.next_delivery_at`,
					owner: sql`null`,
					leaseExpiresAt: sql`null`
				}
			})
			.returning({
				jobId: table.jobId,
				jobGeneration: table.jobGeneration,
				readyAt
			});
	}
	private seedFence(
		claim: SharedListingDispatchClaim,
		row: Scope,
		now: IsoTimestamp
	) {
		const table = schema.sharedListingJobDispatch;
		return and(
			this.owns(claim, now),
			eq(table.isSeeded, false),
			row.seedAfter === null
				? isNull(table.seedAfter)
				: eq(table.seedAfter, row.seedAfter),
			row.seedThrough === null
				? isNull(table.seedThrough)
				: eq(table.seedThrough, row.seedThrough)
		);
	}

	async enrol(input: ArtifactJobVersion, now: IsoTimestamp): Promise<boolean> {
		const job = artifactJobVersionSchema.parse(input);
		return this.execute(async () => {
			const active = this.active(this.identity(job));
			const source = sql`SELECT NULL,${job.id},${job.generation},${now},0,NULL,NULL,0,NULL,NULL WHERE ${exists(active)}`;
			const rows = await this.database
				.insert(schema.sharedListingJobDispatch)
				.select(source)
				.onConflictDoNothing()
				.returning({ id: schema.sharedListingJobDispatch.id });
			return rows.length > 0;
		});
	}

	async reserve(now: IsoTimestamp): Promise<readonly ArtifactJobVersion[]> {
		return this.execute(async () => {
			const table = schema.sharedListingJobDispatch;
			const [candidates] = await this.database.batch([
				this.database
					.select()
					.from(table)
					.where(lte(table.nextDeliveryAt, now))
					.orderBy(asc(table.nextDeliveryAt), asc(table.id))
					.limit(pageSize)
			]);
			const first = candidates[0];
			if (first === undefined) {
				return [];
			}
			const deadline = isoTimestamp(new Date(Date.parse(now) + leaseMs));
			const reservation = (row: Scope) => {
				const job = this.identity({
					id: row.jobId,
					generation: row.jobGeneration
				});
				const active = this.active(job);
				const next = this.nextAt(job, now);
				const current = and(
					eq(table.id, row.id),
					eq(table.jobId, row.jobId),
					eq(table.jobGeneration, row.jobGeneration),
					lte(table.nextDeliveryAt, now),
					or(isNull(table.leaseExpiresAt), lte(table.leaseExpiresAt, now)),
					exists(active)
				);
				return this.rotate(current, sql`max(${deadline},${next})`, now);
			};
			const results = await this.database.batch([
				reservation(first),
				...candidates.slice(1).map((row) => reservation(row))
			]);
			return results
				.flat()
				.filter((row) => row.readyAt !== null && row.readyAt <= now)
				.map((row) => ({ id: row.jobId, generation: row.jobGeneration }));
		});
	}

	async hasDue(now: IsoTimestamp): Promise<boolean> {
		return this.execute(async () => {
			const table = schema.sharedListingJobDispatch;
			const row = await this.database
				.select({ id: table.id })
				.from(table)
				.where(lte(table.nextDeliveryAt, now))
				.orderBy(asc(table.nextDeliveryAt), asc(table.id))
				.limit(1)
				.get();
			return row !== undefined;
		});
	}

	async claim(
		input: ArtifactJobVersion,
		owner: ArtifactTaskOwner,
		now: IsoTimestamp
	): Promise<SharedListingDispatchClaimResult> {
		const job = artifactJobVersionSchema.parse(input);
		return this.execute(async () => {
			const table = schema.sharedListingJobDispatch;
			const version = this.identity(job);
			const active = this.active(version);
			const readyAt = this.nextAt(version, now);
			const identity = and(
				eq(table.jobId, job.id),
				eq(table.jobGeneration, job.generation),
				exists(active)
			);
			const eligible = and(
				identity,
				lt(table.claimGeneration, Number.MAX_SAFE_INTEGER),
				or(isNull(table.leaseExpiresAt), lte(table.leaseExpiresAt, now)),
				lte(readyAt, now)
			);
			const deadline = isoTimestamp(new Date(Date.parse(now) + leaseMs));
			const [changed, current] = await this.database.batch([
				this.database
					.update(table)
					.set({
						claimGeneration: sql`${table.claimGeneration}+1`,
						owner,
						leaseExpiresAt: deadline,
						nextDeliveryAt: deadline
					})
					.where(eligible)
					.returning(),
				this.database.select().from(table).where(identity)
			]);
			const claimed = changed[0];
			if (claimed !== undefined) {
				return { kind: 'claimed', claim: this.decoded(claimed) };
			}
			const row = current[0];
			if (
				row?.owner === owner &&
				row.leaseExpiresAt !== null &&
				row.leaseExpiresAt > now
			) {
				return { kind: 'claimed', claim: this.decoded(row) };
			}
			if (
				row?.leaseExpiresAt !== undefined &&
				row.leaseExpiresAt !== null &&
				row.leaseExpiresAt > now
			) {
				return { kind: 'busy', retryAt: row.leaseExpiresAt };
			}
			return { kind: 'unavailable' };
		});
	}

	async finish(
		input: SharedListingDispatchClaim,
		now: IsoTimestamp
	): Promise<boolean> {
		const claim = sharedListingDispatchClaimSchema.parse(input);
		return this.execute(async () => {
			const job = this.identity(claim.job);
			const current = this.owns(claim, now);
			const next = this.nextAt(job, now);
			const owned = this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingJobDispatch)
				.where(current);
			const finalizer = new SharedListingJobStore(this.database);
			const [finished, rows] = await this.database.batch([
				finalizer.finalizeStatement(claim.job, now, exists(owned)),
				this.rotate(current, next, now)
			]);
			return finished.length > 0 || rows.length > 0;
		});
	}

	async seed(
		input: SharedListingDispatchClaim,
		now: IsoTimestamp
	): Promise<boolean> {
		const claim = sharedListingDispatchClaimSchema.parse(input);
		return this.execute(async () => {
			const table = schema.sharedListingJobDispatch;
			const scope = await this.database
				.select()
				.from(table)
				.where(this.owns(claim, now))
				.get();
			if (scope === undefined || scope.isSeeded) {
				return false;
			}
			let through: NixSha256HashString | undefined =
				scope.seedThrough ?? undefined;
			if (through === undefined) {
				const highest = await this.database
					.select({ narHash: schema.sharedListingTask.narHash })
					.from(schema.sharedListingTask)
					.where(eq(schema.sharedListingTask.jobId, claim.job.id))
					.orderBy(desc(schema.sharedListingTask.narHash))
					.limit(1)
					.get();
				through = highest?.narHash;
			}
			const page =
				through === undefined
					? []
					: await this.database
							.select({ narHash: schema.sharedListingTask.narHash })
							.from(schema.sharedListingTask)
							.where(
								and(
									eq(schema.sharedListingTask.jobId, claim.job.id),
									scope.seedAfter === null
										? undefined
										: gt(schema.sharedListingTask.narHash, scope.seedAfter),
									lte(schema.sharedListingTask.narHash, through)
								)
							)
							.orderBy(asc(schema.sharedListingTask.narHash))
							.limit(seedPageSize + 1);
			const selected = page.slice(0, seedPageSize);
			const hashes = jsonValueList(selected.map((row) => row.narHash));
			const fenced = this.database
				.select({ one: sql`1` })
				.from(table)
				.where(this.seedFence(claim, scope, now));
			const source = sql`SELECT task.id,task.job_id,CASE WHEN task.state='running' THEN task.claim_job_generation ELSE job.generation END,task.state,lower(hex(randomblob(16))),CASE WHEN task.state='running' THEN task.lease_expires_at ELSE task.ready_at END
    FROM shared_listing_task AS task JOIN shared_listing_job AS job ON job.id=task.job_id
    WHERE task.job_id=${claim.job.id} AND task.nar_hash IN (${hashes}) AND task.state IN ('pending','running') AND ${exists(fenced)}`;
			const [, updated] = await this.database.batch([
				this.database
					.insert(schema.sharedListingTaskDelivery)
					.select(source)
					.onConflictDoNothing(),
				this.database
					.update(table)
					.set({
						seedAfter: selected.at(-1)?.narHash ?? scope.seedAfter ?? sql`null`,
						seedThrough: through ?? sql`null`,
						isSeeded: page.length <= seedPageSize
					})
					.where(this.seedFence(claim, scope, now))
					.returning({ id: table.id })
			]);
			return updated.length > 0;
		});
	}
}
