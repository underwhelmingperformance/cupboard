import {
	currentLocalStep,
	settledDeploymentPhase
} from '@cupboard/protocol/deployment';
import { expect, it } from 'vitest';

import { applyD1Migrations } from '../../packages/cli/src/deploy/migrations.ts';
import {
	type LocalStepReadiness,
	type PhaseApi,
	recordPhaseWhenTenantsReady
} from '../../packages/cli/src/deploy/phase.ts';
import { LocalStepUnreachedError } from '../../packages/cli/src/errors.ts';
import {
	predecessorDurableObjectMigration,
	sleepingFixtureTenants
} from '../fixtures/cache-deployment-predecessor/constants.ts';
import {
	stagedDeploymentDatabaseId,
	StagedDeploymentServer
} from '../support/staged-deployment-server.ts';

// Enough for every seeded tenant, so one call clears the whole fixture.
const wakeLimit = 20;

// The fixture's active tenants: `upgrade-active` plus the sleeping ones. The
// suspended, offboarding and offboarded tenants are not woken and do not count
// towards a step.
const activeFixtureTenants = 1 + sleepingFixtureTenants.length;

function phaseApi(server: StagedDeploymentServer): PhaseApi {
	return {
		queryBatch: (id, statements) => server.api.d1QueryBatch(id, statements),
		queryRows: (id, sql) => server.api.d1QueryRows(id, sql)
	};
}

/**
 * Applies the D1 migrations and swaps in the Workers built from the working
 * tree, as `cupboard deploy` does before it records a phase. `recordPhase` is
 * the step it takes after both Workers serve.
 */
async function deployOverPredecessor(
	server: StagedDeploymentServer
): Promise<void> {
	await applyD1Migrations(
		phaseApi(server),
		stagedDeploymentDatabaseId,
		server.artifact.d1Migrations
	);
	await server.deployCurrent();
}

function recordPhase(
	server: StagedDeploymentServer
): Promise<LocalStepReadiness> {
	return recordPhaseWhenTenantsReady(
		phaseApi(server),
		stagedDeploymentDatabaseId,
		settledDeploymentPhase,
		currentLocalStep,
		new Date()
	);
}

/**
 * The tenants a refused phase record names, or undefined when the record was
 * not refused.
 */
async function refusedPhaseRecord(
	server: StagedDeploymentServer
): Promise<{ pending: number; stragglers: readonly string[] } | undefined> {
	try {
		await recordPhase(server);
	} catch (error) {
		if (error instanceof LocalStepUnreachedError) {
			return { pending: error.pending, stragglers: error.stragglers };
		}

		throw error;
	}

	return undefined;
}

it('upgrades a populated predecessor deployment', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();

		// The fixture starts at the journal positions pinned in `constants.ts`, so
		// the upgrade has to accept tracking rows in the shape earlier builds
		// wrote.
		const before = await server.predecessorSnapshot('upgrade-active');

		expect(before.migrationTags).toContain(predecessorDurableObjectMigration);

		await deployOverPredecessor(server);

		// No tenant has been woken since the swap, so none has recorded step 1 and
		// the phase is refused.
		const refused = await refusedPhaseRecord(server);

		const client = await server.deploymentClient();
		const wake = await client.wakeLocalStep(wakeLimit);

		await recordPhase(server);

		const recorded = await client.phase();

		expect({
			refused,
			wake,
			status: await client.localStepStatus(),
			phase: recorded.phase?.name,
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			refused: {
				pending: activeFixtureTenants,
				stragglers: ['upgrade-active', ...sleepingFixtureTenants]
			},
			wake: {
				current: currentLocalStep,
				woken: activeFixtureTenants,
				failed: 0
			},
			status: {
				current: currentLocalStep,
				ready: activeFixtureTenants,
				pending: 0,
				stragglers: []
			},
			phase: settledDeploymentPhase,
			terminal: {
				lastD1Migration: server.finalD1Migration,
				phase: settledDeploymentPhase,
				activeTenantsBelowStep: 0,
				legacyNarInfoPresent: true
			}
		});
	} finally {
		await server.stop();
	}
});

it('brings a tenant that never woke under the predecessor up to date', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);

		const client = await server.deploymentClient();

		// Before the wake, every active tenant is behind: nothing has woken one
		// since the deploy, so none has recorded a step.
		const before = await client.localStepStatus();

		await client.wakeLocalStep(wakeLimit);

		// Each sleeping tenant stopped at a different migration under the
		// predecessor. Waking one applies the rest of its journal, so it reaches
		// the same step as the tenant that was never behind.
		expect({
			before,
			after: await client.localStepStatus()
		}).toStrictEqual({
			before: {
				current: currentLocalStep,
				ready: 0,
				pending: activeFixtureTenants,
				stragglers: ['upgrade-active', ...sleepingFixtureTenants]
			},
			after: {
				current: currentLocalStep,
				ready: activeFixtureTenants,
				pending: 0,
				stragglers: []
			}
		});
	} finally {
		await server.stop();
	}
});

it('records the same phase when an interrupted deploy is run again', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);

		const first = await server.deploymentClient();

		await first.wakeLocalStep(wakeLimit);
		await recordPhase(server);

		// A rerun repeats every step against the state the first run left.
		await server.restart();
		await deployOverPredecessor(server);
		await recordPhase(server);

		const client = await server.deploymentClient();
		const recorded = await client.phase();

		expect({
			phase: recorded.phase?.name,
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			phase: settledDeploymentPhase,
			terminal: {
				lastD1Migration: server.finalD1Migration,
				phase: settledDeploymentPhase,
				activeTenantsBelowStep: 0,
				legacyNarInfoPresent: true
			}
		});
	} finally {
		await server.stop();
	}
});
