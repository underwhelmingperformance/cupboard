import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { cacheDataMigrationsStage } from '@cupboard/protocol/cache-deployment-manifest';
import { canonicalJson } from '@cupboard/protocol/canonical-json';
import {
	deploymentArtifactIdSchema,
	deploymentAttemptIdSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema,
	deploymentManifestIdSchema,
	deploymentRevisionSchema,
	deploymentStateIdSchema,
	deploymentTransitionIdSchema
} from '@cupboard/protocol/deployment';
import {
	d1SchemaStateIdSchema,
	dataMigrationCheckpointIdSchema,
	dataMigrationIdSchema,
	dataMigrationRevisionSchema,
	deploymentRecoveryTransitionIdSchema,
	type DeploymentState,
	durableObjectMigrationIdSchema,
	registeredForwardRepairIdSchema,
	writerEpochSchema
} from '@cupboard/protocol/deployment-manifest';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sha256Hex } from '../crypto/crypto.ts';
import { withAppMutationAdmission } from '../db/app-mutation-admission.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { deploymentManifest } from '../deployment-manifest.generated.ts';
import {
	AppWritesFencedError,
	DeploymentStateConflictError
} from '../errors.ts';

import {
	deploymentAdoptPredecessor,
	deploymentAdvance,
	deploymentPrepareSuccessor,
	deploymentRecover,
	type DeploymentServiceDependencies,
	deploymentServiceDependencies,
	deploymentStatus
} from './deployment.ts';

const identity: DeploymentIdentity = {
	artifactId: deploymentArtifactIdSchema.parse('a'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
};
const successorIdentity: DeploymentIdentity = {
	artifactId: deploymentArtifactIdSchema.parse('d'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('e'.repeat(64))
};
const state = deploymentStateIdSchema.parse('foundation');
const nextState = deploymentStateIdSchema.parse('data-migrations');
const now = isoTimestampSchema.parse('2026-09-01T00:00:00.000Z');
const attemptId = deploymentAttemptIdSchema.parse(
	'0199a0ea-1a00-7000-8000-000000000001'
);
const successorManifestId = deploymentManifestIdSchema.parse('f'.repeat(64));
const recoveryState: DeploymentState = {
	id: nextState,
	d1Schema: d1SchemaStateIdSchema.parse('expanded'),
	tenantRuntime: { kind: 'registered', stage: cacheDataMigrationsStage },
	controlRuntime: { kind: 'registered', stage: cacheDataMigrationsStage },
	localSchema: {
		runtimeCeiling: durableObjectMigrationIdSchema.parse('0049'),
		fleetState: 'migrating'
	},
	writerEpoch: writerEpochSchema.parse('cache-lifecycle-v1'),
	representations: {
		catalogue: 'native',
		r2Metadata: 'dual',
		retention: 'dual',
		legacyR2: {
			writes: 'enabled',
			readFallback: 'enabled',
			deletion: 'forbidden'
		}
	},
	fences: {
		d1ApplicationWrites: 'open',
		retentionAdministration: 'open',
		tenantLocalContractAdmission: 'not-required'
	},
	recoveryPoints: { d1: 'absent', durableObjectFleet: 'absent' }
};
const d1RecoveryEnvelopeSchema = z.strictObject({
	databaseId: z.string(),
	deployment: z.strictObject({
		artifactId: z.string(),
		instanceId: z.string()
	}),
	transitionId: z.string(),
	attemptId: z.string(),
	expectedDeploymentRevision: z.int().nonnegative(),
	closedApplicationFenceRevision: z.int().nonnegative(),
	preContractSchemaFingerprint: z.string(),
	phase: z.enum([
		'recorded',
		'restore-requested',
		'restored-awaiting-verification',
		'complete'
	]),
	preContractBookmark: z.string(),
	restoreUndoBookmark: z.string().optional(),
	updatedAt: isoTimestampSchema,
	checksum: z.string()
});

const verifyDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: [
			{
				id: deploymentTransitionIdSchema.parse('verify-foundation'),
				from: state,
				to: nextState,
				kind: 'verify',
				checks: []
			}
		],
		recoveryTransitions: [],
		states: [],
		dataMigrations: [],
		d1Migrations: [],
		operations: {},
		checks: {}
	},
	clock: {
		now: () => new Date(now),
		randomUuid: () => attemptId
	}
};

const externalDependencies: DeploymentServiceDependencies = {
	...verifyDependencies,
	registry: {
		transitions: [
			{
				id: deploymentTransitionIdSchema.parse('deploy-data-migrations'),
				from: state,
				to: nextState,
				kind: 'deploy-runtime-stage',
				stage: cacheDataMigrationsStage,
				checks: []
			}
		],
		recoveryTransitions: [],
		states: [],
		dataMigrations: [],
		d1Migrations: [],
		operations: {},
		checks: {}
	}
};

const recoveryDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: [],
		recoveryTransitions: [
			{
				id: deploymentRecoveryTransitionIdSchema.parse('adopt-failed-release'),
				kind: 'adopt-predecessor-deployment',
				compatiblePredecessorArtifacts: [identity.artifactId],
				predecessorState: state,
				to: nextState,
				expiredExecution: { kind: 'abandon-unissued' },
				migrationResults: [],
				checks: []
			}
		],
		states: [recoveryState],
		dataMigrations: [],
		d1Migrations: [],
		operations: {},
		checks: {}
	},
	clock: verifyDependencies.clock,
	observeSuccessorRuntime: () =>
		Promise.resolve({ manifestId: successorManifestId })
};

