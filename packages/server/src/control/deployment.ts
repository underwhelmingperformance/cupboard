import {
	cacheDeploymentChecks,
	cacheLocalContractMigration,
	cacheStorageContractStage
} from '@cupboard/protocol/cache-deployment-manifest';
import { canonicalJson } from '@cupboard/protocol/canonical-json';
import {
	type CloudflareDeploymentObservation,
	type DeploymentAdoptionResult,
	type DeploymentAdoptPredecessorInput,
	type DeploymentAdvanceInput,
	type DeploymentAdvanceResult,
	deploymentArtifactIdSchema,
	deploymentAttemptIdSchema,
	deploymentExecutionTransitionIdSchema,
	type DeploymentExternalAction,
	type DeploymentFailure,
	deploymentFailureSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema,
	deploymentManifestIdSchema,
	type DeploymentPrepareSuccessorInput,
	type DeploymentRecoverInput,
	type DeploymentRecoveryResult,
	deploymentRevisionSchema,
	deploymentStateIdSchema,
	type DeploymentStatus,
	deploymentTransitionIdSchema,
	predecessorExecutionSnapshotSchema,
	type SuccessorPreparationResult
} from '@cupboard/protocol/deployment';
import {
	type DataMigrationDescriptor,
	type DeploymentCheckId,
	type DeploymentState,
	type ForwardDeploymentTransition,
	type RecoveryDeploymentTransition,
	type RegisteredForwardRepairId,
	type StructuralMigration
} from '@cupboard/protocol/deployment-manifest';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import {
	and,
	desc,
	eq,
	gt,
	inArray,
	lt,
	lte,
	ne,
	notInArray,
	sql
} from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { z } from 'zod';

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
import { tenantServer } from '../routing/durable-object.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const transitionClaimDurationMs = 5 * 60 * 1000;

const d1RecoveryEnvelopePayloadSchema = z.strictObject({
	databaseId: z.string().min(1),
	deployment: z.strictObject({
		artifactId: deploymentArtifactIdSchema,
		instanceId: deploymentInstanceIdSchema
	}),
	transitionId: z.string().min(1),
	attemptId: deploymentAttemptIdSchema,
	expectedDeploymentRevision: deploymentRevisionSchema,
	closedApplicationFenceRevision: z.int().nonnegative(),
	preContractSchemaFingerprint: z.string().min(1),
	phase: z.enum([
		'recorded',
		'restore-requested',
		'restored-awaiting-verification',
		'complete'
	]),
	preContractBookmark: z.string().min(1),
	restoreUndoBookmark: z.string().min(1).optional(),
	updatedAt: z.iso.datetime()
});
const d1RecoveryEnvelopeSchema = d1RecoveryEnvelopePayloadSchema.extend({
	checksum: z.string().regex(/^[\da-f]{64}$/)
});

export interface DeploymentOperationContext {
	readonly database: Database;
	readonly deployment: DeploymentIdentity;
	readonly attemptId: ReturnType<typeof deploymentAttemptIdSchema.parse>;
	readonly transition: ForwardDeploymentTransition;
	readonly now: Date;
	readonly externalObservation?: CloudflareDeploymentObservation;
}

type ExecutableRecoveryTransition = Exclude<
	RecoveryDeploymentTransition,
	{ readonly kind: 'adopt-predecessor-deployment' }
>;

export interface DeploymentRecoveryOperationContext {
	readonly database: Database;
	readonly deployment: DeploymentIdentity;
	readonly attemptId: ReturnType<typeof deploymentAttemptIdSchema.parse>;
	readonly transition: ExecutableRecoveryTransition;
	readonly now: Date;
	readonly externalObservation?: CloudflareDeploymentObservation;
}

type DeploymentCheckContext =
	DeploymentOperationContext | DeploymentRecoveryOperationContext;

export type DeploymentOperationResult =
	| { readonly outcome: 'complete' }
	| { readonly outcome: 'running' }
	| { readonly outcome: 'failed'; readonly failure: DeploymentFailure };

export interface DeploymentRegistry {
	readonly transitions: readonly ForwardDeploymentTransition[];
	readonly recoveryTransitions: readonly RecoveryDeploymentTransition[];
	readonly states: readonly DeploymentState[];
	readonly dataMigrations: readonly DataMigrationDescriptor[];
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
	readonly forwardRepairs?: Readonly<
		Partial<
			Record<
				RegisteredForwardRepairId,
				(
					context: DeploymentRecoveryOperationContext
				) => Promise<DeploymentOperationResult>
			>
		>
	>;
	readonly recoveryOperations?: Readonly<
		Partial<
			Record<
				ExecutableRecoveryTransition['kind'],
				(
					context: DeploymentRecoveryOperationContext
				) => Promise<DeploymentOperationResult>
			>
		>
	>;
	readonly checks: Readonly<
		Partial<
			Record<
				DeploymentCheckId,
				(context: DeploymentCheckContext) => Promise<boolean>
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
	readonly observeSuccessorRuntime?: (
		input: DeploymentAdoptPredecessorInput,
		transition: Extract<
			RecoveryDeploymentTransition,
			{ readonly kind: 'adopt-predecessor-deployment' }
		>,
		registry: DeploymentRegistry
	) => Promise<{
		readonly manifestId: ReturnType<typeof deploymentManifestIdSchema.parse>;
	}>;
	readonly prepareD1Restore?: (
		action: Extract<DeploymentExternalAction, { readonly kind: 'restore-d1' }>,
		now: Date
	) => Promise<void>;
	readonly recordD1Restoration?: (
		context: DeploymentRecoveryOperationContext
	) => Promise<void>;
}

const deploymentClock: DeploymentClock = {
	now: () => new Date(),
	randomUuid: () => crypto.randomUUID()
};

const defaultDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: deploymentForwardTransitions,
		recoveryTransitions: deploymentManifest.recoveryTransitions,
		states: deploymentManifest.states,
		dataMigrations: deploymentManifest.dataMigrations,
		d1Migrations: deploymentManifest.d1Migrations,
		operations: {},
		forwardRepairs: {},
		recoveryOperations: {},
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
			recoveryTransitions: deploymentManifest.recoveryTransitions,
			states: deploymentManifest.states,
			dataMigrations: deploymentManifest.dataMigrations,
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
				'resolve-repair-intents': (context) =>
					resolveRepairIntents(env, context),
				'close-r2-compatibility-window': closeR2CompatibilityWindow,
				'record-recovery-point': (context) => recordRecoveryPoint(env, context)
			},
			forwardRepairs: {},
			recoveryOperations: {
				'deploy-recovery-stage': (context) =>
					verifyRecoveryRuntimeStage(env, context),
				'restore-d1': (context) => verifyD1Restoration(env, context),
				'restore-durable-objects': (context) =>
					advanceDurableObjectRestoration(env, context)
			},
			checks: {
				[cacheDeploymentChecks.compatibleD1]: hasAppliedManifestD1Schema,
				[cacheDeploymentChecks.contractedD1]: hasAppliedManifestD1Schema,
				[cacheDeploymentChecks.terminal]: (context) =>
					isTerminalDeploymentValid(env, context)
			}
		},
		clock: deploymentClock,
		prepareD1Restore: (action, now) => markD1RestoreRequested(env, action, now),
		recordD1Restoration: (context) => recordD1Restoration(env, context),
		observeSuccessorRuntime: (input, transition, registry) =>
			verifySuccessorRuntime(env, input, transition, registry)
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
		control.artifactId !== context.deployment.artifactId ||
		tenant.data.artifactId !== context.deployment.artifactId ||
		control.stage !== transition.stage ||
		tenant.data.stage !== transition.stage ||
		control.versionId !== externalObservation.controlVersionId ||
		tenant.data.versionId !== externalObservation.tenantVersionId
	) {
		return {
			outcome: 'failed',
			failure: {
				code: 'runtime-stage-evidence-mismatch',
				detail: JSON.stringify({
					expected: {
						artifactId: context.deployment.artifactId,
						stage: transition.stage,
						controlVersionId: externalObservation.controlVersionId,
						tenantVersionId: externalObservation.tenantVersionId
					},
					control,
					tenant: tenant.success ? tenant.data : tenant.error.issues
				})
			}
		};
	}

	return { outcome: 'complete' };
}

