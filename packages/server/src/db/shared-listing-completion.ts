import { type ArtifactTaskId } from '@cupboard/protocol/artifact-jobs';
import { type NarListingFact } from '@cupboard/protocol/artifacts';
import { hasReachedTransitionState } from '@cupboard/protocol/deployment';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, exists, notExists, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import {
	type SharedListingCompletionId,
	sharedListingCompletionIdSchema,
	type SharedListingCompletionOutput,
	sharedListingCompletionOutputSchema,
	type SharedListingCompletionResult,
	type SharedListingTaskFailure,
	sharedListingTaskFailureSchema,
	type SharedListingTaskOutcome,
	sharedListingTaskOutcomeSchema
} from '../blob/shared-listing-completion.ts';
import {
	type SharedListingGenerationClaim,
	sharedListingGenerationClaimSchema
} from '../blob/shared-listing-generation.ts';
import {
	type SharedListingTaskClaim,
	sharedListingTaskClaimSchema
} from '../blob/shared-listing-tasks.ts';
import {
	ListingFactConflictError,
	SharedFactsUnavailableError
} from '../errors.ts';

import * as schema from './d1-schema.ts';
import { recordedTransitions } from './deployment-transitions.ts';
import { SharedListingGenerationStore } from './shared-listing-generation.ts';
import { SharedListingJobStore } from './shared-listing-jobs.ts';
import { SharedListingOutputStore } from './shared-listing-outputs.ts';
import { SharedListingTaskStore } from './shared-listing-tasks.ts';

type Row = typeof schema.sharedListingTaskOutcome.$inferSelect;

export class SharedListingTaskOutcomeConflictError extends Error {
	constructor() {
		super('This task already records a different terminal outcome');
		this.name = 'SharedListingTaskOutcomeConflictError';
	}
}