const repairId = registeredForwardRepairIdSchema.parse('repair-cache-state');
const repairDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: [],
		recoveryTransitions: [
			{
				id: deploymentRecoveryTransitionIdSchema.parse('repair-data-runtime'),
				from: nextState,
				to: state,
				kind: 'forward-repair',
				repair: repairId,
				checks: []
			}
		],
		states: [],
		dataMigrations: [],
		d1Migrations: [],
		operations: {},
		forwardRepairs: {
			[repairId]: () => Promise.resolve({ outcome: 'complete' })
		},
		checks: {}
	},
	clock: verifyDependencies.clock
};

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

function currentDeploymentDependencies(): DeploymentServiceDependencies {
	return {
		...deploymentServiceDependencies(env),
		clock: verifyDependencies.clock
	};
}

beforeEach(async () => {
	const d1 = database();
	await d1.delete(d1Schema.deploymentTransitionExecution);
	await d1.delete(d1Schema.successorDeploymentPreparation);
	await d1.delete(d1Schema.deploymentHead);
	await d1.delete(d1Schema.tenantDataMigration);
	await d1.delete(d1Schema.globalDataMigration);
	await d1.delete(d1Schema.deploymentWriterDrainTenant);
	await d1.delete(d1Schema.deploymentWriterCutover);
	await d1.delete(d1Schema.projectionRepairIntent);
	await d1.delete(d1Schema.deploymentD1RecoveryPoint);
	await d1.delete(d1Schema.structuralMigrationChecksum);
	await d1.delete(d1Schema.d1AppMutationAdmission);
	const recoveryObjects = await env.DEPLOYMENT_RECOVERY.list();

	if (recoveryObjects.objects.length > 0) {
		await env.DEPLOYMENT_RECOVERY.delete(
			recoveryObjects.objects.map((object) => object.key)
		);
	}

	await d1
		.update(d1Schema.d1AppMutationFence)
		.set({ state: 'open', revision: 0, updatedAt: now });
	await d1.update(d1Schema.deploymentRuntimeControl).set({
		retentionAdministration: 'open',
		retentionRevision: 0,
		legacyR2Writes: 'enabled',
		legacyR2ReadFallback: 'enabled',
		legacyR2Deletion: 'forbidden',
		tenantLocalContractAdmission: 'not-required',
		updatedAt: now
	});
});

async function setDeploymentHead(
	d1: ReturnType<typeof database>,
	deploymentState: string,
	revision = 0
): Promise<void> {
	await d1.insert(d1Schema.deploymentHead).values({
		id: 'current',
		manifestId: 'c'.repeat(64),
		artifactId: identity.artifactId,
		instanceId: identity.instanceId,
		stateId: deploymentState,
		revision,
		status: 'active',
		updatedAt: now
	});
}

async function recordManifestD1Checksums(
	d1: ReturnType<typeof database>
): Promise<void> {
	for (const migration of deploymentManifest.d1Migrations) {
		await d1.insert(d1Schema.structuralMigrationChecksum).values({
			kind: 'd1',
			migrationId: migration.id,
			sha256: migration.sha256,
			appliedAt: now
		});
	}
}

interface RecordedD1RecoveryPoint {
	readonly envelopeKey: string;
}

async function recordD1RecoveryPoint(
	d1: ReturnType<typeof database>
): Promise<RecordedD1RecoveryPoint> {
	await setDeploymentHead(d1, 'repairs-resolved');
	const dependencies = currentDeploymentDependencies();
	const input = {
		deployment: identity,
		expectedState: deploymentStateIdSchema.parse('repairs-resolved'),
		targetState: deploymentStateIdSchema.parse('d1-recovery-recorded'),
		expectedRevision: deploymentRevisionSchema.parse(0)
	};
	const claimed = await deploymentAdvance(d1, input, dependencies);

	if (claimed.outcome !== 'external-action-required') {
		throw new Error('The D1 recovery-point transition was not claimed');
	}

	const completed = await deploymentAdvance(
		d1,
		{
			...input,
			attemptId: claimed.attemptId,
			externalObservation: {
				kind: 'd1-recovery-point',
				databaseId: 'd1-database',
				bookmark: 'bookmark-1'
			}
		},
		dependencies
	);

	if (completed.outcome !== 'completed') {
		throw new Error('The D1 recovery point was not recorded');
	}

	const point = await d1
		.select({ envelopeKey: d1Schema.deploymentD1RecoveryPoint.envelopeKey })
		.from(d1Schema.deploymentD1RecoveryPoint)
		.get();

	if (point === undefined) {
		throw new Error('The D1 recovery point row was not recorded');
	}

	return { envelopeKey: point.envelopeKey };
}

async function failedPredecessor(
	d1: ReturnType<typeof database>,
	externalAction: 'not-required' | 'issued' = 'not-required',
	status: 'failed' | 'running' = 'failed'
): Promise<void> {
	await setDeploymentHead(d1, state, 4);
	await d1.insert(d1Schema.deploymentTransitionExecution).values({
		artifactId: identity.artifactId,
		instanceId: identity.instanceId,
		transitionId: 'failed-transition',
		fromStateId: state,
		toStateId: nextState,
		status,
		attemptId,
		claimRevision: 2,
		claimExpiresAt: isoTimestampSchema.parse('2026-08-31T23:59:00.000Z'),
		externalAction,
		startedAt: now,
		lastFailureJson:
			status === 'failed'
				? JSON.stringify({ code: 'faulty-migrator' })
				: undefined,
		updatedAt: now
	});
}

