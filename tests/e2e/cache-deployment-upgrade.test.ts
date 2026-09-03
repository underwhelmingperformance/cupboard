import { cacheLocalContractMigration } from '@cupboard/protocol/cache-deployment-manifest';
import type {
	DeploymentAdvanceInput,
	DeploymentAdvanceResult
} from '@cupboard/protocol/deployment';
import type {
	DeploymentManifestBody,
	ForwardDeploymentTransition
} from '@cupboard/protocol/deployment-manifest';
import { expect, it } from 'vitest';
import { z } from 'zod';

import { bootstrapLegacyDeployment } from '../../packages/cli/src/deploy/deployment-bootstrap.ts';
import {
	advanceDeployment,
	cloudflareDeploymentExecutor,
	type DeploymentRecoveryClient
} from '../../packages/cli/src/deploy/deployment-runner.ts';
import {
	predecessorD1Migration,
	predecessorDurableObjectMigration,
	sleepingFixtureTenants
} from '../fixtures/cache-deployment-predecessor/constants.ts';
import {
	stagedDeploymentDatabaseId,
	StagedDeploymentServer
} from '../support/staged-deployment-server.ts';

const migrationNameRowsSchema = z.array(z.strictObject({ name: z.string() }));
type LostResponseCategory =
	| 'd1-migration'
	| 'runtime-stage'
	| 'tenant-data-migration'
	| 'recovery-point'
	| 'local-contraction';
const scenarios: readonly {
	readonly name: string;
	readonly restartAfterCompletedTransition: boolean;
	readonly injectLostResponses: boolean;
	readonly expectedLostResponses: readonly LostResponseCategory[];
}[] = [
	{
		name: 'upgrades the populated predecessor through the complete manifest',
		restartAfterCompletedTransition: false,
		injectLostResponses: false,
		expectedLostResponses: []
	},
	{
		name: 'resumes after every completed manifest transition',
		restartAfterCompletedTransition: true,
		injectLostResponses: false,
		expectedLostResponses: []
	},
	{
		name: 'resumes after losing responses from persistent side effects',
		restartAfterCompletedTransition: false,
		injectLostResponses: true,
		expectedLostResponses: [
			'd1-migration',
			'runtime-stage',
			'tenant-data-migration',
			'recovery-point',
			'local-contraction'
		]
	}
];

class StagedDeploymentAdvanceError extends Error {
	constructor(
		public readonly visitedStates: readonly string[],
		options: ErrorOptions
	) {
		super(
			`Deployment failed after states ${visitedStates.join(', ')}`,
			options
		);
		this.name = 'StagedDeploymentAdvanceError';
	}
}

class InjectedDeploymentResponseLossError extends Error {
	constructor(
		public readonly transition: ForwardDeploymentTransition['id'],
		public readonly category: LostResponseCategory
	) {
		super(`The fixture dropped the response for transition ${transition}`);
		this.name = 'InjectedDeploymentResponseLossError';
	}
}

function byCodeUnit(left: string, right: string): number {
	if (left < right) {
		return -1;
	}

	return left > right ? 1 : 0;
}

function lostResponseCategory(
	transition: ForwardDeploymentTransition,
	input: DeploymentAdvanceInput,
	result: DeploymentAdvanceResult
): LostResponseCategory | undefined {
	if (result.outcome !== 'running' && result.outcome !== 'completed') {
		return;
	}

	if (transition.kind === 'apply-d1') {
		return input.externalObservation?.kind === 'd1-migrations'
			? 'd1-migration'
			: undefined;
	}

	if (transition.kind === 'deploy-runtime-stage') {
		return input.externalObservation?.kind === 'runtime-stage'
			? 'runtime-stage'
			: undefined;
	}

	if (transition.kind === 'record-recovery-point') {
		return 'recovery-point';
	}

	if (transition.kind !== 'run-data-migration') {
		return;
	}

	return transition.migration === cacheLocalContractMigration
		? 'local-contraction'
		: 'tenant-data-migration';
}

function injectLostResponses(
	client: DeploymentRecoveryClient,
	manifest: DeploymentManifestBody,
	injected: Set<LostResponseCategory>
): DeploymentRecoveryClient {
	return {
		...client,
		async advance(input) {
			const result = await client.advance(input);
			const transition = manifest.forwardTransitions.find(
				(candidate) => candidate.from === input.expectedState
			);

			if (transition === undefined) {
				return result;
			}

			const category = lostResponseCategory(transition, input, result);

			if (category === undefined || injected.has(category)) {
				return result;
			}

			injected.add(category);
			throw new InjectedDeploymentResponseLossError(transition.id, category);
		}
	};
}