export class SharedListingCompletionStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private async execute<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (
				error instanceof ListingFactConflictError ||
				error instanceof SharedListingTaskOutcomeConflictError ||
				error instanceof SharedFactsUnavailableError
			) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}

	private async ready() {
		const row = await this.database
			.select({
				id: schema.deploymentTransition.id,
				state: schema.deploymentTransition.state
			})
			.from(schema.deploymentTransition)
			.where(eq(schema.deploymentTransition.id, 'shared-listing-completion'))
			.get();
		return hasReachedTransitionState(
			recordedTransitions(row === undefined ? [] : [row]).get(
				'shared-listing-completion'
			),
			'expanded'
		);
	}

	private decoded(row: Row): SharedListingTaskOutcome {
		const common = {
			claim: row.claim,
			kind: row.kind,
			completedAt: row.completedAt
		};
		if (row.kind === 'failed' || row.kind === 'skipped') {
			return sharedListingTaskOutcomeSchema.parse({
				...common,
				reason: row.reason
			});
		}
		return sharedListingTaskOutcomeSchema.parse({
			...common,
			fact: row.fact,
			incarnation: row.incarnation,
			referenceEpoch: row.referenceEpoch,
			computationGeneration: row.computationGeneration ?? undefined,
			...(row.kind === 'generated' && { stageId: row.stageId })
		});
	}

	private async outcome(id: ArtifactTaskId) {
		return this.database
			.select()
			.from(schema.sharedListingTaskOutcome)
			.where(eq(schema.sharedListingTaskOutcome.taskId, id))
			.get();
	}

	private sameClaim(
		left: SharedListingTaskClaim,
		right: SharedListingTaskClaim
	) {
		return (
			left.id === right.id &&
			left.job.id === right.job.id &&
			left.job.generation === right.job.generation &&
			left.generation === right.generation &&
			left.owner === right.owner &&
			left.narHash === right.narHash &&
			left.generatorRevision === right.generatorRevision &&
			left.sourceIncarnation === right.sourceIncarnation &&
			left.narSize === right.narSize &&
			left.fileSize === right.fileSize
		);
	}

	private replay(
		row: Row | undefined,
		task: SharedListingTaskClaim,
		value: SharedListingCompletionOutput | SharedListingTaskFailure
	): SharedListingCompletionResult | undefined {
		if (row === undefined) {
			return undefined;
		}
		const outcome = this.decoded(row);
		if (!this.sameClaim(outcome.claim, task)) {
			return { kind: 'unavailable' };
		}
		if (outcome.kind !== value.kind) {
			throw new SharedListingTaskOutcomeConflictError();
		}
		if (outcome.kind === 'failed' || outcome.kind === 'skipped') {
			if (!('reason' in value) || outcome.reason !== value.reason) {
				throw new SharedListingTaskOutcomeConflictError();
			}
		} else {
			if (
				!('fact' in value) ||
				outcome.fact.digest !== value.fact.digest ||
				outcome.fact.size !== value.fact.size ||
				outcome.fact.narHash !== value.fact.narHash ||
				outcome.fact.generatorRevision !== value.fact.generatorRevision
			) {
				throw new ListingFactConflictError();
			}
		}
		return { kind: 'already-recorded', outcome };
	}

	private matchingFact(fact: NarListingFact) {
		const measurement = and(
			eq(schema.listingFact.narHash, fact.narHash),
			eq(schema.listingFact.generatorRevision, fact.generatorRevision),
			eq(schema.listingFact.digest, fact.digest),
			eq(schema.listingFact.size, fact.size)
		);
		return exists(
			this.database
				.select({ one: sql`1` })
				.from(schema.listingFact)
				.where(measurement)
		);
	}

	private root(fact: NarListingFact) {
		return and(
			eq(schema.sharedListingOutputReference.narHash, fact.narHash),
			eq(
				schema.sharedListingOutputReference.generatorRevision,
				fact.generatorRevision
			),
			eq(schema.sharedListingOutputReference.digest, fact.digest),
			eq(schema.sharedListingOutputReference.size, fact.size)
		);
	}

	private cas(fact: NarListingFact, incarnation: number) {
		const live = registeredLiveObjectIncarnation(
			this.database,
			'cas',
			fact.digest,
			incarnation
		);
		const measurement = and(
			eq(schema.casObject.digest, fact.digest),
			eq(schema.casObject.incarnation, incarnation),
			eq(schema.casObject.size, fact.size),
			live
		);
		return exists(
			this.database
				.select({ one: sql`1` })
				.from(schema.casObject)
				.where(measurement)
		);
	}

	private generation(task: SharedListingTaskClaim) {
		return and(
			eq(schema.sharedListingGeneration.narHash, task.narHash),
			eq(
				schema.sharedListingGeneration.generatorRevision,
				task.generatorRevision
			),
			eq(
				schema.sharedListingGeneration.sourceIncarnation,
				task.sourceIncarnation
			),
			eq(schema.sharedListingGeneration.jobId, task.job.id),
			eq(schema.sharedListingGeneration.jobGeneration, task.job.generation),
			eq(schema.sharedListingGeneration.taskId, task.id),
			eq(schema.sharedListingGeneration.taskGeneration, task.generation),
			eq(schema.sharedListingGeneration.owner, task.owner)
		);
	}

	private stage(
		claim: SharedListingGenerationClaim,
		output: Extract<SharedListingCompletionOutput, { kind: 'generated' }>
	) {
		const ready = and(
			eq(schema.sharedListingStage.id, output.stageId),
			eq(schema.sharedListingStage.narHash, claim.task.narHash),
			eq(
				schema.sharedListingStage.generatorRevision,
				claim.task.generatorRevision
			),
			eq(
				schema.sharedListingStage.sourceIncarnation,
				claim.task.sourceIncarnation
			),
			eq(schema.sharedListingStage.computationGeneration, claim.generation),
			eq(schema.sharedListingStage.state, 'ready'),
			eq(schema.sharedListingStage.writesSealed, true),
			eq(schema.sharedListingStage.cleanupGeneration, 0),
			eq(schema.sharedListingStage.digest, output.fact.digest),
			eq(schema.sharedListingStage.size, output.fact.size)
		);
		return exists(
			this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingStage)
				.where(ready)
		);
	}

	private receipt(task: SharedListingTaskClaim, id: SharedListingCompletionId) {
		const captured = and(
			eq(schema.sharedListingTaskOutcome.taskId, task.id),
			eq(schema.sharedListingTaskOutcome.completionId, id)
		);
		return exists(
			this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingTaskOutcome)
				.where(captured)
		);
	}

	private terminalStatements(
		task: SharedListingTaskClaim,
		id: SharedListingCompletionId,
		kind: SharedListingTaskOutcome['kind'],
		now: IsoTimestamp
	) {
		const receipt = this.receipt(task, id);
		const state =
			kind === 'generated' || kind === 'reused' ? 'completed' : kind;
		const counter = this.database
			.update(schema.sharedListingJob)
			.set({
				[state]: sql`${schema.sharedListingJob[state]} + 1`,
				updatedAt: sql`max(${schema.sharedListingJob.updatedAt},${now})`
			})
			.where(
				and(
					eq(schema.sharedListingJob.id, task.job.id),
					eq(schema.sharedListingJob.generation, task.job.generation),
					eq(schema.sharedListingJob.state, 'running'),
					receipt
				)
			);
		const terminal = this.database
			.update(schema.sharedListingTask)
			.set({ state, leaseExpiresAt: sql`null`, updatedAt: now })
			.where(
				and(new SharedListingTaskStore(this.database).owns(task, now), receipt)
			);
		const matchingGeneration = this.database
			.select({ generation: schema.sharedListingGeneration.generation })
			.from(schema.sharedListingGeneration)
			.where(this.generation(task));
		const retiredAt = sql<IsoTimestamp>`CASE WHEN ${schema.sharedListingStage.writesSealed} = 1 THEN ${now} ELSE ${schema.sharedListingStage.cleanupAfter} END`;
		const retire = this.database
			.update(schema.sharedListingStage)
			.set({
				state: 'retired',
				cleanupAfter: retiredAt,
				nextCleanupAt: retiredAt
			})
			.where(
				and(
					eq(schema.sharedListingStage.narHash, task.narHash),
					eq(
						schema.sharedListingStage.generatorRevision,
						task.generatorRevision
					),
					eq(
						schema.sharedListingStage.sourceIncarnation,
						task.sourceIncarnation
					),
					eq(
						schema.sharedListingStage.computationGeneration,
						sql`(${matchingGeneration})`
					),
					receipt
				)
			);
		const release = this.database
			.update(schema.sharedListingGeneration)
			.set({
				owner: sql`null`,
				leaseExpiresAt: sql`null`,
				updatedAt: sql`max(${schema.sharedListingGeneration.updatedAt},${now})`
			})
			.where(and(this.generation(task), receipt));
		const finish = new SharedListingJobStore(this.database).finalizeStatement(
			task.job,
			now,
			receipt
		);
		return { counter, terminal, retire, release, finish };
	}

	private async conflict(fact: NarListingFact) {
		const factKey = and(
			eq(schema.listingFact.narHash, fact.narHash),
			eq(schema.listingFact.generatorRevision, fact.generatorRevision)
		);
		const referenceKey = and(
			eq(schema.sharedListingOutputReference.narHash, fact.narHash),
			eq(
				schema.sharedListingOutputReference.generatorRevision,
				fact.generatorRevision
			)
		);
		const [facts, roots] = await this.database.batch([
			this.database.select().from(schema.listingFact).where(factKey),
			this.database
				.select()
				.from(schema.sharedListingOutputReference)
				.where(referenceKey)
		]);
		if (
			[...facts, ...roots].some(
				(row) => row.digest !== fact.digest || row.size !== fact.size
			)
		) {
			throw new ListingFactConflictError();
		}
	}

	private async record(
		task: SharedListingTaskClaim,
		output: SharedListingCompletionOutput,
		now: IsoTimestamp,
		claim?: SharedListingGenerationClaim
	): Promise<SharedListingCompletionResult> {
		if (!(await this.ready())) {
			return { kind: 'unavailable' };
		}
		if (
			task.narHash !== output.fact.narHash ||
			task.generatorRevision !== output.fact.generatorRevision
		) {
			return { kind: 'unavailable' };
		}
		const replay = this.replay(await this.outcome(task.id), task, output);
		if (replay !== undefined) {
			return replay;
		}
		await this.conflict(output.fact);
		const id = sharedListingCompletionIdSchema.parse(crypto.randomUUID());
		const absent = notExists(
			this.database
				.select({ one: sql`1` })
				.from(schema.sharedListingTaskOutcome)
				.where(eq(schema.sharedListingTaskOutcome.taskId, task.id))
		);
		const source = new SharedListingGenerationStore(this.database).source(
			task,
			now
		);
		const proof =
			claim !== undefined && output.kind === 'generated'
				? this.stage(claim, output)
				: this.matchingFact(output.fact);
		const eligible =
			claim === undefined
				? and(absent, source, this.cas(output.fact, output.incarnation), proof)
				: and(absent, proof);
		const retained =
			claim === undefined
				? undefined
				: new SharedListingOutputStore(this.database).retentionStatements(
						{ claim, fact: output.fact, incarnation: output.incarnation, now },
						eligible
					);
		const current = retained?.current ?? eligible;

		const measuredFact = this.database
			.select({
				narHash: schema.sharedListingOutputReference.narHash,
				generatorRevision:
					schema.sharedListingOutputReference.generatorRevision,
				format: sql<1>`1`.as('format'),
				digest: schema.sharedListingOutputReference.digest,
				size: schema.sharedListingOutputReference.size,
				createdAt: sql<IsoTimestamp>`${now}`.as('created_at')
			})
			.from(schema.sharedListingOutputReference)
			.where(and(this.root(output.fact), current));
		const fact = this.database
			.insert(schema.listingFact)
			.select(measuredFact)
			.onConflictDoNothing();
		const capturedOutcome = this.database
			.select({
				taskId: sql<typeof task.id>`${task.id}`.as('task_id'),
				jobId: sql<typeof task.job.id>`${task.job.id}`.as('job_id'),
				jobGeneration: sql<
					typeof task.job.generation
				>`${task.job.generation}`.as('job_generation'),
				taskGeneration: sql<typeof task.generation>`${task.generation}`.as(
					'task_generation'
				),
				owner: sql<typeof task.owner>`${task.owner}`.as('owner'),
				claim: sql<SharedListingTaskClaim>`${JSON.stringify(task)}`.as('claim'),
				completionId: sql<typeof id>`${id}`.as('completion_id'),
				kind: sql<SharedListingTaskOutcome['kind']>`${output.kind}`.as('kind'),
				fact: sql<NarListingFact>`${JSON.stringify(output.fact)}`.as('fact'),
				incarnation: sql<number>`${output.incarnation}`.as('incarnation'),
				referenceEpoch: schema.sharedListingOutputReference.epoch,
				computationGeneration:
					claim === undefined
						? sql`null`.as('computation_generation')
						: sql<number>`${claim.generation}`.as('computation_generation'),
				stageId:
					output.kind === 'generated'
						? sql<typeof output.stageId>`${output.stageId}`.as('stage_id')
						: sql`null`.as('stage_id'),
				reason: sql`null`.as('reason'),
				completedAt: sql<IsoTimestamp>`${now}`.as('completed_at')
			})
			.from(schema.sharedListingOutputReference)
			.where(
				and(this.root(output.fact), current, this.matchingFact(output.fact))
			);
		const outcome = this.database
			.insert(schema.sharedListingTaskOutcome)
			.select(capturedOutcome)
			.onConflictDoNothing();
		const { counter, terminal, retire, release, finish } =
			this.terminalStatements(task, id, output.kind, now);
		if (retained === undefined) {
			await this.database.batch([
				fact,
				outcome,
				counter,
				terminal,
				retire,
				release,
				finish
			]);
		} else {
			await this.database.batch([
				retained.insert,
				retained.clearGrace,
				fact,
				outcome,
				counter,
				terminal,
				retire,
				release,
				finish
			]);
		}
		const stored = await this.outcome(task.id);
		if (stored?.completionId === id) {
			return { kind: 'recorded', outcome: this.decoded(stored) };
		}
		const repeated = this.replay(stored, task, output);
		if (repeated !== undefined) {
			return repeated;
		}
		await this.conflict(output.fact);
		return { kind: 'unavailable' };
	}

	async complete(
		input: SharedListingGenerationClaim,
		value: SharedListingCompletionOutput,
		now: IsoTimestamp
	): Promise<SharedListingCompletionResult> {
		const claim = sharedListingGenerationClaimSchema.parse(input);
		const output = sharedListingCompletionOutputSchema.parse(value);
		return this.execute(() => this.record(claim.task, output, now, claim));
	}

	async reuse(
		input: SharedListingTaskClaim,
		value: { readonly fact: NarListingFact; readonly incarnation: number },
		now: IsoTimestamp
	): Promise<SharedListingCompletionResult> {
		const task = sharedListingTaskClaimSchema.parse(input);
		const output = sharedListingCompletionOutputSchema.parse({
			kind: 'reused',
			...value
		});
		return this.execute(() => this.record(task, output, now));
	}

	async finish(
		input: SharedListingTaskClaim,
		value: SharedListingTaskFailure,
		now: IsoTimestamp
	): Promise<SharedListingCompletionResult> {
		const task = sharedListingTaskClaimSchema.parse(input);
		const failure = sharedListingTaskFailureSchema.parse(value);
		return this.execute(async () => {
			if (!(await this.ready())) {
				return { kind: 'unavailable' };
			}
			const replay = this.replay(await this.outcome(task.id), task, failure);
			if (replay !== undefined) {
				return replay;
			}
			const id = sharedListingCompletionIdSchema.parse(crypto.randomUUID());
			const capturedOutcome = this.database
				.select({
					taskId: schema.sharedListingTask.id,
					jobId: schema.sharedListingTask.jobId,
					jobGeneration: sql<
						typeof task.job.generation
					>`${task.job.generation}`.as('job_generation'),
					taskGeneration: schema.sharedListingTask.claimGeneration,
					owner: schema.sharedListingTask.claimOwner,
					claim: sql<SharedListingTaskClaim>`${JSON.stringify(task)}`.as(
						'claim'
					),
					completionId: sql<typeof id>`${id}`.as('completion_id'),
					kind: sql<SharedListingTaskOutcome['kind']>`${failure.kind}`.as(
						'kind'
					),
					fact: sql`null`.as('fact'),
					incarnation: sql`null`.as('incarnation'),
					referenceEpoch: sql`null`.as('reference_epoch'),
					computationGeneration: sql`null`.as('computation_generation'),
					stageId: sql`null`.as('stage_id'),
					reason: sql<typeof failure.reason>`${failure.reason}`.as('reason'),
					completedAt: sql<IsoTimestamp>`${now}`.as('completed_at')
				})
				.from(schema.sharedListingTask)
				.where(new SharedListingTaskStore(this.database).owns(task, now));
			const outcome = this.database
				.insert(schema.sharedListingTaskOutcome)
				.select(capturedOutcome)
				.onConflictDoNothing();
			const { counter, terminal, retire, release, finish } =
				this.terminalStatements(task, id, failure.kind, now);
			await this.database.batch([
				outcome,
				counter,
				terminal,
				retire,
				release,
				finish
			]);
			const stored = await this.outcome(task.id);
			if (stored?.completionId === id) {
				return { kind: 'recorded', outcome: this.decoded(stored) };
			}
			return this.replay(stored, task, failure) ?? { kind: 'unavailable' };
		});
	}
}