describe('deploymentStatus', () => {
	it('reports an uninitialised database without changing it', async () => {
		await expect(deploymentStatus(database(), identity)).resolves.toStrictEqual(
			{
				state: 'uninitialised'
			}
		);
	});

	it('reports the exact persisted deployment head', async () => {
		const d1 = database();
		await d1.insert(d1Schema.deploymentHead).values({
			id: 'current',
			manifestId: 'c'.repeat(64),
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			stateId: state,
			revision: 4,
			status: 'active',
			updatedAt: now
		});

		await expect(deploymentStatus(d1, identity)).resolves.toStrictEqual({
			state: 'current',
			deployment: identity,
			deploymentState: state,
			revision: deploymentRevisionSchema.parse(4),
			status: 'active'
		});
	});

	it('refuses a different deployment instance', async () => {
		const d1 = database();
		await d1.insert(d1Schema.deploymentHead).values({
			id: 'current',
			manifestId: 'c'.repeat(64),
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			stateId: state,
			revision: 4,
			status: 'active',
			updatedAt: now
		});

		const otherInstance = deploymentInstanceIdSchema.parse('d'.repeat(64));
		const status = deploymentStatus(d1, {
			...identity,
			instanceId: otherInstance
		});

		await expect(status).rejects.toBeInstanceOf(DeploymentStateConflictError);
	});
});

describe('successor deployment adoption', () => {
	it('prepares one exact successor and fences the predecessor', async () => {
		const d1 = database();
		await failedPredecessor(d1);
		const input = {
			predecessor: identity,
			successor: successorIdentity,
			expectedState: state,
			expectedRevision: deploymentRevisionSchema.parse(4)
		};

		const prepared = await deploymentPrepareSuccessor(
			d1,
			input,
			recoveryDependencies
		);

		expect(prepared).toStrictEqual({
			outcome: 'prepared',
			predecessorState: state,
			revision: deploymentRevisionSchema.parse(5),
			claimExpiresAt: isoTimestampSchema.parse('2026-09-01T00:05:00.000Z'),
			execution: {
				transitionId: 'failed-transition',
				attemptId,
				phase: 'failed',
				claimRevision: 2,
				claimExpiresAt: '2026-08-31T23:59:00.000Z',
				externalAction: 'not-required'
			}
		});
		await expect(
			deploymentPrepareSuccessor(d1, input, recoveryDependencies)
		).resolves.toStrictEqual(prepared);
		await expect(
			deploymentAdvance(
				d1,
				{
					deployment: identity,
					expectedState: state,
					targetState: nextState,
					expectedRevision: deploymentRevisionSchema.parse(5)
				},
				verifyDependencies
			)
		).rejects.toBeInstanceOf(DeploymentStateConflictError);
	});

	it('adopts the prepared predecessor through the sole manifest edge', async () => {
		const d1 = database();
		await failedPredecessor(d1);
		const prepared = await deploymentPrepareSuccessor(
			d1,
			{
				predecessor: identity,
				successor: successorIdentity,
				expectedState: state,
				expectedRevision: deploymentRevisionSchema.parse(4)
			},
			recoveryDependencies
		);

		await expect(
			deploymentAdoptPredecessor(
				d1,
				{
					predecessor: identity,
					successor: successorIdentity,
					predecessorState: state,
					expectedRevision: prepared.revision,
					attemptId,
					externalObservation: {
						kind: 'runtime-stage',
						stage: cacheDataMigrationsStage,
						tenantVersionId: 'successor-tenant',
						controlVersionId: 'successor-control',
						tenantTrafficPercent: 100,
						controlTrafficPercent: 100
					}
				},
				recoveryDependencies
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			deployment: successorIdentity,
			state: nextState,
			revision: deploymentRevisionSchema.parse(6)
		});
		await expect(
			d1.select().from(d1Schema.deploymentHead).get()
		).resolves.toMatchObject({
			manifestId: successorManifestId,
			artifactId: successorIdentity.artifactId,
			instanceId: successorIdentity.instanceId,
			stateId: nextState,
			revision: 6,
			status: 'active'
		});
	});

	it('does not abandon an expired external action without an observation rule', async () => {
		const d1 = database();
		await failedPredecessor(d1, 'issued', 'running');
		const prepared = await deploymentPrepareSuccessor(
			d1,
			{
				predecessor: identity,
				successor: successorIdentity,
				expectedState: state,
				expectedRevision: deploymentRevisionSchema.parse(4)
			},
			recoveryDependencies
		);

		await expect(
			deploymentAdoptPredecessor(
				d1,
				{
					predecessor: identity,
					successor: successorIdentity,
					predecessorState: state,
					expectedRevision: prepared.revision,
					attemptId,
					externalObservation: {
						kind: 'runtime-stage',
						stage: cacheDataMigrationsStage,
						tenantVersionId: 'successor-tenant',
						controlVersionId: 'successor-control',
						tenantTrafficPercent: 100,
						controlTrafficPercent: 100
					}
				},
				recoveryDependencies
			)
		).resolves.toStrictEqual({
			outcome: 'failed',
			failure: { code: 'predecessor-external-action-unsettled' }
		});
	});

	it('revalidates not-applicable results instead of copying them', async () => {
		const d1 = database();
		const predecessorMigration = dataMigrationIdSchema.parse('old-migration');
		const successorMigration = dataMigrationIdSchema.parse('fixed-migration');
		const implementationRevision =
			dataMigrationRevisionSchema.parse('fixed-v1');
		const completeTenant = tenantIdSchema.parse('complete-tenant');
		const inapplicableTenant = tenantIdSchema.parse('inapplicable-tenant');
		const checkpoint = dataMigrationCheckpointIdSchema.parse('start');
		const migrationDependencies: DeploymentServiceDependencies = {
			...recoveryDependencies,
			registry: {
				...recoveryDependencies.registry,
				recoveryTransitions: [
					{
						id: deploymentRecoveryTransitionIdSchema.parse(
							'adopt-migration-results'
						),
						kind: 'adopt-predecessor-deployment',
						compatiblePredecessorArtifacts: [identity.artifactId],
						predecessorState: state,
						to: nextState,
						expiredExecution: { kind: 'abandon-unissued' },
						migrationResults: [
							{
								predecessorMigration,
								successorMigration,
								completed: { kind: 'reverify', checks: [] },
								notApplicable: {
									kind: 'revalidate',
									checks: [],
									becameApplicable: { kind: 'restart', checkpoint }
								},
								incomplete: { kind: 'restart', checkpoint },
								invariantFailure: { kind: 'preserve' }
							}
						],
						checks: []
					}
				],
				dataMigrations: [
					{
						id: successorMigration,
						implementationRevision,
						source: 'dual',
						target: 'native',
						tenantStatuses: ['active'],
						runtimeStage: cacheDataMigrationsStage,
						d1Schemas: [d1SchemaStateIdSchema.parse('expanded')],
						budget: {
							maximumStatements: 1,
							maximumRowsReturned: 1,
							maximumReportedD1RowsRead: 1,
							maximumRowsWritten: 1,
							maximumParametersPerStatement: 1,
							maximumR2Operations: 0,
							maximumR2BytesRead: 0,
							maximumR2BytesWritten: 0
						},
						retryableFailures: [],
						terminalFailures: []
					}
				]
			}
		};

		await failedPredecessor(d1);
		await d1.insert(d1Schema.globalDataMigration).values({
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			migrationId: predecessorMigration,
			status: 'complete',
			cohortCreatedAt: now,
			cohortHighWater: 2,
			scanHighWaterJson: JSON.stringify({ scanComplete: true }),
			claimRevision: 1,
			fleetCompletionRevision: 1,
			completedAt: now
		});
		await d1.insert(d1Schema.tenantDataMigration).values([
			{
				artifactId: identity.artifactId,
				instanceId: identity.instanceId,
				migrationId: predecessorMigration,
				implementationRevision: 'old-v1',
				tenant: completeTenant,
				status: 'complete',
				completedAt: now
			},
			{
				artifactId: identity.artifactId,
				instanceId: identity.instanceId,
				migrationId: predecessorMigration,
				implementationRevision: 'old-v1',
				tenant: inapplicableTenant,
				status: 'not-applicable',
				completedAt: now
			}
		]);
		const prepared = await deploymentPrepareSuccessor(
			d1,
			{
				predecessor: identity,
				successor: successorIdentity,
				expectedState: state,
				expectedRevision: deploymentRevisionSchema.parse(4)
			},
			migrationDependencies
		);

		await deploymentAdoptPredecessor(
			d1,
			{
				predecessor: identity,
				successor: successorIdentity,
				predecessorState: state,
				expectedRevision: prepared.revision,
				attemptId,
				externalObservation: {
					kind: 'runtime-stage',
					stage: cacheDataMigrationsStage,
					tenantVersionId: 'successor-tenant',
					controlVersionId: 'successor-control',
					tenantTrafficPercent: 100,
					controlTrafficPercent: 100
				}
			},
			migrationDependencies
		);

		await expect(
			d1
				.select({
					tenant: d1Schema.tenantDataMigration.tenant,
					status: d1Schema.tenantDataMigration.status,
					implementationRevision:
						d1Schema.tenantDataMigration.implementationRevision
				})
				.from(d1Schema.tenantDataMigration)
				.where(
					eq(
						d1Schema.tenantDataMigration.artifactId,
						successorIdentity.artifactId
					)
				)
				.orderBy(d1Schema.tenantDataMigration.tenant)
				.all()
		).resolves.toStrictEqual([
			{
				tenant: completeTenant,
				status: 'complete',
				implementationRevision
			},
			{
				tenant: inapplicableTenant,
				status: 'pending',
				implementationRevision
			}
		]);
	});
});

