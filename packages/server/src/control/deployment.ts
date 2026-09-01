import { cacheLocalContractMigration } from '@cupboard/protocol/cache-deployment-manifest';
import { canonicalJson } from '@cupboard/protocol/canonical-json';
import {
	type CloudflareDeploymentObservation,
	type DeploymentAdvanceInput,
	type DeploymentAdvanceResult,
	deploymentArtifactIdSchema,
	deploymentAttemptIdSchema,
	type DeploymentExternalAction,
	type DeploymentFailure,
	deploymentFailureSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema,
	deploymentRevisionSchema,
	deploymentStateIdSchema,
	type DeploymentStatus,
	deploymentTransitionIdSchema
} from '@cupboard/protocol/deployment';
import {
	type DeploymentCheckId,
	type ForwardDeploymentTransition,
	type StructuralMigration
} from '@cupboard/protocol/deployment-manifest';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	deploymentForwardTransitions,
	deploymentManifest
} from '../deployment-manifest.generated.ts';
import {
	deploymentRuntimeEvidence,
	deploymentRuntimeEvidenceSchema,
	deploymentRuntimePath
} from '../deployment-runtime.ts';
import { DeploymentStateConflictError } from '../errors.ts';
import { advanceFleetDataMigration } from '../migration/deployment-data.ts';
import { advanceWriterDrain } from '../migration/writer-drain.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const transitionClaimDurationMs = 5 * 60 * 1000;

export interface DeploymentOperationContext {
	readonly database: Database;
	readonly deployment: DeploymentIdentity;
	readonly attemptId: ReturnType<typeof deploymentAttemptIdSchema.parse>;
	readonly transition: ForwardDeploymentTransition;
	readonly now: Date;
	readonly externalObservation?: CloudflareDeploymentObservation;
}

export type DeploymentOperationResult =
	| { readonly outcome: 'complete' }
	| { readonly outcome: 'running' }
	| { readonly outcome: 'failed'; readonly failure: DeploymentFailure };

export interface DeploymentRegistry {
	readonly transitions: readonly ForwardDeploymentTransition[];
	readonly d1Migrations: readonly StructuralMigration[];
	readonly operations: Readonly<
		Partial<
			Record<
				ForwardDeploymentTransition['kind'],
				(
					context: DeploymentOperationContext
				) => Promise<DeploymentOperationResult>
			>
		>
	>;
	readonly checks: Readonly<
		Partial<
			Record<
				DeploymentCheckId,
				(context: DeploymentOperationContext) => Promise<boolean>
			>
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

const deploymentClock: DeploymentClock = {
	now: () => new Date(),
	randomUuid: () => crypto.randomUUID()
};

const defaultDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: deploymentForwardTransitions,
		d1Migrations: deploymentManifest.d1Migrations,
		operations: {},
		checks: {}
	},
	clock: deploymentClock
};

export function deploymentServiceDependencies(
	env: Env
): DeploymentServiceDependencies {
	return {
		registry: {
			transitions: deploymentForwardTransitions,
			d1Migrations: deploymentManifest.d1Migrations,
			operations: {
				'apply-d1': verifyAppliedD1Migrations,
				'deploy-runtime-stage': (context) => verifyRuntimeStage(env, context),
				'run-data-migration': async (context) => {
					const { transition } = context;

					if (transition.kind !== 'run-data-migration') {
						throw new DeploymentStateConflictError();
					}

					const descriptor = deploymentManifest.dataMigrations.find(
						(candidate) => candidate.id === transition.migration
					);

					if (descriptor === undefined) {
						throw new DeploymentStateConflictError();
					}

					return advanceFleetDataMigration(
						env,
						context.database,
						context.deployment,
						descriptor,
						context.attemptId,
						context.now
					);
				},
				'drain-writer-epoch': (context) => {
					const { transition } = context;

					if (transition.kind !== 'drain-writer-epoch') {
						throw new DeploymentStateConflictError();
					}

					return advanceWriterDrain(
						env,
						context.database,
						context.deployment,
						transition.before,
						context.now
					);
				},
				'set-deployment-fence': setDeploymentFence,
				'set-tenant-local-contract-admission': setTenantLocalContractAdmission,
				'resolve-repair-intents': resolveRepairIntents,
				'close-r2-compatibility-window': closeR2CompatibilityWindow,
				'record-recovery-point': (context) => recordRecoveryPoint(env, context)
			},
			checks: {}
		},
		clock: deploymentClock
	};
}

