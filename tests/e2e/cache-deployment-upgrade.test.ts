import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	migrationsAppliedAfterCutover,
	settledDeploymentPhase
} from '@cupboard/protocol/deployment';
import { StatusCodes } from 'http-status-codes';
import { expect, it } from 'vitest';

import { cacheCreateAuthorizationDetails } from '../../packages/cli/src/auth/attenuate.ts';
import { githubPullRequestClaims } from '../../packages/cli/src/commands/github/claims.ts';
import { pullRequestCacheName } from '../../packages/cli/src/commands/github/convention.ts';
import { githubPrAddBody } from '../../packages/cli/src/commands/oidc-trust.ts';
import {
	applyD1Migrations,
	type D1MigrationApi
} from '../../packages/cli/src/deploy/migrations.ts';
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

// The repository the pull-request trust rule below is written for.
const repository = {
	repositoryId: 4321,
	repositoryOwnerId: 8765,
	fullName: 'owner/repo'
};

// The fixture's active tenants: `upgrade-active` plus the sleeping ones. The
// suspended, offboarding and offboarded tenants are not woken and do not count
// towards a step.
const activeFixtureTenants = 1 + sleepingFixtureTenants.length;

function migrationApi(server: StagedDeploymentServer): D1MigrationApi {
	return {
		queryBatch: (id, statements) => server.api.d1QueryBatch(id, statements),
		queryRows: (id, sql) => server.api.d1QueryRows(id, sql)
	};
}

function isDeferredMigration(name: string): boolean {
	return migrationsAppliedAfterCutover.includes(name);
}

/**
 * Applies the migrations that must precede the cutover, swaps in the Workers
 * built from the working tree, and records the phase. These are the steps
 * `cupboard deploy` performs against Cloudflare before it waits for the
 * preceding release to drain, driven here against the harness's persisted
 * storage.
 */
async function deployOverPredecessor(
	server: StagedDeploymentServer
): Promise<void> {
	await applyD1Migrations(
		migrationApi(server),
		stagedDeploymentDatabaseId,
		server.artifact.d1Migrations.filter(
			(migration) => !isDeferredMigration(migration.name)
		)
	);
	await server.deployCurrent();
	await recordDeploymentPhase(
		migrationApi(server),
		stagedDeploymentDatabaseId,
		settledDeploymentPhase,
		currentLocalStep,
		new Date()
	);
}

/**
 * Applies the migrations that remove what the preceding release still writes.
 * `cupboard deploy` runs these once that release can no longer be serving.
 */
async function contractOverPredecessor(
	server: StagedDeploymentServer
): Promise<void> {
	await applyD1Migrations(
		migrationApi(server),
		stagedDeploymentDatabaseId,
		server.artifact.d1Migrations.filter((migration) =>
			isDeferredMigration(migration.name)
		)
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

		// The contraction removes columns the preceding release still writes, so
		// the deploy leaves it until that release can no longer be serving.
		const beforeContraction = await server.terminalSnapshot();

		await contractOverPredecessor(server);

		const client = await server.deploymentClient();

		const recorded = await client.phase();

		expect({
			lastMigrationBeforeContraction: beforeContraction.lastD1Migration,
			phase: recorded.phase?.name,
			wake: await client.wakeLocalStep(wakeLimit),
			status: await client.localStepStatus(),
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			lastMigrationBeforeContraction: server.finalPreCutoverD1Migration,
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
		await contractOverPredecessor(server);

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
		await contractOverPredecessor(server);

		// A rerun repeats every step against the state the first run left.
		await server.restart();
		await deployOverPredecessor(server);
		await contractOverPredecessor(server);

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
		await contractOverPredecessor(server);

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

// An offboarding tenant takes no traffic of its own and nothing wakes it during
// a deploy, so it can reach this release with its cache catalogue still
// unconverted. Its object has to convert and contract when it next runs, or the
// offboard drain would fail for good and the tenant could never be finalised.
it('starts an offboarding tenant that never converted its catalogue', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);
		await contractOverPredecessor(server);

		const client = await server.deploymentClient();

		// The wake covers only active tenants, so it leaves this one behind.
		await client.wakeLocalStep(wakeLimit);

		await server.announceTenant('upgrade-offboarding');

		// Admission starts the object before refusing the read, so a request for a
		// tenant that no longer serves reads is still enough to make the object
		// migrate.
		const response = await server.dispatch(
			'/t/upgrade-offboarding/nix-cache-info'
		);

		// Recording the catalogue version is the last thing the object's start-up
		// does, so reading it back proves every migration applied, the contraction
		// among them.
		expect({
			read: response.status,
			catalogueVersion: await server.catalogueVersion('upgrade-offboarding')
		}).toStrictEqual({
			read: StatusCodes.NOT_FOUND,
			catalogueVersion: 1
		});
	} finally {
		await server.stop();
	}
});

// Existing tenants are upgraded in place, and their runs use the same
// workflow, so the grant that permits a pull-request run to create its cache
// has to work against a tenant whose state came from the predecessor.
it('lets a pull-request token create its cache on an upgraded tenant', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);
		await contractOverPredecessor(server);

		const client = await server.deploymentClient();

		await client.wakeLocalStep(wakeLimit);

		const owner = await server.tenantOwnerRpc('upgrade-active');
		const tenantUrl = server.tenantUrl('upgrade-active');

		// The rule `cupboard github setup` writes, with the issuer replaced by
		// the one the harness can sign for.
		await owner.oidcTrust.add({
			...githubPrAddBody(tenantUrl, repository, {
				repo: repository.fullName
			}),
			issuer: server.issuerUrl
		});

		const cache: CacheScope = {
			kind: 'named',
			name: cacheNameSchema.parse(
				pullRequestCacheName(repository.repositoryId, 1)
			)
		};
		const credential = await server.tenantCiCredential(
			'upgrade-active',
			{
				...githubPullRequestClaims(tenantUrl, repository, {
					pullRequestNumber: 1
				}),
				iss: server.issuerUrl
			},
			cacheCreateAuthorizationDetails({ cache })
		);
		const cacheName = cache.name;
		const ci = server.tenantRpcAs('upgrade-active', credential);

		await ci.caches.put.inNamedCache({
			cacheName: cache.name,
			access: 'public',
			priority: 30
		});

		const { caches } = await server.tenantCaches('upgrade-active');

		expect(
			caches
				.map((summary) =>
					summary.scope.kind === 'named' ? summary.scope.name : 'default'
				)
				.toSorted((left, right) => left.localeCompare(right))
		).toStrictEqual(
			['builds', 'default', 'secrets', cacheName].toSorted((left, right) =>
				left.localeCompare(right)
			)
		);
	} finally {
		await server.stop();
	}
});
