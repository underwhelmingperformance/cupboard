import {
	currentLocalStep,
	settledDeploymentPhase
} from '@cupboard/protocol/deployment';
import { expect, it } from 'vitest';

import { applyD1Migrations } from '../../packages/cli/src/deploy/migrations.ts';
import { recordDeploymentPhase } from '../../packages/cli/src/deploy/phase.ts';
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

/**
 * Applies the D1 migrations, swaps in the Workers built from the working tree,
 * and records the phase. These are the steps `cupboard deploy` performs against
 * Cloudflare, driven here against the harness's persisted storage.
 */
async function deployOverPredecessor(
	server: StagedDeploymentServer
): Promise<void> {
	await applyD1Migrations(
		{
			queryBatch: (id, statements) => server.api.d1QueryBatch(id, statements),
			queryRows: (id, sql) => server.api.d1QueryRows(id, sql)
		},
		stagedDeploymentDatabaseId,
		server.artifact.d1Migrations
	);
	await server.deployCurrent();
	await recordDeploymentPhase(
		{
			queryBatch: (id, statements) => server.api.d1QueryBatch(id, statements),
			queryRows: (id, sql) => server.api.d1QueryRows(id, sql)
		},
		stagedDeploymentDatabaseId,
		settledDeploymentPhase,
		currentLocalStep,
		new Date()
	);
}

it('upgrades a populated predecessor deployment', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();

		// The fixture starts at the migration positions production is on, so the
		// upgrade has to accept the journal a real predecessor wrote.
		const before = await server.predecessorSnapshot('upgrade-active');

		expect(before.migrationTags).toContain(predecessorDurableObjectMigration);

		await deployOverPredecessor(server);

		const client = await server.deploymentClient();

		const recorded = await client.phase();

		expect({
			phase: recorded.phase?.name,
			wake: await client.wakeLocalStep(wakeLimit),
			status: await client.localStepStatus(),
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			phase: settledDeploymentPhase,
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

		// Before the wake, every tenant is behind: none has run since the
		// predecessor, so none has recorded a step.
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

		// A rerun repeats every step against the state the first run left.
		await server.restart();
		await deployOverPredecessor(server);

		const client = await server.deploymentClient();

		await client.wakeLocalStep(wakeLimit);

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

it('gives each cache the retention its legacy policies granted it', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);

		const client = await server.deploymentClient();

		await client.wakeLocalStep(wakeLimit);

		// The predecessor seeded a cache policy for the default cache and for
		// `builds`, one `pr/` prefix policy, and grace policies on the empty and
		// `builds` cache prefixes. Each cache should now hold the retention its
		// matching policies gave it, and every cache should refer to the single
		// rule set built from the prefix policy.
		expect(await server.tenantCaches('upgrade-active')).toStrictEqual({
			caches: [
				{
					scope: { kind: 'default' },
					access: 'public',
					priority: 40,
					storePaths: 0,
					defaultRootRetention: { kind: 'duration', seconds: 1_209_600 },
					grace: { kind: 'duration', graceSeconds: 3600 },
					rootRetentionOverrides: [
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 86_400 }
						}
					],
					graceManaged: true
				},
				{
					scope: { kind: 'named', name: 'builds' },
					access: 'public',
					priority: 30,
					storePaths: 1,
					defaultRootRetention: { kind: 'duration', seconds: 604_800 },
					grace: { kind: 'duration', graceSeconds: 7200 },
					// The grace deadline the predecessor recorded for this cache's one
					// path, which the retention move leaves alone.
					earliestGraceDeadline: '2099-01-01T00:00:00.000Z',
					rootRetentionOverrides: [
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 86_400 }
						}
					],
					graceManaged: true
				},
				{
					scope: { kind: 'named', name: 'secrets' },
					access: 'private',
					priority: 20,
					storePaths: 0,
					defaultRootRetention: { kind: 'permanent' },
					// A private cache took no grace from a cache-prefix policy, so it
					// keeps none here.
					grace: { kind: 'none' },
					rootRetentionOverrides: [
						{
							rootPrefix: 'pr/',
							retention: { kind: 'duration', seconds: 86_400 }
						}
					],
					graceManaged: true
				}
			]
		});
	} finally {
		await server.stop();
	}
});