async function verifyRuntimeStage(
	env: Env,
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	const { transition, externalObservation } = context;

	if (
		transition.kind !== 'deploy-runtime-stage' ||
		externalObservation?.kind !== 'runtime-stage'
	) {
		throw new DeploymentStateConflictError();
	}

	const control = await deploymentRuntimeEvidence(env);
	const tenantResponse = await env.CUPBOARD_TENANT.fetch(
		new Request(`https://cupboard-tenant.invalid${deploymentRuntimePath}`)
	);

	if (!tenantResponse.ok) {
		return {
			outcome: 'failed',
			failure: { code: 'tenant-runtime-evidence-unavailable' }
		};
	}

	const tenantValue: unknown = await tenantResponse.json();
	const tenant = deploymentRuntimeEvidenceSchema.safeParse(tenantValue);
	const head = await context.database
		.select({ manifestId: d1Schema.deploymentHead.manifestId })
		.from(d1Schema.deploymentHead)
		.where(eq(d1Schema.deploymentHead.id, 'current'))
		.get();

	if (
		!tenant.success ||
		head?.manifestId !== control.manifestId ||
		tenant.data.manifestId !== control.manifestId ||
		control.stage !== transition.stage ||
		tenant.data.stage !== transition.stage ||
		control.versionId !== externalObservation.controlVersionId ||
		tenant.data.versionId !== externalObservation.tenantVersionId
	) {
		return {
			outcome: 'failed',
			failure: { code: 'runtime-stage-evidence-mismatch' }
		};
	}

	return { outcome: 'complete' };
}

async function verifyAppliedD1Migrations(
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	const { transition } = context;

	if (transition.kind !== 'apply-d1') {
		throw new DeploymentStateConflictError();
	}

	const expected = expectedD1Observation(
		transition,
		defaultDependencies.registry
	);
	const rows = await context.database
		.select({
			id: d1Schema.structuralMigrationChecksum.migrationId,
			sha256: d1Schema.structuralMigrationChecksum.sha256
		})
		.from(d1Schema.structuralMigrationChecksum)
		.where(
			and(
				eq(d1Schema.structuralMigrationChecksum.kind, 'd1'),
				inArray(
					d1Schema.structuralMigrationChecksum.migrationId,
					transition.migrations
				)
			)
		)
		.all();
	const stored = new Map(rows.map((row) => [row.id, row.sha256]));

	return expected.every(
		(migration) => stored.get(migration.id) === migration.sha256
	)
		? { outcome: 'complete' }
		: {
				outcome: 'failed',
				failure: { code: 'd1-migration-evidence-missing' }
			};
}

async function setDeploymentFence(
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	const { transition } = context;

	if (transition.kind !== 'set-deployment-fence') {
		throw new DeploymentStateConflictError();
	}

	const updatedAt = isoTimestampSchema.parse(context.now.toISOString());

	if (transition.fence === 'd1-application-writes') {
		const result = await context.database
			.update(d1Schema.d1AppMutationFence)
			.set({
				state: transition.value,
				revision: sql`${d1Schema.d1AppMutationFence.revision} + 1`,
				updatedAt
			})
			.where(eq(d1Schema.d1AppMutationFence.id, 'application'))
			.run();

		if (result.meta.changes !== 1) {
			throw new DeploymentStateConflictError();
		}

		return { outcome: 'complete' };
	}

	const result = await context.database
		.update(d1Schema.deploymentRuntimeControl)
		.set({
			retentionAdministration: transition.value,
			retentionRevision: sql`${d1Schema.deploymentRuntimeControl.retentionRevision} + 1`,
			updatedAt
		})
		.where(eq(d1Schema.deploymentRuntimeControl.id, 'current'))
		.run();

	if (result.meta.changes !== 1) {
		throw new DeploymentStateConflictError();
	}

	return { outcome: 'complete' };
}

async function setTenantLocalContractAdmission(
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	const { transition } = context;

	if (transition.kind !== 'set-tenant-local-contract-admission') {
		throw new DeploymentStateConflictError();
	}

	const result = await context.database
		.update(d1Schema.deploymentRuntimeControl)
		.set({
			tenantLocalContractAdmission: transition.value,
			updatedAt: isoTimestampSchema.parse(context.now.toISOString())
		})
		.where(eq(d1Schema.deploymentRuntimeControl.id, 'current'))
		.run();

	if (result.meta.changes !== 1) {
		throw new DeploymentStateConflictError();
	}

	return { outcome: 'complete' };
}

