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

import * as d1Schema from '../db/d1-schema.ts';
import { DeploymentStateConflictError } from '../errors.ts';

import {
	deploymentAdvance,
	type DeploymentServiceDependencies,
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

const verifyDependencies: DeploymentServiceDependencies = {
	registry: {
		transitions: [
			{
				id: deploymentTransitionIdSchema.parse('verify-foundation'),
				from: state,
				to: nextState,
				operation: { kind: 'verify' }
			}
		],
		operations: {}
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
				operation: {
					kind: 'deploy-runtime-stage',
					stage: 'cache-data-migrations'
				}
			}
		],
		operations: {}
	}
};

function database() {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

beforeEach(async () => {
	const d1 = database();
	await d1.delete(d1Schema.deploymentTransitionExecution);
	await d1.delete(d1Schema.deploymentHead);
});

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
