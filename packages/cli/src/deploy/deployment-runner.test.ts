import {
	type DeploymentAdvanceInput,
	type DeploymentAdvanceResult,
	deploymentArtifactIdSchema,
	deploymentAttemptIdSchema,
	type DeploymentIdentity,
	deploymentInstanceIdSchema,
	deploymentRevisionSchema,
	deploymentStateIdSchema,
	type DeploymentStatus,
	deploymentTransitionIdSchema
} from '@cupboard/protocol/deployment';
import type {
	DeploymentManifestBody,
	ForwardDeploymentTransition
} from '@cupboard/protocol/deployment-manifest';
import {
	d1MigrationIdSchema,
	d1SchemaStateIdSchema
} from '@cupboard/protocol/deployment-manifest';
import { describe, expect, it, vi } from 'vitest';

import { testDeploymentManifest } from './deployment-manifest.test-support.ts';
import {
	advanceDeployment,
	cloudflareDeploymentExecutor,
	DeploymentManifestResponseError,
	type DeploymentRunnerClient,
	type ExecuteDeploymentExternalAction
} from './deployment-runner.ts';
import { databaseIdSchema } from './identifiers.ts';

const identity: DeploymentIdentity = {
	artifactId: deploymentArtifactIdSchema.parse('a'.repeat(64)),
	instanceId: deploymentInstanceIdSchema.parse('b'.repeat(64))
};
const source = deploymentStateIdSchema.parse('source');
const target = deploymentStateIdSchema.parse('target');
const attemptId = deploymentAttemptIdSchema.parse(
	'0199a0ea-1a00-7000-8000-000000000001'
);
const transition: ForwardDeploymentTransition = {
	id: deploymentTransitionIdSchema.parse('apply-expanded-schema'),
	from: source,
	to: target,
	kind: 'apply-d1',
	migrations: [d1MigrationIdSchema.parse('0020_expand.sql')],
	checks: []
};
const [installedState] = testDeploymentManifest.states;

if (installedState === undefined) {
	throw new Error('The test deployment manifest has no installed state');
}

const manifest: DeploymentManifestBody = {
	...testDeploymentManifest,
	initialState: source,
	terminalState: target,
	states: [
		{ ...installedState, id: source },
		{
			...installedState,
			id: target,
			d1Schema: d1SchemaStateIdSchema.parse('expanded')
		}
	],
	forwardTransitions: [transition],
	d1Migrations: [
		{ id: d1MigrationIdSchema.parse('0020_expand.sql'), sha256: 'c'.repeat(64) }
	]
};

function currentStatus(
	overrides: Partial<Extract<DeploymentStatus, { state: 'current' }>> = {}
): Extract<DeploymentStatus, { state: 'current' }> {
	return {
		state: 'current',
		deployment: identity,
		deploymentState: source,
		revision: deploymentRevisionSchema.parse(2),
		status: 'active',
		nextState: target,
		...overrides
	};
}

function scriptedClient(
	status: DeploymentStatus,
	results: readonly DeploymentAdvanceResult[]
): {
	readonly client: DeploymentRunnerClient;
	readonly inputs: DeploymentAdvanceInput[];
} {
	const inputs: DeploymentAdvanceInput[] = [];
	let index = 0;

	return {
		inputs,
		client: {
			status: () => Promise.resolve(status),
			advance: (input) => {
				inputs.push(input);
				const result = results[index];
				index += 1;

				if (result === undefined) {
					throw new Error('No scripted deployment result');
				}

				return Promise.resolve(result);
			}
		}
	};
}