describe('deploymentAdvance', () => {
	it('refuses D1 verification until every contracted migration checksum matches', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'd1-contracted');
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('d1-contracted'),
			targetState: deploymentStateIdSchema.parse('d1-verified'),
			expectedRevision: deploymentRevisionSchema.parse(0)
		};

		await expect(
			deploymentAdvance(d1, input, deploymentServiceDependencies(env))
		).rejects.toBeInstanceOf(DeploymentStateConflictError);
		const execution = await d1
			.select({ attemptId: d1Schema.deploymentTransitionExecution.attemptId })
			.from(d1Schema.deploymentTransitionExecution)
			.get();

		if (execution === undefined) {
			throw new Error('The D1 verification transition was not claimed');
		}

		const contraction = deploymentManifest.forwardTransitions.find(
			(transition) =>
				transition.kind === 'apply-d1' && transition.to === 'd1-contracted'
		);

		if (contraction?.kind !== 'apply-d1') {
			throw new Error('The deployment manifest has no D1 contraction');
		}

		for (const migrationId of contraction.migrations) {
			const migration = deploymentManifest.d1Migrations.find(
				(candidate) => candidate.id === migrationId
			);

			if (migration === undefined) {
				throw new Error(`The deployment manifest has no ${migrationId}`);
			}

			await d1.insert(d1Schema.structuralMigrationChecksum).values({
				kind: 'd1',
				migrationId,
				sha256: migration.sha256,
				appliedAt: now
			});
		}

		await expect(
			deploymentAdvance(
				d1,
				{
					...input,
					attemptId: deploymentAttemptIdSchema.parse(execution.attemptId)
				},
				deploymentServiceDependencies(env)
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('d1-verified'),
			revision: deploymentRevisionSchema.parse(1)
		});
	});

	it('persists a retention fence before advancing its manifest state', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'data-runtime');

		await expect(
			deploymentAdvance(
				d1,
				{
					deployment: identity,
					expectedState: deploymentStateIdSchema.parse('data-runtime'),
					targetState: deploymentStateIdSchema.parse('retention-fenced'),
					expectedRevision: deploymentRevisionSchema.parse(0)
				},
				deploymentServiceDependencies(env)
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('retention-fenced'),
			revision: deploymentRevisionSchema.parse(1)
		});

		await expect(
			d1
				.select({
					state: d1Schema.deploymentRuntimeControl.retentionAdministration,
					revision: d1Schema.deploymentRuntimeControl.retentionRevision
				})
				.from(d1Schema.deploymentRuntimeControl)
				.get()
		).resolves.toStrictEqual({ state: 'closed', revision: 1 });
	});

	it('waits for an admitted retention mutation before closing the fence', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'data-runtime');
		await d1.insert(d1Schema.d1AppMutationAdmission).values({
			id: 'retention-update',
			fenceRevision: 0,
			expiresAt: isoTimestampSchema.parse('2099-01-01T00:00:00.000Z'),
			createdAt: now
		});
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('data-runtime'),
			targetState: deploymentStateIdSchema.parse('retention-fenced'),
			expectedRevision: deploymentRevisionSchema.parse(0)
		};
		const waiting = await deploymentAdvance(
			d1,
			input,
			deploymentServiceDependencies(env)
		);

		if (waiting.outcome !== 'running') {
			throw new Error(
				'The retention fence did not wait for the admitted mutation'
			);
		}

		await d1
			.delete(d1Schema.d1AppMutationAdmission)
			.where(eq(d1Schema.d1AppMutationAdmission.id, 'retention-update'));
		await expect(
			deploymentAdvance(
				d1,
				{ ...input, attemptId: waiting.attemptId },
				deploymentServiceDependencies(env)
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('retention-fenced'),
			revision: deploymentRevisionSchema.parse(1)
		});
	});

	it('atomically advances the D1 application mutation fence revision', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'retention-open');

		await deploymentAdvance(
			d1,
			{
				deployment: identity,
				expectedState: deploymentStateIdSchema.parse('retention-open'),
				targetState: deploymentStateIdSchema.parse('d1-fenced'),
				expectedRevision: deploymentRevisionSchema.parse(0)
			},
			deploymentServiceDependencies(env)
		);

		const fence = await d1.select().from(d1Schema.d1AppMutationFence).get();

		expect(fence).toBeDefined();
		expect({
			id: fence?.id,
			state: fence?.state,
			revision: fence?.revision
		}).toStrictEqual({
			id: 'application',
			state: 'closed',
			revision: 1
		});
		expect(isoTimestampSchema.safeParse(fence?.updatedAt).success).toBe(true);
	});

	it('waits for an earlier application mutation admission to drain', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'retention-open');
		await d1.insert(d1Schema.d1AppMutationAdmission).values({
			id: 'active-request',
			fenceRevision: 0,
			expiresAt: isoTimestampSchema.parse('2099-01-01T00:00:00.000Z'),
			createdAt: now
		});
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('retention-open'),
			targetState: deploymentStateIdSchema.parse('d1-fenced'),
			expectedRevision: deploymentRevisionSchema.parse(0)
		};
		const waiting = await deploymentAdvance(
			d1,
			input,
			deploymentServiceDependencies(env)
		);

		if (waiting.outcome !== 'running') {
			throw new Error('The D1 fence did not wait for the admitted mutation');
		}

		await d1
			.delete(d1Schema.d1AppMutationAdmission)
			.where(eq(d1Schema.d1AppMutationAdmission.id, 'active-request'));
		await expect(
			deploymentAdvance(
				d1,
				{ ...input, attemptId: waiting.attemptId },
				deploymentServiceDependencies(env)
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('d1-fenced'),
			revision: deploymentRevisionSchema.parse(1)
		});
	});

	it('admits ordinary mutations only while the D1 fence is open', async () => {
		const d1 = database();
		const observed = await withAppMutationAdmission(env.CUPBOARD_DB, async () =>
			d1
				.select({ id: d1Schema.d1AppMutationAdmission.id })
				.from(d1Schema.d1AppMutationAdmission)
				.all()
		);
		const afterRelease = await d1
			.select({ id: d1Schema.d1AppMutationAdmission.id })
			.from(d1Schema.d1AppMutationAdmission)
			.all();

		expect({
			observed: observed.map(({ id }) => z.uuid().safeParse(id).success),
			afterRelease
		}).toStrictEqual({ observed: [true], afterRelease: [] });
		await d1
			.update(d1Schema.d1AppMutationFence)
			.set({ state: 'closed', revision: 1, updatedAt: now });
		await expect(
			withAppMutationAdmission(env.CUPBOARD_DB, () => Promise.resolve())
		).rejects.toBeInstanceOf(AppWritesFencedError);
	});

	it('refuses contraction while a cross-store repair intent is unresolved', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'd1-fenced');
		await d1.insert(d1Schema.projectionRepairIntent).values({
			id: 'repair-1',
			tenant: tenantIdSchema.parse('acme'),
			writerEpoch: 'legacy-cache-identity',
			fenceRevision: 1,
			status: 'pending',
			operation: 'cache-lifecycle-projection',
			payloadJson: '{}',
			createdAt: now,
			updatedAt: now
		});

		const result = await deploymentAdvance(
			d1,
			{
				deployment: identity,
				expectedState: deploymentStateIdSchema.parse('d1-fenced'),
				targetState: deploymentStateIdSchema.parse('repairs-resolved'),
				expectedRevision: deploymentRevisionSchema.parse(0)
			},
			deploymentServiceDependencies(env)
		);

		if (result.outcome !== 'failed') {
			throw new Error('The unresolved repair transition did not fail');
		}

		expect({ outcome: result.outcome, failure: result.failure }).toStrictEqual({
			outcome: 'failed',
			failure: {
				code: 'projection-repair-unresolved',
				detail:
					'Repair intent repair-1 has unsupported operation cache-lifecycle-projection'
			}
		});
		expect(deploymentAttemptIdSchema.safeParse(result.attemptId).success).toBe(
			true
		);

		await expect(deploymentStatus(d1, identity)).resolves.toMatchObject({
			state: 'current',
			deploymentState: 'd1-fenced',
			revision: 0
		});
	});

	it('closes legacy R2 writes and fallback in one durable transition', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'd1-verified');

		await deploymentAdvance(
			d1,
			{
				deployment: identity,
				expectedState: deploymentStateIdSchema.parse('d1-verified'),
				targetState: deploymentStateIdSchema.parse('r2-window-closed'),
				expectedRevision: deploymentRevisionSchema.parse(0)
			},
			deploymentServiceDependencies(env)
		);

		await expect(
			d1
				.select({
					writes: d1Schema.deploymentRuntimeControl.legacyR2Writes,
					fallback: d1Schema.deploymentRuntimeControl.legacyR2ReadFallback,
					deletion: d1Schema.deploymentRuntimeControl.legacyR2Deletion
				})
				.from(d1Schema.deploymentRuntimeControl)
				.get()
		).resolves.toStrictEqual({
			writes: 'disabled',
			fallback: 'disabled',
			deletion: 'eligible'
		});
	});

	it('records an externally captured D1 recovery envelope before contraction', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'repairs-resolved');
		const dependencies = currentDeploymentDependencies();
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('repairs-resolved'),
			targetState: deploymentStateIdSchema.parse('d1-recovery-recorded'),
			expectedRevision: deploymentRevisionSchema.parse(0)
		};
		const claimed = await deploymentAdvance(d1, input, dependencies);

		if (claimed.outcome !== 'external-action-required') {
			throw new Error(
				'The recovery transition did not request external capture'
			);
		}

		expect(claimed.action).toStrictEqual({
			kind: 'capture-d1-recovery-point'
		});

		await expect(
			deploymentAdvance(
				d1,
				{
					...input,
					attemptId: claimed.attemptId,
					externalObservation: {
						kind: 'd1-recovery-point',
						databaseId: 'd1-database',
						bookmark: 'bookmark-1'
					}
				},
				dependencies
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('d1-recovery-recorded'),
			revision: deploymentRevisionSchema.parse(1)
		});

		const recoveryPoint = await d1
			.select({
				attemptId: d1Schema.deploymentD1RecoveryPoint.attemptId,
				databaseId: d1Schema.deploymentD1RecoveryPoint.databaseId,
				bookmark: d1Schema.deploymentD1RecoveryPoint.bookmark,
				envelopeKey: d1Schema.deploymentD1RecoveryPoint.envelopeKey,
				envelopeSha256: d1Schema.deploymentD1RecoveryPoint.envelopeSha256,
				capturedAt: d1Schema.deploymentD1RecoveryPoint.capturedAt
			})
			.from(d1Schema.deploymentD1RecoveryPoint)
			.get();

		if (recoveryPoint === undefined) {
			throw new Error('The D1 recovery point was not recorded');
		}

		const recoveryObject = await env.DEPLOYMENT_RECOVERY.get(
			recoveryPoint.envelopeKey
		);

		if (recoveryObject === null) {
			throw new Error('The D1 recovery envelope was not written');
		}

		const recoveryBody = await recoveryObject.text();
		const parsedRecoveryBody: unknown = JSON.parse(recoveryBody);
		const recoveryPayload = {
			databaseId: 'd1-database',
			deployment: identity,
			transitionId: 'repairs-resolved-to-d1-recovery-recorded',
			attemptId: claimed.attemptId,
			expectedDeploymentRevision: 0,
			closedApplicationFenceRevision: 0,
			preContractSchemaFingerprint: 'compatible-0026',
			phase: 'recorded',
			preContractBookmark: 'bookmark-1',
			updatedAt: recoveryPoint.capturedAt
		};
		const checksum = await sha256Hex(canonicalJson(recoveryPayload));

		expect(recoveryPoint).toStrictEqual({
			attemptId: claimed.attemptId,
			databaseId: 'd1-database',
			bookmark: 'bookmark-1',
			envelopeKey: [
				'd1',
				'd1-database',
				identity.artifactId,
				identity.instanceId,
				'repairs-resolved-to-d1-recovery-recorded',
				`${claimed.attemptId}.json`
			].join('/'),
			envelopeSha256: await sha256Hex(recoveryBody),
			capturedAt: recoveryPoint.capturedAt
		});
		expect(d1RecoveryEnvelopeSchema.parse(parsedRecoveryBody)).toStrictEqual({
			...recoveryPayload,
			checksum
		});
	});

	it('verifies manifest D1 checksums before completing an SQL transition', async () => {
		const d1 = database();
		await setDeploymentHead(d1, 'catalogue-native');
		const dependencies = deploymentServiceDependencies(env);
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('catalogue-native'),
			targetState: deploymentStateIdSchema.parse('compatible-d1'),
			expectedRevision: deploymentRevisionSchema.parse(0)
		};
		const claimed = await deploymentAdvance(d1, input, dependencies);

		if (
			claimed.outcome !== 'external-action-required' ||
			claimed.action.kind !== 'apply-d1'
		) {
			throw new Error(
				'The D1 transition did not request its declared migrations'
			);
		}

		const checksumById = new Map<string, string>();

		for (const migration of dependencies.registry.d1Migrations) {
			checksumById.set(migration.id, migration.sha256);
		}

		const observations = claimed.action.migrations.map((id) => {
			const sha256 = checksumById.get(id);

			if (sha256 === undefined) {
				throw new Error(`No checksum exists for ${id}`);
			}

			return { id, sha256 };
		});

		for (const migration of observations) {
			await d1
				.insert(d1Schema.structuralMigrationChecksum)
				.values({
					kind: 'd1',
					migrationId: migration.id,
					sha256: migration.sha256,
					appliedAt: now
				})
				.onConflictDoUpdate({
					target: [
						d1Schema.structuralMigrationChecksum.kind,
						d1Schema.structuralMigrationChecksum.migrationId
					],
					set: { sha256: migration.sha256, appliedAt: now }
				});
		}

		await expect(
			deploymentAdvance(
				d1,
				{
					...input,
					attemptId: claimed.attemptId,
					externalObservation: {
						kind: 'd1-migrations',
						migrations: observations
					}
				},
				dependencies
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('compatible-d1'),
			revision: deploymentRevisionSchema.parse(1)
		});
	});

	it('cannot select work absent from the embedded manifest', async () => {
		const d1 = database();
		await d1.insert(d1Schema.deploymentHead).values({
			id: 'current',
			manifestId: 'c'.repeat(64),
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			stateId: state,
			revision: 4,
			status: 'active',
			updatedAt: now
		});

		await expect(
			deploymentAdvance(d1, {
				deployment: identity,
				expectedState: state,
				targetState: deploymentStateIdSchema.parse('caller-selected'),
				expectedRevision: deploymentRevisionSchema.parse(4)
			})
		).rejects.toBeInstanceOf(DeploymentStateConflictError);
	});

	it('claims a transition before returning an external action', async () => {
		const d1 = database();
		await d1.insert(d1Schema.deploymentHead).values({
			id: 'current',
			manifestId: 'c'.repeat(64),
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			stateId: state,
			revision: 4,
			status: 'active',
			updatedAt: now
		});

		await expect(
			deploymentAdvance(
				d1,
				{
					deployment: identity,
					expectedState: state,
					targetState: nextState,
					expectedRevision: deploymentRevisionSchema.parse(4)
				},
				externalDependencies
			)
		).resolves.toStrictEqual({
			outcome: 'external-action-required',
			attemptId,
			action: {
				kind: 'deploy-runtime-stage',
				stage: 'cache-data-migrations',
				tenantFirst: true
			}
		});

		await expect(
			d1.select().from(d1Schema.deploymentTransitionExecution).get()
		).resolves.toMatchObject({
			attemptId,
			status: 'running',
			externalAction: 'issued'
		});
	});

	it('completes a claimed external action after observing both Workers', async () => {
		const d1 = database();
		await d1.insert(d1Schema.deploymentHead).values({
			id: 'current',
			manifestId: 'c'.repeat(64),
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			stateId: state,
			revision: 4,
			status: 'active',
			updatedAt: now
		});

		const input = {
			deployment: identity,
			expectedState: state,
			targetState: nextState,
			expectedRevision: deploymentRevisionSchema.parse(4)
		};
		await deploymentAdvance(d1, input, externalDependencies);

		await expect(
			deploymentAdvance(
				d1,
				{
					...input,
					attemptId,
					externalObservation: {
						kind: 'runtime-stage',
						stage: 'cache-data-migrations',
						tenantVersionId: 'tenant-version',
						controlVersionId: 'control-version',
						tenantTrafficPercent: 100,
						controlTrafficPercent: 100
					}
				},
				externalDependencies
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: nextState,
			revision: deploymentRevisionSchema.parse(5)
		});

		await expect(
			deploymentAdvance(d1, { ...input, attemptId }, externalDependencies)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: nextState,
			revision: deploymentRevisionSchema.parse(5)
		});
	});

	it('completes a declarative verification without external work', async () => {
		const d1 = database();
		await d1.insert(d1Schema.deploymentHead).values({
			id: 'current',
			manifestId: 'c'.repeat(64),
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			stateId: state,
			revision: 4,
			status: 'active',
			updatedAt: now
		});

		await expect(
			deploymentAdvance(
				d1,
				{
					deployment: identity,
					expectedState: state,
					targetState: nextState,
					expectedRevision: deploymentRevisionSchema.parse(4)
				},
				verifyDependencies
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state: nextState,
			revision: deploymentRevisionSchema.parse(5)
		});
	});
});

