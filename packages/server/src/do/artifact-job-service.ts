import { type CacheScope } from '@cupboard/nix-store/scalars';
import {
	type ArtifactJobDefinition,
	artifactJobDefinitionSchema,
	artifactJobGenerationSchema,
	type ArtifactJobId,
	artifactJobIdSchema,
	type ArtifactJobSummary,
	artifactJobSummarySchema,
	type ArtifactJobVersion,
	type ArtifactTaskClaim,
	type ArtifactTaskClaimResult,
	artifactTaskGenerationSchema,
	type ArtifactTaskId,
	artifactTaskIdSchema,
	type ArtifactTaskOutcome,
	type ArtifactTaskOwner,
	type ArtifactTaskSource,
	artifactTaskSourceSchema
} from '@cupboard/protocol/artifact-jobs';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, gt, lt, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import type { ServerContext } from './context.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';

const leaseDurationMs = 60_000;
const claimScanLimit = 8;
const discoveryPageSize = 32;
type Job = typeof schema.artifactJobs.$inferSelect;
type Task = typeof schema.artifactTasks.$inferSelect;

export interface ArtifactDiscoveryPage {
	readonly discovered: number;
	readonly isComplete: boolean;
}

export class ArtifactJobService {
	constructor(private readonly context: ServerContext) {}