async function closeR2CompatibilityWindow(
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	if (context.transition.kind !== 'close-r2-compatibility-window') {
		throw new DeploymentStateConflictError();
	}

	const result = await context.database
		.update(d1Schema.deploymentRuntimeControl)
		.set({
			legacyR2Writes: 'disabled',
			legacyR2ReadFallback: 'disabled',
			legacyR2Deletion: 'eligible',
			updatedAt: isoTimestampSchema.parse(context.now.toISOString())
		})
		.where(eq(d1Schema.deploymentRuntimeControl.id, 'current'))
		.run();

	if (result.meta.changes !== 1) {
		throw new DeploymentStateConflictError();
	}

	return { outcome: 'complete' };
}

async function resolveRepairIntents(
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	if (context.transition.kind !== 'resolve-repair-intents') {
		throw new DeploymentStateConflictError();
	}

	const unresolved = await context.database
		.select({
			id: d1Schema.projectionRepairIntent.id,
			status: d1Schema.projectionRepairIntent.status
		})
		.from(d1Schema.projectionRepairIntent)
		.where(
			notInArray(d1Schema.projectionRepairIntent.status, [
				'complete',
				'rolled-back'
			])
		)
		.limit(1)
		.get();

	if (unresolved === undefined) {
		return { outcome: 'complete' };
	}

	return {
		outcome: 'failed',
		failure: {
			code: 'projection-repair-unresolved',
			detail: `Repair intent ${unresolved.id} is ${unresolved.status}`
		}
	};
}

function d1RecoveryEnvelopeKey(context: DeploymentOperationContext): string {
	const { deployment, attemptId, transition } = context;

	return [
		'deployment-recovery',
		deployment.instanceId,
		deployment.artifactId,
		transition.id,
		`${attemptId}.json`
	].join('/');
}

async function writeD1RecoveryEnvelope(
	env: Env,
	context: DeploymentOperationContext,
	databaseId: string,
	bookmark: string
): Promise<{ readonly key: string; readonly sha256: string } | undefined> {
	const key = d1RecoveryEnvelopeKey(context);
	const body = canonicalJson({
		artifactId: context.deployment.artifactId,
		instanceId: context.deployment.instanceId,
		transitionId: context.transition.id,
		attemptId: context.attemptId,
		databaseId,
		bookmark,
		capturedAt: context.now.toISOString()
	});
	const sha256 = await sha256Hex(body);

	await env.DEPLOYMENT_RECOVERY.put(key, body, { sha256 });

	const stored = await env.DEPLOYMENT_RECOVERY.get(key);

	if (stored === null || (await stored.text()) !== body) {
		return undefined;
	}

	return { key, sha256 };
}

async function recordRecoveryPoint(
	env: Env,
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	const { transition } = context;

	if (transition.kind !== 'record-recovery-point') {
		throw new DeploymentStateConflictError();
	}

	if (transition.storage === 'd1') {
		const observation = context.externalObservation;

		if (observation?.kind !== 'd1-recovery-point') {
			return {
				outcome: 'failed',
				failure: { code: 'd1-recovery-envelope-required' }
			};
		}

		const envelope = await writeD1RecoveryEnvelope(
			env,
			context,
			observation.databaseId,
			observation.bookmark
		);

		if (envelope === undefined) {
			return {
				outcome: 'failed',
				failure: { code: 'd1-recovery-envelope-verification-failed' }
			};
		}

		await context.database
			.insert(d1Schema.deploymentD1RecoveryPoint)
			.values({
				artifactId: context.deployment.artifactId,
				instanceId: context.deployment.instanceId,
				transitionId: transition.id,
				attemptId: context.attemptId,
				databaseId: observation.databaseId,
				bookmark: observation.bookmark,
				envelopeKey: envelope.key,
				envelopeSha256: envelope.sha256,
				capturedAt: isoTimestampSchema.parse(context.now.toISOString())
			})
			.onConflictDoUpdate({
				target: [
					d1Schema.deploymentD1RecoveryPoint.artifactId,
					d1Schema.deploymentD1RecoveryPoint.instanceId,
					d1Schema.deploymentD1RecoveryPoint.transitionId
				],
				set: {
					attemptId: context.attemptId,
					databaseId: observation.databaseId,
					bookmark: observation.bookmark,
					envelopeKey: envelope.key,
					envelopeSha256: envelope.sha256,
					capturedAt: isoTimestampSchema.parse(context.now.toISOString())
				}
			});

		return { outcome: 'complete' };
	}

	const migration = await context.database
		.select({ status: d1Schema.globalDataMigration.status })
		.from(d1Schema.globalDataMigration)
		.where(
			and(
				eq(
					d1Schema.globalDataMigration.artifactId,
					context.deployment.artifactId
				),
				eq(
					d1Schema.globalDataMigration.instanceId,
					context.deployment.instanceId
				),
				eq(
					d1Schema.globalDataMigration.migrationId,
					cacheLocalContractMigration
				)
			)
		)
		.get();

	return migration?.status === 'complete'
		? { outcome: 'complete' }
		: { outcome: 'running' };
}

