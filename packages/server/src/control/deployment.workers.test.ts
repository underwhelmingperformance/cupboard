import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { cacheDataMigrationsStage } from '@cupboard/protocol/cache-deployment-manifest';
import {
	deploymentArtifactIdSchema,
	deploymentAttemptIdSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema,
	deploymentRevisionSchema,
	deploymentStateIdSchema,
	deploymentTransitionIdSchema
} from '@cupboard/protocol/deployment';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { DeploymentStateConflictError } from '../errors.ts';

import {
	deploymentAdvance,
	type DeploymentServiceDependencies,
	deploymentServiceDependencies,
	deploymentStatus
} from './deployment.ts';

const identity: DeploymentIdentity = {
	artifactId: deploymentArtifactIdSchema.parse('a'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
};
const state = deploymentStateIdSchema.parse('foundation');
const nextState = deploymentStateIdSchema.parse('data-migrations');
const now = isoTimestampSchema.parse('2026-09-01T00:00:00.000Z');
const attemptId = deploymentAttemptIdSchema.parse(
	'0199a0ea-1a00-7000-8000-000000000001'
);
const d1RecoveryEnvelopeSchema = z.strictObject({
	artifactId: z.string(),
	instanceId: z.string(),
	transitionId: z.string(),
	attemptId: z.string(),
	databaseId: z.string(),
	bookmark: z.string(),
	capturedAt: isoTimestampSchema
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
		d1Migrations: [],
		operations: {},
		checks: {}
	}
};

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

beforeEach(async () => {
	const d1 = database();
	await d1.delete(d1Schema.deploymentTransitionExecution);
	await d1.delete(d1Schema.deploymentHead);
	await d1.delete(d1Schema.deploymentWriterDrainTenant);
	await d1.delete(d1Schema.deploymentWriterCutover);
	await d1.delete(d1Schema.projectionRepairIntent);
	await d1.delete(d1Schema.deploymentD1RecoveryPoint);
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

describe('deploymentAdvance', () => {
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
				detail: 'Repair intent repair-1 is pending'
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
		const dependencies = deploymentServiceDependencies(env);
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

		expect(recoveryPoint).toStrictEqual({
			attemptId: claimed.attemptId,
			databaseId: 'd1-database',
			bookmark: 'bookmark-1',
			envelopeKey: [
				'deployment-recovery',
				identity.instanceId,
				identity.artifactId,
				'repairs-resolved-to-d1-recovery-recorded',
				`${claimed.attemptId}.json`
			].join('/'),
			envelopeSha256: await sha256Hex(recoveryBody),
			capturedAt: recoveryPoint.capturedAt
		});
		expect(d1RecoveryEnvelopeSchema.parse(parsedRecoveryBody)).toStrictEqual({
			artifactId: identity.artifactId,
			instanceId: identity.instanceId,
			transitionId: 'repairs-resolved-to-d1-recovery-recorded',
			attemptId: claimed.attemptId,
			databaseId: 'd1-database',
			bookmark: 'bookmark-1',
			capturedAt: recoveryPoint.capturedAt
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