	private row(id: ArtifactJobId): Job | undefined {
		return this.context.db
			.select()
			.from(schema.artifactJobs)
			.where(eq(schema.artifactJobs.id, id))
			.get();
	}
	private current(id: ArtifactJobId): Job | undefined {
		const job = this.row(id);
		if (job?.state !== 'running') {
			return;
		}
		const historical = this.context.cacheRepository.resolvedForId(job.cacheId);
		const cache = this.context.cacheRepository.resolve(historical.scope);
		return cache?.id === job.cacheId && cache.generation === job.cacheGeneration
			? job
			: undefined;
	}
	private sourceKey(source: ArtifactTaskSource): string {
		return JSON.stringify(artifactTaskSourceSchema.parse(source));
	}
	private sourceCurrent(job: Job, source: ArtifactTaskSource): boolean {
		if (source.kind === 'nar') {
			if (job.definition.kind !== 'listing') {
				return false;
			}
			const row = this.context.db
				.select({
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, job.cacheId),
						eq(schema.narInfos.storePathHash, source.storePathHash)
					)
				)
				.get();
			return (
				row?.generation === source.generation && row.narHash === source.narHash
			);
		}
		if (job.definition.kind === 'listing') {
			return false;
		}
		const expectedKind =
			job.definition.kind === 'listing-proof' ? 'listing' : job.definition.kind;
		const row = this.context.db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, source.id))
			.get();
		return (
			row?.cacheId === job.cacheId &&
			row.kind === expectedKind &&
			row.state === 'live' &&
			row.generation === source.generation &&
			row.digest === source.digest &&
			(row.expiresAt === null || row.expiresAt > isoTimestamp(new Date()))
		);
	}
	private completeIfReady(id: ArtifactJobId): void {
		this.context.db
			.update(schema.artifactJobs)
			.set({
				state: 'complete',
				completedAt: isoTimestamp(new Date()),
				updatedAt: isoTimestamp(new Date())
			})
			.where(
				and(
					eq(schema.artifactJobs.id, id),
					eq(schema.artifactJobs.state, 'running'),
					eq(schema.artifactJobs.discoveryComplete, true),
					sql`${schema.artifactJobs.discovered} = ${schema.artifactJobs.completed} + ${schema.artifactJobs.skipped} + ${schema.artifactJobs.failed}`
				)
			)
			.run();
	}
	private outcome(task: Task, outcome: ArtifactTaskOutcome): void {
		this.context.db.transaction((database) => {
			const changed = database
				.update(schema.artifactTasks)
				.set({
					state: outcome,
					completedAt: isoTimestamp(new Date()),
					owner: sql`null`,
					leaseExpiresAt: sql`null`
				})
				.where(
					and(
						eq(schema.artifactTasks.id, task.id),
						eq(schema.artifactTasks.state, task.state),
						eq(schema.artifactTasks.claimGeneration, task.claimGeneration)
					)
				)
				.returning({ id: schema.artifactTasks.id })
				.all();
			if (changed.length === 0) {
				return;
			}
			const column = schema.artifactJobs[outcome];
			database
				.update(schema.artifactJobs)
				.set({
					[outcome]: sql`${column} + 1`,
					updatedAt: isoTimestamp(new Date())
				})
				.where(eq(schema.artifactJobs.id, task.jobId))
				.run();
			this.completeIfReady(task.jobId);
		});
	}
	private pending(id: ArtifactJobId): boolean {
		const job = this.current(id);
		return (
			job !== undefined &&
			job.discovered > job.completed + job.skipped + job.failed
		);
	}
	private candidates(job: Job): Task[] {
		const now = isoTimestamp(new Date());
		const base = and(
			eq(schema.artifactTasks.jobId, job.id),
			eq(schema.artifactTasks.state, 'claimed')
		);
		const stale = this.context.db
			.select()
			.from(schema.artifactTasks)
			.where(and(base, lt(schema.artifactTasks.jobGeneration, job.generation)))
			.orderBy(
				asc(schema.artifactTasks.jobGeneration),
				asc(schema.artifactTasks.id)
			)
			.limit(claimScanLimit)
			.all();
		if (stale.length === claimScanLimit) {
			return stale;
		}
		const expired = this.context.db
			.select()
			.from(schema.artifactTasks)
			.where(
				and(
					base,
					eq(schema.artifactTasks.jobGeneration, job.generation),
					lte(schema.artifactTasks.leaseExpiresAt, now)
				)
			)
			.orderBy(
				asc(schema.artifactTasks.leaseExpiresAt),
				asc(schema.artifactTasks.id)
			)
			.limit(claimScanLimit - stale.length)
			.all();
		const captured = [...stale, ...expired];
		if (captured.length === claimScanLimit) {
			return captured;
		}
		const pending = this.context.db
			.select()
			.from(schema.artifactTasks)
			.where(
				and(
					eq(schema.artifactTasks.jobId, job.id),
					eq(schema.artifactTasks.state, 'pending')
				)
			)
			.orderBy(asc(schema.artifactTasks.id))
			.limit(claimScanLimit - captured.length)
			.all();
		return [...captured, ...pending];
	}
	private owned(claim: ArtifactTaskClaim): Task | undefined {
		const job = this.current(claim.jobId);
		if (
			job?.generation !== claim.jobGeneration ||
			job.cacheGeneration !== claim.cacheGeneration
		) {
			return;
		}
		const task = this.context.db
			.select()
			.from(schema.artifactTasks)
			.where(eq(schema.artifactTasks.id, claim.id))
			.get();
		if (
			task?.jobId !== job.id ||
			task.state !== 'claimed' ||
			task.owner !== claim.owner ||
			task.claimGeneration !== claim.generation ||
			task.jobGeneration !== claim.jobGeneration ||
			task.leaseExpiresAt === null ||
			task.leaseExpiresAt <= isoTimestamp(new Date()) ||
			task.sourceKey !== this.sourceKey(claim.source) ||
			!this.sourceCurrent(job, task.source)
		) {
			return;
		}
		return task;
	}

	async startInSection(
		scope: CacheScope,
		input: ArtifactJobDefinition
	): Promise<ArtifactJobSummary> {
		await new PathReadAuthorityService(this.context).requireWritable();
		const cache = this.context.cacheRepository.require(scope);
		const definition = artifactJobDefinitionSchema.parse(input);
		const id = artifactJobIdSchema.parse(crypto.randomUUID());
		const now = isoTimestamp(new Date());
		this.context.db
			.insert(schema.artifactJobs)
			.values({
				id,
				cacheId: cache.id,
				cacheGeneration: cache.generation,
				definition,
				generation: artifactJobGenerationSchema.parse(1),
				state: 'running',
				createdAt: now,
				updatedAt: now
			})
			.run();
		const summary = this.summaryInSection(id);
		if (summary === undefined) {
			throw new Error('The newly created artifact job is missing');
		}
		return summary;
	}
	/**
	 * Shared byte authority is checked by the executor before it reads a source.
	 */
	enqueueInSection(
		version: ArtifactJobVersion,
		input: ArtifactTaskSource
	): ArtifactTaskId | undefined {
		const { id, generation } = version;
		const job = this.current(id);
		const source = artifactTaskSourceSchema.parse(input);
		if (
			job?.generation !== generation ||
			job.discoveryComplete ||
			!this.sourceCurrent(job, source)
		) {
			return;
		}
		const sourceKey = this.sourceKey(source);
		return this.context.db.transaction((database) => {
			const inserted = database
				.insert(schema.artifactTasks)
				.values({
					id: artifactTaskIdSchema.parse(crypto.randomUUID()),
					jobId: id,
					sourceKey,
					source,
					createdAt: isoTimestamp(new Date())
				})
				.onConflictDoNothing({
					target: [schema.artifactTasks.jobId, schema.artifactTasks.sourceKey]
				})
				.returning({ id: schema.artifactTasks.id })
				.all();
			const created = inserted[0];
			if (created !== undefined) {
				database
					.update(schema.artifactJobs)
					.set({
						discovered: sql`${schema.artifactJobs.discovered} + 1`,
						updatedAt: isoTimestamp(new Date())
					})
					.where(eq(schema.artifactJobs.id, id))
					.run();
				return created.id;
			}
			return database
				.select({ id: schema.artifactTasks.id })
				.from(schema.artifactTasks)
				.where(
					and(
						eq(schema.artifactTasks.jobId, id),
						eq(schema.artifactTasks.sourceKey, sourceKey)
					)
				)
				.get()?.id;
		});
	}
	discoverListingsInSection(
		version: ArtifactJobVersion
	): ArtifactDiscoveryPage | undefined {
		const job = this.current(version.id);
		if (
			job?.generation !== version.generation ||
			job.definition.kind !== 'listing' ||
			job.discoveryComplete
		) {
			return;
		}
		const records = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				generation: schema.narInfos.generation,
				narHash: schema.narInfos.narHash
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, job.cacheId),
					job.cursor === null
						? undefined
						: gt(schema.narInfos.storePathHash, job.cursor)
				)
			)
			.orderBy(asc(schema.narInfos.storePathHash))
			.limit(discoveryPageSize + 1)
			.all();
		const selected = records.slice(0, discoveryPageSize);
		for (const source of selected) {
			this.enqueueInSection(version, { kind: 'nar', ...source });
		}
		const cursor = selected.at(-1)?.storePathHash ?? job.cursor ?? undefined;
		const isComplete = records.length <= discoveryPageSize;
		if (!this.checkpointInSection(version, cursor, isComplete)) {
			return;
		}
		const updated = this.row(job.id);
		if (updated === undefined) {
			throw new Error('The artifact discovery job is missing');
		}
		return {
			discovered: updated.discovered - job.discovered,
			isComplete
		};
	}

	claimInSection(
		id: ArtifactJobId,
		owner: ArtifactTaskOwner
	): ArtifactTaskClaimResult {
		const job = this.current(id);
		if (job === undefined) {
			return { pending: false };
		}
		for (const task of this.candidates(job)) {
			if (!this.sourceCurrent(job, task.source)) {
				this.outcome(task, 'skipped');
				continue;
			}
			const generation = artifactTaskGenerationSchema.parse(
				task.claimGeneration + 1
			);
			const leaseExpiresAt = isoTimestamp(
				new Date(Date.now() + leaseDurationMs)
			);
			this.context.db
				.update(schema.artifactTasks)
				.set({
					state: 'claimed',
					owner,
					claimGeneration: generation,
					jobGeneration: job.generation,
					leaseExpiresAt
				})
				.where(eq(schema.artifactTasks.id, task.id))
				.run();
			return {
				claim: {
					id: task.id,
					jobId: id,
					jobGeneration: job.generation,
					generation,
					owner,
					cacheGeneration: job.cacheGeneration,
					source: task.source,
					leaseExpiresAt
				},
				pending: true
			};
		}
		return { pending: this.pending(id) };
	}
	claimDeadlineInSection(claim: ArtifactTaskClaim): IsoTimestamp | undefined {
		return this.owned(claim)?.leaseExpiresAt ?? undefined;
	}

	renewInSection(claim: ArtifactTaskClaim): IsoTimestamp | undefined {
		if (this.owned(claim) === undefined) {
			return;
		}
		const expiresAt = isoTimestamp(new Date(Date.now() + leaseDurationMs));
		this.context.db
			.update(schema.artifactTasks)
			.set({ leaseExpiresAt: expiresAt })
			.where(eq(schema.artifactTasks.id, claim.id))
			.run();
		return expiresAt;
	}
	finishInSection(
		claim: ArtifactTaskClaim,
		outcome: ArtifactTaskOutcome
	): boolean {
		const task = this.owned(claim);
		if (task === undefined) {
			return false;
		}
		this.outcome(task, outcome);
		return true;
	}
	cancelInSection(id: ArtifactJobId): boolean {
		const job = this.row(id);
		if (job?.state !== 'running') {
			return false;
		}
		this.context.db
			.update(schema.artifactJobs)
			.set({
				state: 'cancelled',
				generation: artifactJobGenerationSchema.parse(job.generation + 1),
				updatedAt: isoTimestamp(new Date())
			})
			.where(eq(schema.artifactJobs.id, id))
			.run();
		return true;
	}
	resumeInSection(id: ArtifactJobId): boolean {
		const job = this.row(id);
		if (job?.state !== 'cancelled') {
			return false;
		}
		const cache = this.context.cacheRepository.resolve(
			this.context.cacheRepository.scopeForId(job.cacheId)
		);
		if (cache?.id !== job.cacheId || cache.generation !== job.cacheGeneration) {
			return false;
		}
		this.context.db
			.update(schema.artifactJobs)
			.set({
				state: 'running',
				generation: artifactJobGenerationSchema.parse(job.generation + 1),
				updatedAt: isoTimestamp(new Date())
			})
			.where(eq(schema.artifactJobs.id, id))
			.run();
		return true;
	}
	checkpointInSection(
		version: ArtifactJobVersion,
		cursor: ArtifactJobSummary['cursor'],
		isComplete = false
	): boolean {
		const { id, generation } = version;
		const job = this.current(id);
		if (
			job?.generation !== generation ||
			job.discoveryComplete ||
			(job.cursor !== null && (cursor === undefined || cursor < job.cursor))
		) {
			return false;
		}
		this.context.db
			.update(schema.artifactJobs)
			.set({
				cursor: cursor ?? sql`null`,
				discoveryComplete: isComplete,
				updatedAt: isoTimestamp(new Date())
			})
			.where(eq(schema.artifactJobs.id, id))
			.run();
		this.completeIfReady(id);
		return true;
	}
	summaryInSection(id: ArtifactJobId): ArtifactJobSummary | undefined {
		const job = this.row(id);
		if (job === undefined) {
			return;
		}
		return artifactJobSummarySchema.parse({
			id,
			definition: job.definition,
			cache: this.context.cacheRepository.scopeForId(job.cacheId),
			cacheGeneration: job.cacheGeneration,
			generation: job.generation,
			state: job.state,
			discoveryComplete: job.discoveryComplete,
			cursor: job.cursor ?? undefined,
			progress: {
				discovered: job.discovered,
				completed: job.completed,
				skipped: job.skipped,
				failed: job.failed
			},
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			completedAt: job.completedAt ?? undefined
		});
	}
}