async function verifyRecoveryRuntimeStage(
	env: Env,
	context: DeploymentRecoveryOperationContext
): Promise<DeploymentOperationResult> {
	const { transition, externalObservation } = context;

	if (
		transition.kind !== 'deploy-recovery-stage' ||
		externalObservation?.kind !== 'runtime-stage' ||
		externalObservation.stage !== transition.stage
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

	if (
		!tenant.success ||
		control.stage !== transition.stage ||
		tenant.data.stage !== transition.stage ||
		control.manifestId !== tenant.data.manifestId ||
		control.artifactId !== context.deployment.artifactId ||
		tenant.data.artifactId !== context.deployment.artifactId ||
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

async function verifyD1Restoration(
	env: Env,
	context: DeploymentRecoveryOperationContext
): Promise<DeploymentOperationResult> {
	const { transition, externalObservation } = context;

	if (
		transition.kind !== 'restore-d1' ||
		externalObservation?.kind !== 'd1-restoration'
	) {
		throw new DeploymentStateConflictError();
	}

	const stored = await env.DEPLOYMENT_RECOVERY.get(
		externalObservation.recoveryEnvelopeKey
	);

	if (stored === null) {
		return {
			outcome: 'failed',
			failure: { code: 'd1-recovery-envelope-missing' }
		};
	}

	const value: unknown = JSON.parse(await stored.text());
	const parsed = d1RecoveryEnvelopeSchema.safeParse(value);

	if (
		!parsed.success ||
		parsed.data.deployment.artifactId !== context.deployment.artifactId ||
		parsed.data.deployment.instanceId !== context.deployment.instanceId ||
		parsed.data.databaseId !== externalObservation.databaseId ||
		parsed.data.preContractBookmark !==
			externalObservation.preContractBookmark ||
		parsed.data.restoreUndoBookmark !== externalObservation.undoBookmark ||
		(parsed.data.phase !== 'restored-awaiting-verification' &&
			parsed.data.phase !== 'complete')
	) {
		return {
			outcome: 'failed',
			failure: { code: 'd1-recovery-envelope-mismatch' }
		};
	}
	const { checksum: storedChecksum, ...storedPayload } = parsed.data;
	const expectedChecksum = await sha256Hex(canonicalJson(storedPayload));

	if (storedChecksum !== expectedChecksum) {
		return {
			outcome: 'failed',
			failure: { code: 'd1-recovery-envelope-checksum-mismatch' }
		};
	}

	if (parsed.data.phase === 'complete') {
		return { outcome: 'complete' };
	}

	const payload = d1RecoveryEnvelopePayloadSchema.parse({
		...storedPayload,
		phase: 'complete',
		restoreUndoBookmark: externalObservation.undoBookmark,
		updatedAt: context.now.toISOString()
	});
	const checksum = await sha256Hex(canonicalJson(payload));
	const body = canonicalJson({ ...payload, checksum });
	const sha256 = await sha256Hex(body);

	await env.DEPLOYMENT_RECOVERY.put(
		externalObservation.recoveryEnvelopeKey,
		body,
		{ sha256 }
	);
	const verified = await env.DEPLOYMENT_RECOVERY.get(
		externalObservation.recoveryEnvelopeKey
	);

	return verified !== null && (await verified.text()) === body
		? { outcome: 'complete' }
		: {
				outcome: 'failed',
				failure: { code: 'd1-recovery-envelope-verification-failed' }
			};
}

async function recordD1Restoration(
	env: Env,
	context: DeploymentRecoveryOperationContext
): Promise<void> {
	const { transition, externalObservation } = context;

	if (
		transition.kind !== 'restore-d1' ||
		externalObservation?.kind !== 'd1-restoration'
	) {
		throw new DeploymentStateConflictError();
	}

	const stored = await env.DEPLOYMENT_RECOVERY.get(
		externalObservation.recoveryEnvelopeKey
	);

	if (stored === null) {
		throw new DeploymentStateConflictError();
	}

	const value: unknown = JSON.parse(await stored.text());
	const parsed = d1RecoveryEnvelopeSchema.safeParse(value);

	if (
		!parsed.success ||
		parsed.data.deployment.artifactId !== context.deployment.artifactId ||
		parsed.data.deployment.instanceId !== context.deployment.instanceId ||
		parsed.data.databaseId !== externalObservation.databaseId ||
		parsed.data.preContractBookmark !== externalObservation.preContractBookmark
	) {
		throw new DeploymentStateConflictError();
	}

	const { checksum: storedChecksum, ...storedPayload } = parsed.data;
	const expectedChecksum = await sha256Hex(canonicalJson(storedPayload));

	if (storedChecksum !== expectedChecksum) {
		throw new DeploymentStateConflictError();
	}

	if (
		(parsed.data.phase === 'restored-awaiting-verification' ||
			parsed.data.phase === 'complete') &&
		parsed.data.restoreUndoBookmark === externalObservation.undoBookmark
	) {
		return;
	}

	if (parsed.data.phase !== 'restore-requested') {
		throw new DeploymentStateConflictError();
	}

	const payload = d1RecoveryEnvelopePayloadSchema.parse({
		...storedPayload,
		phase: 'restored-awaiting-verification',
		restoreUndoBookmark: externalObservation.undoBookmark,
		updatedAt: context.now.toISOString()
	});
	const checksum = await sha256Hex(canonicalJson(payload));
	const body = canonicalJson({ ...payload, checksum });
	const written = await env.DEPLOYMENT_RECOVERY.put(
		externalObservation.recoveryEnvelopeKey,
		body,
		{
			onlyIf: { etagMatches: stored.etag },
			sha256: await sha256Hex(body)
		}
	);

	if (written === null) {
		throw new DeploymentStateConflictError();
	}

	const verified = await env.DEPLOYMENT_RECOVERY.get(
		externalObservation.recoveryEnvelopeKey
	);

	if (verified === null || (await verified.text()) !== body) {
		throw new DeploymentStateConflictError();
	}
}

async function markD1RestoreRequested(
	env: Env,
	action: Extract<DeploymentExternalAction, { readonly kind: 'restore-d1' }>,
	now: Date
): Promise<void> {
	const stored = await env.DEPLOYMENT_RECOVERY.get(action.recoveryEnvelopeKey);

	if (stored === null) {
		throw new DeploymentStateConflictError();
	}

	const value: unknown = JSON.parse(await stored.text());
	const parsed = d1RecoveryEnvelopeSchema.safeParse(value);

	if (
		!parsed.success ||
		parsed.data.databaseId !== action.databaseId ||
		parsed.data.preContractBookmark !== action.preContractBookmark
	) {
		throw new DeploymentStateConflictError();
	}

	const { checksum: storedChecksum, ...storedPayload } = parsed.data;
	const expectedChecksum = await sha256Hex(canonicalJson(storedPayload));

	if (storedChecksum !== expectedChecksum) {
		throw new DeploymentStateConflictError();
	}

	if (parsed.data.phase === 'restore-requested') {
		return;
	}

	if (parsed.data.phase !== 'recorded') {
		throw new DeploymentStateConflictError();
	}

	const payload = d1RecoveryEnvelopePayloadSchema.parse({
		...storedPayload,
		phase: 'restore-requested',
		updatedAt: now.toISOString()
	});
	const checksum = await sha256Hex(canonicalJson(payload));
	const body = canonicalJson({ ...payload, checksum });
	const written = await env.DEPLOYMENT_RECOVERY.put(
		action.recoveryEnvelopeKey,
		body,
		{
			onlyIf: { etagMatches: stored.etag },
			sha256: await sha256Hex(body)
		}
	);

	if (written === null) {
		throw new DeploymentStateConflictError();
	}

	const verified = await env.DEPLOYMENT_RECOVERY.get(
		action.recoveryEnvelopeKey
	);

	if (verified === null || (await verified.text()) !== body) {
		throw new DeploymentStateConflictError();
	}
}

async function advanceDurableObjectRestoration(
	env: Env,
	context: DeploymentRecoveryOperationContext
): Promise<DeploymentOperationResult> {
	const { transition } = context;

	if (transition.kind !== 'restore-durable-objects') {
		throw new DeploymentStateConflictError();
	}

	const descriptor = deploymentManifest.dataMigrations.find(
		(candidate) => candidate.id === transition.cohort
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

function d1SchemaTransition(
	context: DeploymentCheckContext
):
	| Extract<ForwardDeploymentTransition, { readonly kind: 'apply-d1' }>
	| undefined {
	const stateId =
		context.transition.kind === 'restore-d1'
			? context.transition.to
			: context.transition.from;
	const state = deploymentManifest.states.find(
		(candidate) => candidate.id === stateId
	);

	if (state === undefined) {
		return;
	}

	for (const transition of deploymentForwardTransitions.toReversed()) {
		if (transition.kind !== 'apply-d1') {
			continue;
		}

		const target = deploymentManifest.states.find(
			(candidate) => candidate.id === transition.to
		);

		if (target?.d1Schema === state.d1Schema) {
			return transition;
		}
	}
}

async function hasAppliedManifestD1Schema(
	context: DeploymentCheckContext
): Promise<boolean> {
	const transition = d1SchemaTransition(context);

	if (transition === undefined) {
		return false;
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
	);
}

async function hasTerminalRuntime(
	env: Env,
	deployment: DeploymentIdentity
): Promise<boolean> {
	const control = await deploymentRuntimeEvidence(env);
	const tenantResponse = await env.CUPBOARD_TENANT.fetch(
		new Request(`https://cupboard-tenant.invalid${deploymentRuntimePath}`)
	);

	if (!tenantResponse.ok) {
		return false;
	}

	const tenantValue: unknown = await tenantResponse.json();
	const tenant = deploymentRuntimeEvidenceSchema.safeParse(tenantValue);

	return (
		tenant.success &&
		control.stage === cacheStorageContractStage &&
		tenant.data.stage === cacheStorageContractStage &&
		control.manifestId === tenant.data.manifestId &&
		control.artifactId === deployment.artifactId &&
		tenant.data.artifactId === deployment.artifactId
	);
}

async function isTerminalDeploymentValid(
	env: Env,
	context: DeploymentCheckContext
): Promise<boolean> {
	if (!(await hasAppliedManifestD1Schema(context))) {
		return false;
	}

	const controls = await context.database
		.select()
		.from(d1Schema.deploymentRuntimeControl)
		.where(eq(d1Schema.deploymentRuntimeControl.id, 'current'))
		.get();

	if (
		controls?.retentionAdministration !== 'open' ||
		controls.legacyR2Writes !== 'disabled' ||
		controls.legacyR2ReadFallback !== 'disabled' ||
		controls.legacyR2Deletion !== 'eligible' ||
		controls.tenantLocalContractAdmission !== 'required'
	) {
		return false;
	}

	const repair = await context.database
		.select({ id: d1Schema.projectionRepairIntent.id })
		.from(d1Schema.projectionRepairIntent)
		.where(
			notInArray(d1Schema.projectionRepairIntent.status, [
				'complete',
				'rolled-back'
			])
		)
		.limit(1)
		.get();

	if (repair !== undefined) {
		return false;
	}

	const migrations = await context.database
		.select({
			id: d1Schema.globalDataMigration.migrationId,
			status: d1Schema.globalDataMigration.status,
			completionRevision: d1Schema.globalDataMigration.fleetCompletionRevision
		})
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
				)
			)
		)
		.all();
	const complete = new Set(
		migrations
			.filter(
				(migration) =>
					migration.status === 'complete' &&
					migration.completionRevision !== null
			)
			.map((migration) => migration.id)
	);

	if (
		deploymentManifest.dataMigrations.some(
			(migration) => !complete.has(migration.id)
		)
	) {
		return false;
	}

	return hasTerminalRuntime(env, context.deployment);
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
		await context.database
			.update(d1Schema.d1AppMutationFence)
			.set({
				state: transition.value,
				revision: sql`${d1Schema.d1AppMutationFence.revision} + 1`,
				updatedAt
			})
			.where(
				and(
					eq(d1Schema.d1AppMutationFence.id, 'application'),
					ne(d1Schema.d1AppMutationFence.state, transition.value)
				)
			)
			.run();
		const fence = await context.database
			.select({
				state: d1Schema.d1AppMutationFence.state,
				revision: d1Schema.d1AppMutationFence.revision
			})
			.from(d1Schema.d1AppMutationFence)
			.where(eq(d1Schema.d1AppMutationFence.id, 'application'))
			.get();

		if (fence?.state !== transition.value) {
			throw new DeploymentStateConflictError();
		}

		if (transition.value === 'open') {
			return { outcome: 'complete' };
		}

		await context.database
			.delete(d1Schema.d1AppMutationAdmission)
			.where(lte(d1Schema.d1AppMutationAdmission.expiresAt, updatedAt))
			.run();
		const activeAdmission = await context.database
			.select({ id: d1Schema.d1AppMutationAdmission.id })
			.from(d1Schema.d1AppMutationAdmission)
			.where(
				and(
					lt(d1Schema.d1AppMutationAdmission.fenceRevision, fence.revision),
					gt(d1Schema.d1AppMutationAdmission.expiresAt, updatedAt)
				)
			)
			.limit(1)
			.get();

		return activeAdmission === undefined
			? { outcome: 'complete' }
			: { outcome: 'running' };
	}

	const result = await context.database.run(sql`
		UPDATE deployment_runtime_control
		SET
			retention_administration = ${transition.value},
			retention_revision = CASE
				WHEN ${transition.value} = 'closed'
					THEN (SELECT revision + 1 FROM d1_application_mutation_fence WHERE id = 'application')
				ELSE retention_revision + 1
			END,
			updated_at = ${updatedAt}
		WHERE id = 'current'
			AND retention_administration <> ${transition.value}
	`);

	if (result.meta.changes > 1) {
		throw new DeploymentStateConflictError();
	}

	if (transition.value === 'open') {
		return { outcome: 'complete' };
	}

	await context.database.run(sql`
		UPDATE d1_application_mutation_fence
		SET
			revision = MAX(
				revision,
				(SELECT retention_revision FROM deployment_runtime_control WHERE id = 'current')
			),
			updated_at = ${updatedAt}
		WHERE id = 'application'
	`);
	const fence = await context.database
		.select({ revision: d1Schema.d1AppMutationFence.revision })
		.from(d1Schema.d1AppMutationFence)
		.where(eq(d1Schema.d1AppMutationFence.id, 'application'))
		.get();

	if (fence === undefined) {
		throw new DeploymentStateConflictError();
	}

	await context.database
		.delete(d1Schema.d1AppMutationAdmission)
		.where(lte(d1Schema.d1AppMutationAdmission.expiresAt, updatedAt))
		.run();
	const activeAdmission = await context.database
		.select({ id: d1Schema.d1AppMutationAdmission.id })
		.from(d1Schema.d1AppMutationAdmission)
		.where(
			and(
				lt(d1Schema.d1AppMutationAdmission.fenceRevision, fence.revision),
				gt(d1Schema.d1AppMutationAdmission.expiresAt, updatedAt)
			)
		)
		.limit(1)
		.get();

	return activeAdmission === undefined
		? { outcome: 'complete' }
		: { outcome: 'running' };
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
	env: Env,
	context: DeploymentOperationContext
): Promise<DeploymentOperationResult> {
	if (context.transition.kind !== 'resolve-repair-intents') {
		throw new DeploymentStateConflictError();
	}

	const unresolved = await context.database
		.select({
			id: d1Schema.projectionRepairIntent.id,
			tenant: d1Schema.projectionRepairIntent.tenant,
			status: d1Schema.projectionRepairIntent.status,
			operation: d1Schema.projectionRepairIntent.operation,
			payloadJson: d1Schema.projectionRepairIntent.payloadJson
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

	if (unresolved.operation !== 'managed-cache-activation') {
		return {
			outcome: 'failed',
			failure: {
				code: 'projection-repair-unresolved',
				detail: `Repair intent ${unresolved.id} has unsupported operation ${unresolved.operation}`
			}
		};
	}

	await tenantServer(env, unresolved.tenant).resolveProjectionRepair(
		unresolved.tenant,
		unresolved.id,
		unresolved.operation,
		unresolved.payloadJson
	);

	return { outcome: 'running' };
}

function d1RecoveryEnvelopeKey(
	context: DeploymentOperationContext,
	databaseId: string
): string {
	const { deployment, attemptId, transition } = context;

	return [
		'd1',
		databaseId,
		deployment.artifactId,
		deployment.instanceId,
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
	const key = d1RecoveryEnvelopeKey(context, databaseId);
	const head = await context.database
		.select({ revision: d1Schema.deploymentHead.revision })
		.from(d1Schema.deploymentHead)
		.where(eq(d1Schema.deploymentHead.id, 'current'))
		.get();
	const fence = await context.database
		.select({ revision: d1Schema.d1AppMutationFence.revision })
		.from(d1Schema.d1AppMutationFence)
		.where(eq(d1Schema.d1AppMutationFence.id, 'application'))
		.get();
	const targetState = deploymentManifest.states.find(
		(state) => state.id === context.transition.to
	);

	if (head === undefined || fence === undefined || targetState === undefined) {
		return undefined;
	}

	const payload = d1RecoveryEnvelopePayloadSchema.parse({
		databaseId,
		deployment: context.deployment,
		transitionId: context.transition.id,
		attemptId: context.attemptId,
		expectedDeploymentRevision: head.revision,
		closedApplicationFenceRevision: fence.revision,
		preContractSchemaFingerprint: targetState.d1Schema,
		phase: 'recorded',
		preContractBookmark: bookmark,
		updatedAt: context.now.toISOString()
	});
	const checksum = await sha256Hex(canonicalJson(payload));
	const body = canonicalJson({ ...payload, checksum });
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

function successorPreparationClaimExpiresAt(now: Date) {
	return isoTimestampSchema.parse(
		new Date(now.getTime() + transitionClaimDurationMs).toISOString()
	);
}

async function preparedSuccessorResult(
	database: Database,
	input: DeploymentPrepareSuccessorInput,
	revision: number
): Promise<SuccessorPreparationResult | undefined> {
	const prepared = await database
		.select()
		.from(d1Schema.successorDeploymentPreparation)
		.where(
			and(
				eq(
					d1Schema.successorDeploymentPreparation.predecessorArtifactId,
					input.predecessor.artifactId
				),
				eq(
					d1Schema.successorDeploymentPreparation.predecessorInstanceId,
					input.predecessor.instanceId
				),
				eq(
					d1Schema.successorDeploymentPreparation.successorArtifactId,
					input.successor.artifactId
				),
				eq(
					d1Schema.successorDeploymentPreparation.successorInstanceId,
					input.successor.instanceId
				)
			)
		)
		.get();

	if (prepared === undefined) {
		return;
	}

	const stored: unknown = JSON.parse(prepared.executionSnapshotJson);
	const execution = predecessorExecutionSnapshotSchema.parse(stored);

	return {
		outcome: 'prepared',
		predecessorState: deploymentStateIdSchema.parse(
			prepared.predecessorStateId
		),
		revision: deploymentRevisionSchema.parse(revision),
		claimExpiresAt: prepared.claimExpiresAt,
		execution
	};
}

function predecessorHeadPreparationCondition(
	input: DeploymentPrepareSuccessorInput
) {
	return and(
		eq(d1Schema.deploymentHead.id, 'current'),
		eq(d1Schema.deploymentHead.artifactId, input.predecessor.artifactId),
		eq(d1Schema.deploymentHead.instanceId, input.predecessor.instanceId),
		eq(d1Schema.deploymentHead.stateId, input.expectedState),
		eq(d1Schema.deploymentHead.revision, input.expectedRevision),
		eq(d1Schema.deploymentHead.status, 'active')
	);
}

export async function deploymentPrepareSuccessor(
	database: Database,
	input: DeploymentPrepareSuccessorInput,
	dependencies: DeploymentServiceDependencies = defaultDependencies
): Promise<SuccessorPreparationResult> {
	const head = await database.select().from(d1Schema.deploymentHead).get();

	if (
		head === undefined ||
		!isIdentityMatch(head, input.predecessor) ||
		head.stateId !== input.expectedState
	) {
		throw new DeploymentStateConflictError();
	}

	if (head.status === 'superseding') {
		const prepared = await preparedSuccessorResult(
			database,
			input,
			head.revision
		);

		if (
			prepared !== undefined &&
			head.revision === input.expectedRevision + 1
		) {
			return prepared;
		}

		throw new DeploymentStateConflictError();
	}

	if (head.revision !== input.expectedRevision) {
		throw new DeploymentStateConflictError();
	}

	const execution = await database
		.select()
		.from(d1Schema.deploymentTransitionExecution)
		.where(
			and(
				eq(
					d1Schema.deploymentTransitionExecution.artifactId,
					input.predecessor.artifactId
				),
				eq(
					d1Schema.deploymentTransitionExecution.instanceId,
					input.predecessor.instanceId
				),
				eq(
					d1Schema.deploymentTransitionExecution.fromStateId,
					input.expectedState
				)
			)
		)
		.orderBy(desc(d1Schema.deploymentTransitionExecution.updatedAt))
		.limit(1)
		.get();
	const now = dependencies.clock.now();
	const nowIso = isoTimestampSchema.parse(now.toISOString());
	const attempt = execution?.attemptId ?? undefined;
	const isClaimExpired =
		execution?.claimExpiresAt !== null &&
		execution?.claimExpiresAt !== undefined &&
		execution.claimExpiresAt <= nowIso;

	if (
		execution === undefined ||
		attempt === undefined ||
		execution.status === 'pending' ||
		execution.status === 'completed' ||
		(!isClaimExpired && execution.status === 'running')
	) {
		throw new DeploymentStateConflictError();
	}

	const snapshot = predecessorExecutionSnapshotSchema.parse({
		transitionId: execution.transitionId,
		attemptId: attempt,
		phase: execution.status,
		claimRevision: execution.claimRevision,
		claimExpiresAt: execution.claimExpiresAt,
		externalAction: execution.externalAction
	});
	const claimExpiresAt = successorPreparationClaimExpiresAt(now);
	const headCondition = predecessorHeadPreparationCondition(input);
	const [advanced] = await database.batch([
		database
			.update(d1Schema.deploymentHead)
			.set({
				status: 'superseding',
				revision: head.revision + 1,
				updatedAt: nowIso
			})
			.where(headCondition),
		database.insert(d1Schema.successorDeploymentPreparation).values({
			predecessorArtifactId: input.predecessor.artifactId,
			predecessorInstanceId: input.predecessor.instanceId,
			successorArtifactId: input.successor.artifactId,
			successorInstanceId: input.successor.instanceId,
			predecessorStateId: input.expectedState,
			predecessorRevision: input.expectedRevision,
			transitionId: execution.transitionId,
			attemptId: attempt,
			executionSnapshotJson: JSON.stringify(snapshot),
			status: 'prepared',
			claimExpiresAt,
			updatedAt: nowIso
		})
	]);

	if (advanced.meta.changes !== 1) {
		throw new DeploymentStateConflictError();
	}

	return {
		outcome: 'prepared',
		predecessorState: input.expectedState,
		revision: deploymentRevisionSchema.parse(head.revision + 1),
		claimExpiresAt,
		execution: snapshot
	};
}

function successorAdoptionTransition(
	input: DeploymentAdoptPredecessorInput,
	registry: DeploymentRegistry
): Extract<
	RecoveryDeploymentTransition,
	{ readonly kind: 'adopt-predecessor-deployment' }
> {
	const matches = registry.recoveryTransitions.filter(
		(transition) =>
			transition.kind === 'adopt-predecessor-deployment' &&
			transition.predecessorState === input.predecessorState &&
			transition.compatiblePredecessorArtifacts.includes(
				input.predecessor.artifactId
			)
	);

	if (matches.length !== 1) {
		throw new DeploymentStateConflictError();
	}

	const [transition] = matches;

	if (transition?.kind !== 'adopt-predecessor-deployment') {
		throw new DeploymentStateConflictError();
	}

	return transition;
}

function recoveryCheckTransition(
	transition: Extract<
		RecoveryDeploymentTransition,
		{ readonly kind: 'adopt-predecessor-deployment' }
	>
): ForwardDeploymentTransition {
	return {
		id: deploymentTransitionIdSchema.parse(transition.id),
		from: transition.predecessorState,
		to: transition.to,
		kind: 'verify',
		checks: transition.checks
	};
}

async function areSuccessorChecksSatisfied(
	checkIds: readonly DeploymentCheckId[],
	context: DeploymentOperationContext,
	registry: DeploymentRegistry
): Promise<boolean> {
	for (const checkId of checkIds) {
		const check = registry.checks[checkId];

		if (check === undefined || !(await check(context))) {
			return false;
		}
	}

	return true;
}

async function verifySuccessorRuntime(
	env: Env,
	input: DeploymentAdoptPredecessorInput,
	transition: Extract<
		RecoveryDeploymentTransition,
		{ readonly kind: 'adopt-predecessor-deployment' }
	>,
	registry: DeploymentRegistry
): Promise<Awaited<ReturnType<typeof deploymentRuntimeEvidence>>> {
	const target = registry.states.find((state) => state.id === transition.to);
	const observation = input.externalObservation;

	if (
		target?.tenantRuntime.kind !== 'registered' ||
		target.controlRuntime.kind !== 'registered' ||
		target.tenantRuntime.stage !== target.controlRuntime.stage ||
		observation.kind !== 'runtime-stage' ||
		observation.stage !== target.controlRuntime.stage
	) {
		throw new DeploymentStateConflictError();
	}

	const control = await deploymentRuntimeEvidence(env);
	const tenantResponse = await env.CUPBOARD_TENANT.fetch(
		new Request(`https://cupboard-tenant.invalid${deploymentRuntimePath}`)
	);

	if (!tenantResponse.ok) {
		throw new DeploymentStateConflictError();
	}

	const tenantValue: unknown = await tenantResponse.json();
	const tenant = deploymentRuntimeEvidenceSchema.parse(tenantValue);

	if (
		control.stage !== target.controlRuntime.stage ||
		tenant.stage !== target.tenantRuntime.stage ||
		control.manifestId !== tenant.manifestId ||
		control.artifactId !== input.successor.artifactId ||
		tenant.artifactId !== input.successor.artifactId ||
		control.versionId !== observation.controlVersionId ||
		tenant.versionId !== observation.tenantVersionId
	) {
		throw new DeploymentStateConflictError();
	}

	return control;
}

async function adoptMigrationResults(
	database: Database,
	predecessor: DeploymentIdentity,
	successor: DeploymentIdentity,
	transition: Extract<
		RecoveryDeploymentTransition,
		{ readonly kind: 'adopt-predecessor-deployment' }
	>,
	context: DeploymentOperationContext,
	registry: DeploymentRegistry,
	nowIso: ReturnType<typeof isoTimestampSchema.parse>
): Promise<DeploymentFailure | undefined> {
	for (const adoption of transition.migrationResults) {
		const descriptor = registry.dataMigrations.find(
			(candidate) => candidate.id === adoption.successorMigration
		);

		if (descriptor === undefined) {
			return { code: 'successor-migration-unregistered' };
		}

		if (
			adoption.completed.kind === 'reverify' &&
			!(await areSuccessorChecksSatisfied(
				adoption.completed.checks,
				context,
				registry
			))
		) {
			return { code: 'successor-completed-result-unverified' };
		}

		if (adoption.invariantFailure.kind === 'repair') {
			return { code: 'successor-forward-repair-required' };
		}

		const predecessorGlobal = await database
			.select()
			.from(d1Schema.globalDataMigration)
			.where(
				and(
					eq(d1Schema.globalDataMigration.artifactId, predecessor.artifactId),
					eq(d1Schema.globalDataMigration.instanceId, predecessor.instanceId),
					eq(
						d1Schema.globalDataMigration.migrationId,
						adoption.predecessorMigration
					)
				)
			)
			.get();

		if (predecessorGlobal === undefined) {
			continue;
		}

		await database
			.insert(d1Schema.globalDataMigration)
			.values({
				artifactId: successor.artifactId,
				instanceId: successor.instanceId,
				migrationId: adoption.successorMigration,
				status: 'pending',
				cohortCreatedAt: predecessorGlobal.cohortCreatedAt,
				cohortHighWater: predecessorGlobal.cohortHighWater,
				scanHighWaterJson: predecessorGlobal.scanHighWaterJson,
				claimRevision: 0
			})
			.onConflictDoNothing();

		const shouldPreserveComplete = adoption.completed.kind === 'reverify';
		const preserveCompleteFlag = shouldPreserveComplete ? 1 : 0;
		const preserveFailureFlag = 1;

		await database.run(sql`
			INSERT INTO tenant_data_migration (
				artifact_id,
				instance_id,
				migration_id,
				implementation_revision,
				tenant,
				status,
				attempts,
				claim_revision,
				completed_at,
				last_failure_json
			)
			SELECT
				${successor.artifactId},
				${successor.instanceId},
				${adoption.successorMigration},
				${descriptor.implementationRevision},
				tenant,
				CASE
					WHEN status = 'complete' AND ${preserveCompleteFlag} = 1 THEN 'complete'
					WHEN status = 'failed' AND ${preserveFailureFlag} = 1 THEN 'failed'
					ELSE 'pending'
				END,
				0,
				0,
				CASE
					WHEN status = 'complete' AND ${preserveCompleteFlag} = 1 THEN ${nowIso}
					ELSE NULL
				END,
				CASE
					WHEN status = 'failed' AND ${preserveFailureFlag} = 1 THEN last_failure_json
					ELSE NULL
				END
			FROM tenant_data_migration
			WHERE artifact_id = ${predecessor.artifactId}
				AND instance_id = ${predecessor.instanceId}
				AND migration_id = ${adoption.predecessorMigration}
			ON CONFLICT (artifact_id, instance_id, migration_id, tenant) DO NOTHING
		`);
	}
}

function predecessorHeadAdoptionCondition(
	input: DeploymentAdoptPredecessorInput
) {
	return and(
		eq(d1Schema.deploymentHead.id, 'current'),
		eq(d1Schema.deploymentHead.artifactId, input.predecessor.artifactId),
		eq(d1Schema.deploymentHead.instanceId, input.predecessor.instanceId),
		eq(d1Schema.deploymentHead.revision, input.expectedRevision),
		eq(d1Schema.deploymentHead.status, 'superseding')
	);
}

function successorPreparationCondition(input: DeploymentAdoptPredecessorInput) {
	return and(
		eq(
			d1Schema.successorDeploymentPreparation.predecessorArtifactId,
			input.predecessor.artifactId
		),
		eq(
			d1Schema.successorDeploymentPreparation.predecessorInstanceId,
			input.predecessor.instanceId
		),
		eq(
			d1Schema.successorDeploymentPreparation.successorArtifactId,
			input.successor.artifactId
		),
		eq(
			d1Schema.successorDeploymentPreparation.successorInstanceId,
			input.successor.instanceId
		)
	);
}

export async function deploymentAdoptPredecessor(
	database: Database,
	input: DeploymentAdoptPredecessorInput,
	dependencies: DeploymentServiceDependencies = defaultDependencies
): Promise<DeploymentAdoptionResult> {
	const transition = successorAdoptionTransition(input, dependencies.registry);
	const head = await database.select().from(d1Schema.deploymentHead).get();

	if (
		head === undefined ||
		!isIdentityMatch(head, input.predecessor) ||
		head.status !== 'superseding' ||
		head.stateId !== input.predecessorState ||
		head.revision !== input.expectedRevision
	) {
		throw new DeploymentStateConflictError();
	}

	const preparation = await database
		.select()
		.from(d1Schema.successorDeploymentPreparation)
		.where(
			and(
				eq(
					d1Schema.successorDeploymentPreparation.predecessorArtifactId,
					input.predecessor.artifactId
				),
				eq(
					d1Schema.successorDeploymentPreparation.predecessorInstanceId,
					input.predecessor.instanceId
				),
				eq(
					d1Schema.successorDeploymentPreparation.successorArtifactId,
					input.successor.artifactId
				),
				eq(
					d1Schema.successorDeploymentPreparation.successorInstanceId,
					input.successor.instanceId
				)
			)
		)
		.get();

	if (
		preparation === undefined ||
		preparation.predecessorRevision + 1 !== input.expectedRevision ||
		preparation.attemptId !== input.attemptId ||
		(preparation.status !== 'prepared' && preparation.status !== 'adopting')
	) {
		throw new DeploymentStateConflictError();
	}

	const stored: unknown = JSON.parse(preparation.executionSnapshotJson);
	const snapshot = predecessorExecutionSnapshotSchema.parse(stored);

	if (snapshot.phase === 'running') {
		if (transition.expiredExecution.kind === 'reject') {
			return {
				outcome: 'failed',
				failure: { code: 'predecessor-execution-not-adoptable' }
			};
		}

		const wasExternalActionIssued =
			snapshot.externalAction === 'issued' ||
			snapshot.externalAction === 'observed';

		if (
			(wasExternalActionIssued &&
				transition.expiredExecution.kind !== 'observe-external-effects') ||
			(!wasExternalActionIssued &&
				transition.expiredExecution.kind !== 'abandon-unissued')
		) {
			return {
				outcome: 'failed',
				failure: { code: 'predecessor-external-action-unsettled' }
			};
		}
	}

	const observeRuntime = dependencies.observeSuccessorRuntime;

	if (observeRuntime === undefined) {
		throw new DeploymentStateConflictError();
	}

	const runtime = await observeRuntime(
		input,
		transition,
		dependencies.registry
	);
	const now = dependencies.clock.now();
	const nowIso = isoTimestampSchema.parse(now.toISOString());
	const operationContext: DeploymentOperationContext = {
		database,
		deployment: input.successor,
		attemptId: input.attemptId,
		transition: recoveryCheckTransition(transition),
		now,
		externalObservation: input.externalObservation
	};
	const checks = [
		...transition.checks,
		...(snapshot.phase === 'running' &&
		transition.expiredExecution.kind === 'observe-external-effects'
			? transition.expiredExecution.checks
			: [])
	];

	if (
		!(await areSuccessorChecksSatisfied(
			checks,
			operationContext,
			dependencies.registry
		))
	) {
		return {
			outcome: 'failed',
			failure: { code: 'successor-adoption-check-failed' }
		};
	}

	const migrationFailure = await adoptMigrationResults(
		database,
		input.predecessor,
		input.successor,
		transition,
		operationContext,
		dependencies.registry,
		nowIso
	);

	if (migrationFailure !== undefined) {
		return { outcome: 'failed', failure: migrationFailure };
	}

	const headCondition = predecessorHeadAdoptionCondition(input);
	const preparationCondition = successorPreparationCondition(input);
	const [advanced] = await database.batch([
		database
			.update(d1Schema.deploymentHead)
			.set({
				manifestId: runtime.manifestId,
				artifactId: input.successor.artifactId,
				instanceId: input.successor.instanceId,
				stateId: transition.to,
				revision: head.revision + 1,
				status: 'active',
				updatedAt: nowIso
			})
			.where(headCondition),
		database
			.update(d1Schema.successorDeploymentPreparation)
			.set({ status: 'complete', updatedAt: nowIso })
			.where(preparationCondition)
	]);

	if (advanced.meta.changes !== 1) {
		throw new DeploymentStateConflictError();
	}

	return {
		outcome: 'completed',
		deployment: input.successor,
		state: transition.to,
		revision: deploymentRevisionSchema.parse(head.revision + 1)
	};
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
					transitionId: deploymentExecutionTransitionIdSchema.parse(
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

function executableRecoveryTransition(
	input: DeploymentRecoverInput,
	registry: DeploymentRegistry
): ExecutableRecoveryTransition {
	const matches = registry.recoveryTransitions.filter(
		(transition) =>
			transition.kind !== 'adopt-predecessor-deployment' &&
			transition.from === input.expectedState &&
			transition.to === input.targetRecoveryState
	);

	if (matches.length !== 1) {
		throw new DeploymentStateConflictError();
	}

	const [transition] = matches;

	if (
		transition === undefined ||
		transition.kind === 'adopt-predecessor-deployment'
	) {
		throw new DeploymentStateConflictError();
	}

	return transition;
}

function requiresRecoveryExternalAction(
	transition: ExecutableRecoveryTransition
): boolean {
	return (
		transition.kind === 'restore-d1' ||
		transition.kind === 'deploy-recovery-stage'
	);
}

async function d1RecoveryExternalAction(
	database: Database,
	input: DeploymentRecoverInput,
	transition: Extract<
		ExecutableRecoveryTransition,
		{ readonly kind: 'restore-d1' }
	>,
	registry: DeploymentRegistry
): Promise<DeploymentExternalAction> {
	const recording = registry.transitions.filter(
		(candidate) =>
			candidate.kind === 'record-recovery-point' &&
			candidate.storage === transition.recoveryEnvelope
	);

	if (recording.length !== 1) {
		throw new DeploymentStateConflictError();
	}

	const [recordingTransition] = recording;

	if (recordingTransition === undefined) {
		throw new DeploymentStateConflictError();
	}

	const point = await database
		.select()
		.from(d1Schema.deploymentD1RecoveryPoint)
		.where(
			and(
				eq(
					d1Schema.deploymentD1RecoveryPoint.artifactId,
					input.deployment.artifactId
				),
				eq(
					d1Schema.deploymentD1RecoveryPoint.instanceId,
					input.deployment.instanceId
				),
				eq(
					d1Schema.deploymentD1RecoveryPoint.transitionId,
					recordingTransition.id
				)
			)
		)
		.get();

	if (point === undefined) {
		throw new DeploymentStateConflictError();
	}

	return {
		kind: 'restore-d1',
		databaseId: point.databaseId,
		preContractBookmark: point.bookmark,
		recoveryEnvelopeKey: point.envelopeKey
	};
}

async function recoveryExternalAction(
	database: Database,
	input: DeploymentRecoverInput,
	transition: ExecutableRecoveryTransition,
	registry: DeploymentRegistry
): Promise<DeploymentExternalAction> {
	if (transition.kind === 'deploy-recovery-stage') {
		return {
			kind: 'deploy-runtime-stage',
			stage: transition.stage,
			tenantFirst: true
		};
	}

	if (transition.kind === 'restore-d1') {
		return d1RecoveryExternalAction(database, input, transition, registry);
	}

	throw new DeploymentStateConflictError();
}

function isRestoredD1State(
	head: typeof d1Schema.deploymentHead.$inferSelect,
	input: DeploymentRecoverInput,
	transition: ExecutableRecoveryTransition
): boolean {
	return (
		transition.kind === 'restore-d1' &&
		input.externalObservation?.kind === 'd1-restoration' &&
		head.stateId === transition.to &&
		head.revision <= input.expectedRevision
	);
}

export async function deploymentRecover(
	database: Database,
	input: DeploymentRecoverInput,
	dependencies: DeploymentServiceDependencies = defaultDependencies
): Promise<DeploymentRecoveryResult> {
	const transition = executableRecoveryTransition(input, dependencies.registry);
	const head = await database.select().from(d1Schema.deploymentHead).get();

	if (
		head === undefined ||
		!isIdentityMatch(head, input.deployment) ||
		head.status !== 'active'
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

	const isRestoredState = isRestoredD1State(head, input, transition);

	if (
		!isRestoredState &&
		(head.stateId !== input.expectedState ||
			head.revision !== input.expectedRevision)
	) {
		throw new DeploymentStateConflictError();
	}

	const now = dependencies.clock.now();
	const nowIso = isoTimestampSchema.parse(now.toISOString());
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
		return {
			outcome: 'failed',
			attemptId: deploymentAttemptIdSchema.parse(execution.attemptId),
			failure: parseFailure(execution.lastFailureJson) ?? {
				code: 'deployment-recovery-failed'
			}
		};
	}

	const existingAttempt = execution?.attemptId ?? undefined;
	const isClaimExpired =
		execution?.claimExpiresAt !== null &&
		execution?.claimExpiresAt !== undefined &&
		execution.claimExpiresAt <= nowIso;

	if (
		!isClaimExpired &&
		existingAttempt !== undefined &&
		input.attemptId !== existingAttempt
	) {
		throw new DeploymentStateConflictError();
	}

	const attemptId = deploymentAttemptIdSchema.parse(
		input.attemptId ??
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
			externalAction: requiresRecoveryExternalAction(transition)
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

	if (
		requiresRecoveryExternalAction(transition) &&
		input.externalObservation === undefined
	) {
		const action = await recoveryExternalAction(
			database,
			input,
			transition,
			dependencies.registry
		);

		if (action.kind === 'restore-d1') {
			const prepareD1Restore = dependencies.prepareD1Restore;

			if (prepareD1Restore === undefined) {
				throw new DeploymentStateConflictError();
			}

			await prepareD1Restore(action, now);
		}

		return {
			outcome: 'external-action-required',
			attemptId,
			action
		};
	}

	const context: DeploymentRecoveryOperationContext = {
		database,
		deployment: input.deployment,
		attemptId,
		transition,
		now,
		...(input.externalObservation !== undefined && {
			externalObservation: input.externalObservation
		})
	};

	if (input.externalObservation?.kind === 'd1-restoration') {
		const recordD1Restoration = dependencies.recordD1Restoration;

		if (recordD1Restoration === undefined) {
			throw new DeploymentStateConflictError();
		}

		await recordD1Restoration(context);
	}

	for (const checkId of transition.checks) {
		const check = dependencies.registry.checks[checkId];

		if (check === undefined || !(await check(context))) {
			throw new DeploymentStateConflictError();
		}
	}

	const operation =
		transition.kind === 'forward-repair'
			? dependencies.registry.forwardRepairs?.[transition.repair]
			: dependencies.registry.recoveryOperations?.[transition.kind];

	if (operation === undefined) {
		throw new DeploymentStateConflictError();
	}

	const operationResult = await operation(context);

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
			)
			.run();

		return {
			outcome: 'failed',
			attemptId,
			failure: operationResult.failure
		};
	}

	const targetRevision = input.expectedRevision + 1;
	const headCondition = isRestoredState
		? and(
				eq(d1Schema.deploymentHead.id, 'current'),
				eq(d1Schema.deploymentHead.artifactId, input.deployment.artifactId),
				eq(d1Schema.deploymentHead.instanceId, input.deployment.instanceId),
				eq(d1Schema.deploymentHead.stateId, transition.to),
				lte(d1Schema.deploymentHead.revision, input.expectedRevision)
			)
		: and(
				eq(d1Schema.deploymentHead.id, 'current'),
				eq(d1Schema.deploymentHead.artifactId, input.deployment.artifactId),
				eq(d1Schema.deploymentHead.instanceId, input.deployment.instanceId),
				eq(d1Schema.deploymentHead.stateId, input.expectedState),
				eq(d1Schema.deploymentHead.revision, input.expectedRevision)
			);
	const advanced = await database
		.update(d1Schema.deploymentHead)
		.set({
			stateId: transition.to,
			revision: targetRevision,
			updatedAt: nowIso
		})
		.where(headCondition)
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
		)
		.run();

	return {
		outcome: 'completed',
		state: deploymentStateIdSchema.parse(transition.to),
		revision: deploymentRevisionSchema.parse(targetRevision)
	};
}