describe('advanceDeployment', () => {
	it('claims a manifest transition before performing its external action', async () => {
		const { client, inputs } = scriptedClient(currentStatus(), [
			{
				outcome: 'external-action-required',
				attemptId,
				action: { kind: 'apply-d1', migrations: ['0020_expand.sql'] }
			},
			{
				outcome: 'completed',
				state: target,
				revision: deploymentRevisionSchema.parse(3)
			}
		]);
		const order: string[] = [];
		const execute = vi.fn<ExecuteDeploymentExternalAction>(() => {
			order.push('external');

			return Promise.resolve({
				kind: 'd1-migrations',
				migrations: [{ id: '0020_expand.sql', sha256: 'c'.repeat(64) }]
			});
		});
		const recordingClient: DeploymentRunnerClient = {
			status: (input) => client.status(input),
			advance: (input) => {
				order.push('advance');

				return client.advance(input);
			}
		};

		await expect(
			advanceDeployment({
				client: recordingClient,
				deployment: identity,
				manifest,
				executeExternalAction: execute
			})
		).resolves.toStrictEqual({
			state: 'completed',
			deploymentState: target,
			revision: deploymentRevisionSchema.parse(3)
		});
		expect(order).toStrictEqual(['advance', 'external', 'advance']);
		expect(inputs).toStrictEqual([
			{
				deployment: identity,
				expectedState: source,
				targetState: target,
				expectedRevision: deploymentRevisionSchema.parse(2)
			},
			{
				deployment: identity,
				expectedState: source,
				targetState: target,
				expectedRevision: deploymentRevisionSchema.parse(2),
				attemptId,
				externalObservation: {
					kind: 'd1-migrations',
					migrations: [{ id: '0020_expand.sql', sha256: 'c'.repeat(64) }]
				}
			}
		]);
	});

	it('refuses an external action which differs from the manifest', async () => {
		const { client } = scriptedClient(currentStatus(), [
			{
				outcome: 'external-action-required',
				attemptId,
				action: { kind: 'apply-d1', migrations: ['0099_other.sql'] }
			}
		]);
		const execute = vi.fn();

		await expect(
			advanceDeployment({
				client,
				deployment: identity,
				manifest,
				executeExternalAction: execute
			})
		).rejects.toBeInstanceOf(DeploymentManifestResponseError);
		expect(execute).not.toHaveBeenCalled();
	});

	it('resumes an existing transition claim', async () => {
		const runningStatus = currentStatus({
			execution: {
				transitionId: transition.id,
				fromState: source,
				toState: target,
				status: 'running',
				attemptId,
				externalAction: 'not-required'
			}
		});
		const { client, inputs } = scriptedClient(runningStatus, [
			{ outcome: 'running', attemptId }
		]);

		await expect(
			advanceDeployment({
				client,
				deployment: identity,
				manifest,
				executeExternalAction: vi.fn()
			})
		).resolves.toStrictEqual({
			state: 'running',
			deploymentState: source,
			revision: deploymentRevisionSchema.parse(2),
			attemptId
		});
		expect(inputs).toStrictEqual([
			{
				deployment: identity,
				expectedState: source,
				targetState: target,
				expectedRevision: deploymentRevisionSchema.parse(2),
				attemptId
			}
		]);
	});

	it('does not call the control plane after reaching the terminal state', async () => {
		const terminalStatus = currentStatus({
			deploymentState: target,
			revision: deploymentRevisionSchema.parse(3),
			nextState: undefined
		});
		const { client, inputs } = scriptedClient(terminalStatus, []);

		await expect(
			advanceDeployment({
				client,
				deployment: identity,
				manifest,
				executeExternalAction: vi.fn()
			})
		).resolves.toStrictEqual({
			state: 'completed',
			deploymentState: target,
			revision: deploymentRevisionSchema.parse(3)
		});
		expect(inputs).toStrictEqual([]);
	});
});

describe('cloudflareDeploymentExecutor', () => {
	it('applies only the declared D1 migrations and reports their digests', async () => {
		const mutableBatches: string[][] = [];
		const executor = cloudflareDeploymentExecutor({
			api: {
				d1QueryBatch: (_databaseId, statements) => {
					mutableBatches.push([...statements]);

					return Promise.resolve();
				},
				d1QueryRows: () => Promise.resolve([]),
				getD1Bookmark: () => Promise.resolve('bookmark-1'),
				restoreD1Database: () =>
					Promise.resolve({ bookmark: 'restored', undoBookmark: 'undo' })
			},
			databaseId: databaseIdSchema.parse('database-1'),
			d1Migrations: [
				{
					name: '0020_expand.sql',
					sha256: 'c'.repeat(64),
					statements: ['CREATE TABLE expanded (id TEXT);']
				}
			],
			deployRuntimeStage: () => {
				throw new Error('The D1 action tried to deploy a runtime');
			}
		});

		await expect(
			executor({ kind: 'apply-d1', migrations: ['0020_expand.sql'] }, attemptId)
		).resolves.toStrictEqual({
			kind: 'd1-migrations',
			migrations: [{ id: '0020_expand.sql', sha256: 'c'.repeat(64) }]
		});
		expect(mutableBatches).toStrictEqual([
			[
				'CREATE TABLE expanded (id TEXT);',
				"INSERT INTO d1_migrations (name) VALUES ('0020_expand.sql');",
				`INSERT INTO structural_migration_checksum (kind, migration_id, sha256, applied_at) VALUES ('d1', '0020_expand.sql', '${'c'.repeat(64)}', CURRENT_TIMESTAMP);`
			]
		]);
	});

	it('captures the current D1 bookmark without accepting an envelope from the caller', async () => {
		const executor = cloudflareDeploymentExecutor({
			api: {
				d1QueryBatch: () => Promise.resolve(),
				d1QueryRows: () => Promise.resolve([]),
				getD1Bookmark: () => Promise.resolve('bookmark-1'),
				restoreD1Database: () =>
					Promise.resolve({ bookmark: 'restored', undoBookmark: 'undo' })
			},
			databaseId: databaseIdSchema.parse('database-1'),
			d1Migrations: [],
			deployRuntimeStage: () => {
				throw new Error('The recovery action tried to deploy a runtime');
			}
		});

		await expect(
			executor({ kind: 'capture-d1-recovery-point' }, attemptId)
		).resolves.toStrictEqual({
			kind: 'd1-recovery-point',
			databaseId: 'database-1',
			bookmark: 'bookmark-1'
		});
	});
});