describe('deploymentRecover', () => {
	it('records a D1 restore request before accepting its observation', async () => {
		const d1 = database();
		const point = await recordD1RecoveryPoint(d1);
		await recordManifestD1Checksums(d1);
		const dependencies = deploymentServiceDependencies(env);
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('d1-recovery-recorded'),
			targetRecoveryState: deploymentStateIdSchema.parse('repairs-resolved'),
			expectedRevision: deploymentRevisionSchema.parse(1)
		};
		const claimed = await deploymentRecover(d1, input, dependencies);

		if (claimed.outcome !== 'external-action-required') {
			throw new Error('The D1 restore transition was not claimed');
		}

		expect(claimed.action).toStrictEqual({
			kind: 'restore-d1',
			databaseId: 'd1-database',
			preContractBookmark: 'bookmark-1',
			recoveryEnvelopeKey: point.envelopeKey
		});

		const requestedObject = await env.DEPLOYMENT_RECOVERY.get(
			point.envelopeKey
		);

		if (requestedObject === null) {
			throw new Error('The D1 recovery envelope is missing');
		}

		const requestedValue: unknown = JSON.parse(await requestedObject.text());
		const requested = d1RecoveryEnvelopeSchema.parse(requestedValue);
		const requestedPayload = {
			databaseId: 'd1-database',
			deployment: identity,
			transitionId: 'repairs-resolved-to-d1-recovery-recorded',
			attemptId,
			expectedDeploymentRevision: 0,
			closedApplicationFenceRevision: 0,
			preContractSchemaFingerprint: 'compatible-0026',
			phase: 'restore-requested',
			preContractBookmark: 'bookmark-1',
			updatedAt: requested.updatedAt
		};
		expect(requested).toStrictEqual({
			...requestedPayload,
			checksum: await sha256Hex(canonicalJson(requestedPayload))
		});

		const completed = await deploymentRecover(
			d1,
			{
				...input,
				attemptId: claimed.attemptId,
				externalObservation: {
					kind: 'd1-restoration',
					databaseId: 'd1-database',
					preContractBookmark: 'bookmark-1',
					undoBookmark: 'undo-bookmark-1',
					recoveryEnvelopeKey: point.envelopeKey
				}
			},
			dependencies
		);

		expect(completed).toStrictEqual({
			outcome: 'completed',
			state: deploymentStateIdSchema.parse('repairs-resolved'),
			revision: deploymentRevisionSchema.parse(2)
		});
		await expect(
			deploymentRecover(d1, input, dependencies)
		).resolves.toStrictEqual(completed);

		const completedObject = await env.DEPLOYMENT_RECOVERY.get(
			point.envelopeKey
		);

		if (completedObject === null) {
			throw new Error('The completed D1 recovery envelope is missing');
		}

		const completedValue: unknown = JSON.parse(await completedObject.text());
		const completedEnvelope = d1RecoveryEnvelopeSchema.parse(completedValue);
		const completedPayload = {
			...requestedPayload,
			phase: 'complete',
			restoreUndoBookmark: 'undo-bookmark-1',
			updatedAt: completedEnvelope.updatedAt
		};
		expect(completedEnvelope).toStrictEqual({
			...completedPayload,
			checksum: await sha256Hex(canonicalJson(completedPayload))
		});
	});

	it('refuses a D1 restore observation before recording the request', async () => {
		const d1 = database();
		const point = await recordD1RecoveryPoint(d1);
		await recordManifestD1Checksums(d1);

		await expect(
			deploymentRecover(
				d1,
				{
					deployment: identity,
					expectedState: deploymentStateIdSchema.parse('d1-recovery-recorded'),
					targetRecoveryState:
						deploymentStateIdSchema.parse('repairs-resolved'),
					expectedRevision: deploymentRevisionSchema.parse(1),
					externalObservation: {
						kind: 'd1-restoration',
						databaseId: 'd1-database',
						preContractBookmark: 'bookmark-1',
						undoBookmark: 'undo-bookmark-1',
						recoveryEnvelopeKey: point.envelopeKey
					}
				},
				currentDeploymentDependencies()
			)
		).rejects.toBeInstanceOf(DeploymentStateConflictError);
	});

	it('records the restore undo bookmark before verifying the restored schema', async () => {
		const d1 = database();
		const point = await recordD1RecoveryPoint(d1);
		const dependencies = currentDeploymentDependencies();
		const input = {
			deployment: identity,
			expectedState: deploymentStateIdSchema.parse('d1-recovery-recorded'),
			targetRecoveryState: deploymentStateIdSchema.parse('repairs-resolved'),
			expectedRevision: deploymentRevisionSchema.parse(1)
		};
		const claimed = await deploymentRecover(d1, input, dependencies);

		if (claimed.outcome !== 'external-action-required') {
			throw new Error('The D1 restore transition was not claimed');
		}

		await expect(
			deploymentRecover(
				d1,
				{
					...input,
					attemptId: claimed.attemptId,
					externalObservation: {
						kind: 'd1-restoration',
						databaseId: 'd1-database',
						preContractBookmark: 'bookmark-1',
						undoBookmark: 'undo-bookmark-before-verification',
						recoveryEnvelopeKey: point.envelopeKey
					}
				},
				dependencies
			)
		).rejects.toBeInstanceOf(DeploymentStateConflictError);

		const recoveryObject = await env.DEPLOYMENT_RECOVERY.get(point.envelopeKey);

		if (recoveryObject === null) {
			throw new Error('The D1 recovery envelope is missing');
		}

		const value: unknown = JSON.parse(await recoveryObject.text());
		const envelope = d1RecoveryEnvelopeSchema.parse(value);
		const payload = {
			databaseId: 'd1-database',
			deployment: identity,
			transitionId: 'repairs-resolved-to-d1-recovery-recorded',
			attemptId,
			expectedDeploymentRevision: 0,
			closedApplicationFenceRevision: 0,
			preContractSchemaFingerprint: 'compatible-0026',
			phase: 'restored-awaiting-verification',
			preContractBookmark: 'bookmark-1',
			restoreUndoBookmark: 'undo-bookmark-before-verification',
			updatedAt: envelope.updatedAt
		};

		expect(envelope).toStrictEqual({
			...payload,
			checksum: await sha256Hex(canonicalJson(payload))
		});
	});

	it('runs only the recovery edge declared for the persisted state', async () => {
		const d1 = database();
		await setDeploymentHead(d1, nextState, 4);

		await expect(
			deploymentRecover(
				d1,
				{
					deployment: identity,
					expectedState: nextState,
					targetRecoveryState: state,
					expectedRevision: deploymentRevisionSchema.parse(4)
				},
				repairDependencies
			)
		).resolves.toStrictEqual({
			outcome: 'completed',
			state,
			revision: deploymentRevisionSchema.parse(5)
		});

		await expect(
			d1.select().from(d1Schema.deploymentTransitionExecution).get()
		).resolves.toMatchObject({
			transitionId: 'repair-data-runtime',
			fromStateId: nextState,
			toStateId: state,
			status: 'completed',
			attemptId
		});
	});

	it('refuses a recovery target absent from the manifest', async () => {
		const d1 = database();
		await setDeploymentHead(d1, nextState, 4);

		await expect(
			deploymentRecover(
				d1,
				{
					deployment: identity,
					expectedState: nextState,
					targetRecoveryState: deploymentStateIdSchema.parse('undeclared'),
					expectedRevision: deploymentRevisionSchema.parse(4)
				},
				repairDependencies
			)
		).rejects.toBeInstanceOf(DeploymentStateConflictError);
	});
});
