import {
	type DeploymentAdvanceInput,
	type DeploymentAdvanceResult,
	deploymentArtifactIdSchema,
	deploymentAttemptIdSchema,
	type DeploymentFailure,
	deploymentFailureSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema,
	deploymentRevisionSchema,
	deploymentStateIdSchema,
	type DeploymentStatus,
	deploymentTransitionIdSchema
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import {
	deploymentForwardTransitions,
	type RegisteredDeploymentTransition
} from '../deployment-manifest.generated.ts';
import { DeploymentStateConflictError } from '../errors.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const transitionClaimDurationMs = 5 * 60 * 1000;

export interface DeploymentOperationContext {
	readonly database: Database;
	readonly deployment: DeploymentIdentity;
	readonly attemptId: ReturnType<typeof deploymentAttemptIdSchema.parse>;
	readonly transition: RegisteredDeploymentTransition;
}

export type DeploymentOperationResult =
	| { readonly outcome: 'complete' }
	| { readonly outcome: 'running' }
	| { readonly outcome: 'failed'; readonly failure: DeploymentFailure };

export interface DeploymentRegistry {
	readonly transitions: readonly RegisteredDeploymentTransition[];
	readonly operations: Readonly<
		Record<
			string,
			(
				context: DeploymentOperationContext
			) => Promise<DeploymentOperationResult>
		>
	>;
}

export interface DeploymentClock {
	now(): Date;
	randomUuid(): string;
}

export interface DeploymentServiceDependencies {
	readonly registry: DeploymentRegistry;
	readonly clock: DeploymentClock;
}

const defaultDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: deploymentForwardTransitions,
		operations: {}
	},
	clock: {
		now: () => new Date(),
		randomUuid: () => crypto.randomUUID()
	}
};

function isIdentityMatch(
	row: { readonly artifactId: string; readonly instanceId: string },
	identity: DeploymentIdentity
): boolean {
	return (
		row.artifactId === identity.artifactId &&
		row.instanceId === identity.instanceId
	);
}

function parseFailure(value: string | null | undefined) {
	const stored = value ?? undefined;

	if (stored === undefined) {
		return;
	}

	try {
		const parsed: unknown = JSON.parse(stored);
		const result = deploymentFailureSchema.safeParse(parsed);

		return result.success ? result.data : { code: 'invalid-stored-failure' };
	} catch {
		return { code: 'invalid-stored-failure' };
	}
}

export async function deploymentStatus(
	database: Database,
	identity: DeploymentIdentity,
	dependencies: DeploymentServiceDependencies = defaultDependencies
): Promise<DeploymentStatus> {
	const head = await database.select().from(d1Schema.deploymentHead).get();

	if (head === undefined) {
		return { state: 'uninitialised' };
	}

	if (!isIdentityMatch(head, identity)) {
		throw new DeploymentStateConflictError();
	}

	const execution = await database
		.select()
		.from(d1Schema.deploymentTransitionExecution)
		.where(
			and(
				eq(
					d1Schema.deploymentTransitionExecution.artifactId,
					identity.artifactId
				),
				eq(
					d1Schema.deploymentTransitionExecution.instanceId,
					identity.instanceId
				)
			)
		)
		.orderBy(desc(d1Schema.deploymentTransitionExecution.updatedAt))
		.limit(1)
		.get();
	const state = deploymentStateIdSchema.parse(head.stateId);
	const next = dependencies.registry.transitions.find(
		(transition) => transition.from === state
	);
	const attemptId = execution?.attemptId ?? undefined;
	const claimExpiresAt = execution?.claimExpiresAt ?? undefined;
	const failure = parseFailure(execution?.lastFailureJson);
	const parsedExecution =
		execution === undefined
			? undefined
			: {
					transitionId: deploymentTransitionIdSchema.parse(
						execution.transitionId
					),
					fromState: deploymentStateIdSchema.parse(execution.fromStateId),
					toState: deploymentStateIdSchema.parse(execution.toStateId),
					status: execution.status,
					...(attemptId !== undefined && {
						attemptId: deploymentAttemptIdSchema.parse(attemptId)
					}),
					...(claimExpiresAt !== undefined && { claimExpiresAt }),
					externalAction: execution.externalAction,
					...(failure !== undefined && { failure })
				};

	return {
		state: 'current',
		deployment: {
			artifactId: deploymentArtifactIdSchema.parse(head.artifactId),
			instanceId: deploymentInstanceIdSchema.parse(head.instanceId)
		},
		deploymentState: state,
		revision: deploymentRevisionSchema.parse(head.revision),
		status: head.status,
		...(parsedExecution !== undefined && { execution: parsedExecution }),
		...(next !== undefined && { nextState: next.to })
	};
}