it.each(scenarios)(
	'$name',
	async ({
		restartAfterCompletedTransition,
		injectLostResponses: shouldInjectLostResponses,
		expectedLostResponses
	}) => {
		const server = await StagedDeploymentServer.start(process.cwd());

		try {
			await server.seedPredecessor();
			await server.writeLateLegacyState('upgrade-active');

			const beforeRestart = await server.predecessorSnapshot('upgrade-active');
			const sleepingSnapshots = await Promise.all(
				sleepingFixtureTenants.map((tenant) =>
					server.predecessorSnapshot(tenant)
				)
			);
			const database = await server.database();
			const migrationRows = await database
				.prepare('SELECT name FROM d1_migrations ORDER BY id')
				.all();

			expect({
				lastD1Migration: migrationNameRowsSchema
					.parse(migrationRows.results)
					.at(-1),
				firstDurableObjectMigration: beforeRestart.migrationTags[0],
				lastDurableObjectMigration: beforeRestart.migrationTags.at(-1),
				caches: beforeRestart.caches,
				roots: beforeRestart.roots
			}).toStrictEqual({
				lastD1Migration: { name: predecessorD1Migration },
				firstDurableObjectMigration: '',
				lastDurableObjectMigration: predecessorDurableObjectMigration,
				caches: ['', 'builds', 'private/secrets'],
				roots: ['expiring', 'late-write', 'permanent']
			});
			expect(
				sleepingSnapshots.map((snapshot) => ({
					migrationCount: snapshot.migrationTags.length,
					lastMigration: snapshot.migrationTags.at(-1),
					caches: snapshot.caches,
					roots: snapshot.roots
				}))
			).toStrictEqual([
				{ migrationCount: 23, lastMigration: '', caches: [], roots: [] },
				{ migrationCount: 25, lastMigration: '', caches: [], roots: [] },
				{
					migrationCount: 32,
					lastMigration: '0031_retention_root_expiry_index',
					caches: [],
					roots: []
				}
			]);

			await server.restart();

			expect(await server.predecessorSnapshot('upgrade-active')).toStrictEqual(
				beforeRestart
			);

			await bootstrapLegacyDeployment({
				api: server.api,
				databaseId: stagedDeploymentDatabaseId,
				artifact: server.artifact,
				deployment: server.deployment,
				observeLegacyRuntime: () => server.legacyRuntimeObservation(),
				deployRuntime: (transition) => server.deployStage(transition.stage)
			});

			const connectedClient = await server.deploymentClient();
			const injectedResponses = new Set<LostResponseCategory>();
			const client = shouldInjectLostResponses
				? injectLostResponses(
						connectedClient,
						server.artifact.deploymentManifest,
						injectedResponses
					)
				: connectedClient;
			const executeExternalAction = cloudflareDeploymentExecutor({
				api: server.api,
				databaseId: stagedDeploymentDatabaseId,
				d1Migrations: server.artifact.d1Migrations,
				deployRuntimeStage: (stage) => server.deployStage(stage)
			});
			const maximumAdvances = 200;
			let isReachedTerminal = false;
			const visitedStates: string[] = [];

			for (let index = 0; index < maximumAdvances; index += 1) {
				const status = await client.status({ deployment: server.deployment });

				if (status.state === 'current') {
					visitedStates.push(status.deploymentState);
				}

				let outcome;

				try {
					outcome = await advanceDeployment({
						client,
						deployment: server.deployment,
						manifest: server.artifact.deploymentManifest,
						executeExternalAction
					});
				} catch (error) {
					if (error instanceof InjectedDeploymentResponseLossError) {
						continue;
					}

					throw new StagedDeploymentAdvanceError(visitedStates, {
						cause: error
					});
				}

				if (
					outcome.state === 'running' &&
					outcome.deploymentState === 'compatible-d1'
				) {
					await server.elapseWriterDrainDeadline();
				}

				if (
					outcome.deploymentState ===
					server.artifact.deploymentManifest.terminalState
				) {
					isReachedTerminal = true;

					if (restartAfterCompletedTransition) {
						await server.restart();
					}

					break;
				}

				if (restartAfterCompletedTransition && outcome.state === 'completed') {
					await server.restart();
				}
			}

			const finalStatus = await client.status({
				deployment: server.deployment
			});
			const terminalSnapshot = await server.terminalSnapshot();
			const finalDeployment =
				finalStatus.state === 'current'
					? {
							state: finalStatus.state,
							deploymentState: finalStatus.deploymentState
						}
					: finalStatus;

			expect({
				reachedTerminal: isReachedTerminal,
				finalDeployment,
				terminalSnapshot,
				injectedResponses: [...injectedResponses].toSorted(byCodeUnit)
			}).toStrictEqual({
				reachedTerminal: true,
				finalDeployment: {
					state: 'current',
					deploymentState: server.artifact.deploymentManifest.terminalState
				},
				terminalSnapshot: {
					lastD1Migration: server.finalD1Migration,
					deploymentState: server.artifact.deploymentManifest.terminalState,
					incompleteGlobalMigrations: 0,
					incompleteTenantMigrations: 0,
					incompleteLocalContracts: 0,
					generationNarInfoPresent: true,
					generationAttestationListPresent: true,
					legacyNarInfoPresent: true
				},
				injectedResponses: [...expectedLostResponses].toSorted(byCodeUnit)
			});
		} finally {
			await server.stop();
		}
	},
	120_000
);