function requiresExternalAction(
	transition: ForwardDeploymentTransition
): transition is Extract<
	ForwardDeploymentTransition,
	{
		readonly kind:
			'apply-d1' | 'deploy-runtime-stage' | 'record-recovery-point';
	}
> {
	return (
		transition.kind === 'apply-d1' ||
		transition.kind === 'deploy-runtime-stage' ||
		(transition.kind === 'record-recovery-point' && transition.storage === 'd1')
	);
}

function externalActionFor(
	transition: Extract<
		ForwardDeploymentTransition,
		{
			readonly kind:
				'apply-d1' | 'deploy-runtime-stage' | 'record-recovery-point';
		}
	>
): DeploymentExternalAction {
	if (transition.kind === 'deploy-runtime-stage') {
		return {
			kind: 'deploy-runtime-stage',
			stage: transition.stage,
			tenantFirst: true
		};
	}

	if (transition.kind === 'record-recovery-point') {
		return { kind: 'capture-d1-recovery-point' };
	}

	return {
		kind: 'apply-d1',
		migrations: [...transition.migrations]
	};
}

function expectedD1Observation(
	transition: Extract<
		ForwardDeploymentTransition,
		{ readonly kind: 'apply-d1' }
	>,
	registry: DeploymentRegistry
) {
	const checksumById = new Map(
		registry.d1Migrations.map((migration) => [migration.id, migration.sha256])
	);

	return transition.migrations.map((id) => {
		const sha256 = checksumById.get(id);

		if (sha256 === undefined) {
			throw new DeploymentStateConflictError();
		}

		return { id, sha256 };
	});
}

function isExternalObservationValid(
	transition: Extract<
		ForwardDeploymentTransition,
		{
			readonly kind:
				'apply-d1' | 'deploy-runtime-stage' | 'record-recovery-point';
		}
	>,
	input: DeploymentAdvanceInput,
	registry: DeploymentRegistry
): boolean {
	const observation = input.externalObservation;

	if (transition.kind === 'deploy-runtime-stage') {
		return (
			observation?.kind === 'runtime-stage' &&
			observation.stage === transition.stage
		);
	}

	if (transition.kind === 'record-recovery-point') {
		return observation?.kind === 'd1-recovery-point';
	}

	if (observation?.kind !== 'd1-migrations') {
		return false;
	}

	return (
		JSON.stringify(observation.migrations) ===
		JSON.stringify(expectedD1Observation(transition, registry))
	);
}

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
			externalAction: requiresExternalAction(transition)
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

	if (requiresExternalAction(transition)) {
		if (input.externalObservation === undefined) {
			return {
				outcome: 'external-action-required',
				attemptId,
				action: externalActionFor(transition)
			};
		}

		if (!isExternalObservationValid(transition, input, dependencies.registry)) {
			throw new DeploymentStateConflictError();
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

	const operationContext: DeploymentOperationContext = {
		database,
		deployment: input.deployment,
		attemptId,
		transition,
		now,
		...(input.externalObservation !== undefined && {
			externalObservation: input.externalObservation
		})
	};

	for (const checkId of transition.checks) {
		const check = dependencies.registry.checks[checkId];

		if (check === undefined || !(await check(operationContext))) {
			throw new DeploymentStateConflictError();
		}
	}

	const operation = dependencies.registry.operations[transition.kind];
	let operationResult: DeploymentOperationResult = { outcome: 'complete' };

	if (transition.kind !== 'verify') {
		if (operation === undefined && !requiresExternalAction(transition)) {
			throw new DeploymentStateConflictError();
		}

		if (operation !== undefined) {
			operationResult = await operation(operationContext);
		}
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