export async function deploymentAdvance(
	database: Database,
	input: DeploymentAdvanceInput,
	dependencies: DeploymentServiceDependencies = defaultDependencies
): Promise<DeploymentAdvanceResult> {
	const head = await database.select().from(d1Schema.deploymentHead).get();
	const transition = dependencies.registry.transitions.find(
		(candidate) => candidate.from === input.expectedState
	);

	if (
		head === undefined ||
		!isIdentityMatch(head, input.deployment) ||
		head.status !== 'active' ||
		transition?.to !== input.targetState
	) {
		throw new DeploymentStateConflictError();
	}

	if (
		head.stateId === transition.to &&
		head.revision === input.expectedRevision + 1
	) {
		return {
			outcome: 'completed',
			state: deploymentStateIdSchema.parse(head.stateId),
			revision: deploymentRevisionSchema.parse(head.revision)
		};
	}

	if (
		head.stateId !== input.expectedState ||
		head.revision !== input.expectedRevision
	) {
		throw new DeploymentStateConflictError();
	}

	const now = dependencies.clock.now();
	const nowIso = isoTimestampSchema.parse(now.toISOString());
	const requestedAttempt = input.attemptId;
	const execution = await database
		.select()
		.from(d1Schema.deploymentTransitionExecution)
		.where(
			and(
				eq(
					d1Schema.deploymentTransitionExecution.artifactId,
					input.deployment.artifactId
				),
				eq(
					d1Schema.deploymentTransitionExecution.instanceId,
					input.deployment.instanceId
				),
				eq(d1Schema.deploymentTransitionExecution.transitionId, transition.id)
			)
		)
		.get();

	if (execution?.status === 'failed') {
		const failure = parseFailure(execution.lastFailureJson) ?? {
			code: 'deployment-transition-failed'
		};

		return {
			outcome: 'failed',
			attemptId: deploymentAttemptIdSchema.parse(execution.attemptId),
			failure
		};
	}

	const existingAttempt = execution?.attemptId ?? undefined;
	const isClaimExpired =
		execution?.claimExpiresAt !== null &&
		execution?.claimExpiresAt !== undefined &&
		execution.claimExpiresAt <= nowIso;

	if (
		existingAttempt !== undefined &&
		requestedAttempt !== existingAttempt &&
		!isClaimExpired
	) {
		throw new DeploymentStateConflictError();
	}

	const attemptId = deploymentAttemptIdSchema.parse(
		requestedAttempt ??
			(isClaimExpired ? dependencies.clock.randomUuid() : existingAttempt) ??
			dependencies.clock.randomUuid()
	);
	const claimExpiresAt = isoTimestampSchema.parse(
		new Date(now.getTime() + transitionClaimDurationMs).toISOString()
	);

	await database
		.insert(d1Schema.deploymentTransitionExecution)
		.values({
			artifactId: input.deployment.artifactId,
			instanceId: input.deployment.instanceId,
			transitionId: transition.id,
			fromStateId: transition.from,
			toStateId: transition.to,
			status: 'running',
			attemptId,
			claimRevision: (execution?.claimRevision ?? -1) + 1,
			claimExpiresAt,
			externalAction:
				transition.operation.kind === 'deploy-runtime-stage'
					? 'issued'
					: 'not-required',
			startedAt: execution?.startedAt ?? nowIso,
			updatedAt: nowIso
		})
		.onConflictDoUpdate({
			target: [
				d1Schema.deploymentTransitionExecution.artifactId,
				d1Schema.deploymentTransitionExecution.instanceId,
				d1Schema.deploymentTransitionExecution.transitionId
			],
			set: {
				status: 'running',
				attemptId,
				claimRevision: (execution?.claimRevision ?? -1) + 1,
				claimExpiresAt,
				updatedAt: nowIso
			}
		});

	if (transition.operation.kind === 'deploy-runtime-stage') {
		if (input.externalObservation === undefined) {
			return {
				outcome: 'external-action-required',
				attemptId,
				action: {
					kind: 'deploy-runtime-stage',
					stage: transition.operation.stage,
					tenantFirst: true
				}
			};
		}

		await database
			.update(d1Schema.deploymentTransitionExecution)
			.set({ externalAction: 'observed', updatedAt: nowIso })
			.where(
				and(
					eq(
						d1Schema.deploymentTransitionExecution.artifactId,
						input.deployment.artifactId
					),
					eq(
						d1Schema.deploymentTransitionExecution.instanceId,
						input.deployment.instanceId
					),
					eq(
						d1Schema.deploymentTransitionExecution.transitionId,
						transition.id
					),
					eq(d1Schema.deploymentTransitionExecution.attemptId, attemptId)
				)
			);
	}

	let operationResult: DeploymentOperationResult = { outcome: 'complete' };

	if (transition.operation.kind === 'registered-operation') {
		const operation =
			dependencies.registry.operations[transition.operation.operationId];

		if (operation === undefined) {
			throw new DeploymentStateConflictError();
		}

		operationResult = await operation({
			database,
			deployment: input.deployment,
			attemptId,
			transition
		});
	}

	if (operationResult.outcome === 'running') {
		return { outcome: 'running', attemptId };
	}

	if (operationResult.outcome === 'failed') {
		await database
			.update(d1Schema.deploymentTransitionExecution)
			.set({
				status: 'failed',
				lastFailureJson: JSON.stringify(operationResult.failure),
				claimExpiresAt: sql`NULL`,
				updatedAt: nowIso
			})
			.where(
				and(
					eq(
						d1Schema.deploymentTransitionExecution.artifactId,
						input.deployment.artifactId
					),
					eq(
						d1Schema.deploymentTransitionExecution.instanceId,
						input.deployment.instanceId
					),
					eq(
						d1Schema.deploymentTransitionExecution.transitionId,
						transition.id
					),
					eq(d1Schema.deploymentTransitionExecution.attemptId, attemptId)
				)
			);

		return {
			outcome: 'failed',
			attemptId,
			failure: operationResult.failure
		};
	}

	const advanced = await database
		.update(d1Schema.deploymentHead)
		.set({
			stateId: transition.to,
			revision: head.revision + 1,
			updatedAt: nowIso
		})
		.where(
			and(
				eq(d1Schema.deploymentHead.id, 'current'),
				eq(d1Schema.deploymentHead.artifactId, input.deployment.artifactId),
				eq(d1Schema.deploymentHead.instanceId, input.deployment.instanceId),
				eq(d1Schema.deploymentHead.stateId, input.expectedState),
				eq(d1Schema.deploymentHead.revision, input.expectedRevision)
			)
		)
		.run();

	if (advanced.meta.changes !== 1) {
		throw new DeploymentStateConflictError();
	}

	await database
		.update(d1Schema.deploymentTransitionExecution)
		.set({
			status: 'completed',
			claimExpiresAt: sql`NULL`,
			completedAt: nowIso,
			updatedAt: nowIso
		})
		.where(
			and(
				eq(
					d1Schema.deploymentTransitionExecution.artifactId,
					input.deployment.artifactId
				),
				eq(
					d1Schema.deploymentTransitionExecution.instanceId,
					input.deployment.instanceId
				),
				eq(d1Schema.deploymentTransitionExecution.transitionId, transition.id),
				eq(d1Schema.deploymentTransitionExecution.attemptId, attemptId)
			)
		);

	return {
		outcome: 'completed',
		state: transition.to,
		revision: deploymentRevisionSchema.parse(head.revision + 1)
	};
}
