import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	type ParsedLocalStepWakeResponse,
	schemaTransitions
} from '@cupboard/protocol/deployment';
import { StatusCodes } from 'http-status-codes';
import { expect, it } from 'vitest';

import { cacheCreateAuthorizationDetails } from '../../packages/cli/src/auth/attenuate.ts';
import { githubPullRequestClaims } from '../../packages/cli/src/commands/github/claims.ts';
import { pullRequestCacheName } from '../../packages/cli/src/commands/github/convention.ts';
import { githubPrAddBody } from '../../packages/cli/src/commands/oidc-trust.ts';
import type { D1QueryApi } from '../../packages/cli/src/deploy/d1-query.ts';
import {
	readLocalStepReadiness,
	type TransitionStates
} from '../../packages/cli/src/deploy/deployment-state.ts';
import { applyD1Migrations } from '../../packages/cli/src/deploy/migrations.ts';
import {
	completeTransitions,
	prepareTransitions
} from '../../packages/cli/src/deploy/transitions.ts';
import { LocalStepUnreachedError } from '../../packages/cli/src/errors.ts';
import {
	predecessorDurableObjectMigration,
	sleepingFixtureTenants
} from '../fixtures/cache-deployment-predecessor/constants.ts';
import {
	type DeploymentClient,
	stagedDeploymentDatabaseId,
	StagedDeploymentServer
} from '../support/staged-deployment-server.ts';

// Enough for every seeded tenant in one pass.
const wakeLimit = 20;
const wakePassLimit = 100;

const repository = {
	repositoryId: 4321,
	repositoryOwnerId: 8765,
	fullName: 'owner/repo',
	defaultBranch: 'main'
};

const resumableFixtureTenants = 2 + sleepingFixtureTenants.length;

// The clock that every walk uses for timestamps, so the recorded timestamps are
// known.
const deployedAt = new Date('2026-01-01T00:00:00.000Z');

const completedTransitions = {
	transitions: [
		{
			id: 'cache-identity',
			state: 'complete',
			updatedAt: deployedAt.toISOString()
		},
		{
			id: 'deployment-transitions',
			state: 'complete',
			updatedAt: deployedAt.toISOString()
		}
	],
	unrecognised: []
};

async function wakeUntilStep(
	server: StagedDeploymentServer,
	client: DeploymentClient,
	requiredStep: LocalStep
): Promise<{
	readonly didAdvance: boolean;
	readonly final: ParsedLocalStepWakeResponse;
}> {
	let didAdvance = false;
	for (let pass = 0; pass < wakePassLimit; pass++) {
		const wake = await client.wakeLocalStep(wakeLimit);
		didAdvance ||= wake.outcomes.some((outcome) => outcome.kind === 'advanced');
		const readiness = await readLocalStepReadiness(
			d1QueryApi(server),
			stagedDeploymentDatabaseId,
			requiredStep
		);

		if (readiness.pending === 0) {
			return { didAdvance, final: wake };
		}
	}

	throw new Error(
		`Tenant migration did not reach local step ${String(requiredStep)}`
	);
}

function d1QueryApi(server: StagedDeploymentServer): D1QueryApi {
	return {
		queryBatch: (id, statements) => server.api.d1QueryBatch(id, statements),
		queryRows: (id, sql) => server.api.d1QueryRows(id, sql)
	};
}

/**
 * Applies the schema transitions as `cupboard deploy` does before it uploads
 * the Workers, then swaps in the Workers built from the working tree.
 */
async function deployOverPredecessor(
	server: StagedDeploymentServer,
	now = deployedAt
): Promise<void> {
	await prepareTransitions(server.transitionWalk({ now: () => now }), false);
	await server.deployCurrent();
}

/**
 * Completes the transitions as the deploy does once both Workers serve the
 * build: checks that every active or suspended tenant has recorded the required
 * local step, applies the contract migrations and records the transition
 * complete.
 */
function contractOverPredecessor(
	server: StagedDeploymentServer,
	now = deployedAt
): Promise<TransitionStates> {
	return completeTransitions(server.transitionWalk({ now: () => now }));
}

/**
 * The tenants that `LocalStepUnreachedError` lists when the contract
 * migrations are refused, or undefined when they were not refused.
 */
async function refusedContract(
	server: StagedDeploymentServer
): Promise<{ pending: number; stragglers: readonly string[] } | undefined> {
	try {
		await contractOverPredecessor(server);
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
		// the contract migrations are refused.
		const refused = await refusedContract(server);

		const client = await server.deploymentClient();
		const expanded = await client.transitions();
		const wake = await wakeUntilStep(server, client, expansionLocalStep);

		await contractOverPredecessor(server);
		const contractWake = await wakeUntilStep(server, client, currentLocalStep);

		expect({
			refused,
			expanded,
			wake,
			contractWake,
			status: await client.localStepStatus(),
			recorded: await client.transitions(),
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			refused: {
				pending: resumableFixtureTenants,
				stragglers: [
					'upgrade-active',
					...sleepingFixtureTenants,
					'upgrade-suspended'
				]
			},
			// Before the upload the deploy expanded both transitions and completed
			// the one with no contract migrations; the tenants then had step 4 to
			// reach.
			expanded: {
				transitions: [
					{
						id: 'cache-identity',
						state: 'expanded',
						updatedAt: deployedAt.toISOString()
					},
					{
						id: 'deployment-transitions',
						state: 'complete',
						updatedAt: deployedAt.toISOString()
					}
				],
				unrecognised: []
			},
			wake: {
				didAdvance: true,
				final: {
					current: currentLocalStep,
					required: expansionLocalStep,
					woken: resumableFixtureTenants,
					failed: 0,
					outcomes: [
						'upgrade-active',
						...sleepingFixtureTenants,
						'upgrade-suspended'
					].map((tenant) => ({
						tenant,
						kind: 'recorded',
						step: expansionLocalStep
					}))
				}
			},
			contractWake: {
				didAdvance: false,
				final: {
					current: currentLocalStep,
					required: currentLocalStep,
					woken: resumableFixtureTenants,
					failed: 0,
					outcomes: [
						'upgrade-active',
						...sleepingFixtureTenants,
						'upgrade-suspended'
					].map((tenant) => ({
						tenant,
						kind: 'recorded',
						step: currentLocalStep
					}))
				}
			},
			status: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: resumableFixtureTenants,
				pending: 0,
				stragglers: []
			},
			recorded: completedTransitions,
			terminal: {
				appliedD1Migrations: server.d1MigrationNames,
				transitions: {
					'cache-identity': 'complete',
					'deployment-transitions': 'complete'
				},
				phase: 'contracted',
				resumableTenantsBelowStep: 0,
				legacyNarInfoPresent: true
			}
		});
	} finally {
		await server.stop();
	}
});

// Deployments on v0.0.34 and v0.0.35 have every `cache-identity` expand
// migration applied and a `deployment_phase` row. This test gives the
// predecessor fixture that state in D1, so the reconciliation with
// `native-reads` and the `deployment_phase` writes run against D1.
it('upgrades a deployment that v0.0.35 left at native-reads', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		const cacheIdentityExpand = new Set(
			schemaTransitions.find((transition) => transition.id === 'cache-identity')
				?.expand
		);
		await applyD1Migrations(
			d1QueryApi(server),
			stagedDeploymentDatabaseId,
			server.artifact.d1Migrations.filter((migration) =>
				cacheIdentityExpand.has(migration.name)
			)
		);
		await server.api.d1QueryBatch(stagedDeploymentDatabaseId, [
			"INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) VALUES ('current', 'native-reads', 4, '2025-12-01T00:00:00.000Z')"
		]);

		await deployOverPredecessor(server);

		const client = await server.deploymentClient();
		const expanded = await client.transitions();

		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

		expect({
			expanded,
			recorded: await client.transitions(),
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			expanded: {
				transitions: [
					{
						id: 'cache-identity',
						state: 'expanded',
						updatedAt: deployedAt.toISOString()
					},
					{
						id: 'deployment-transitions',
						state: 'complete',
						updatedAt: deployedAt.toISOString()
					}
				],
				unrecognised: []
			},
			recorded: completedTransitions,
			terminal: {
				appliedD1Migrations: server.d1MigrationNames,
				transitions: {
					'cache-identity': 'complete',
					'deployment-transitions': 'complete'
				},
				phase: 'contracted',
				resumableTenantsBelowStep: 0,
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

		// Before the wake, every active or suspended tenant is behind: none has
		// run since the deploy, so none has recorded a step.
		const before = await client.localStepStatus();

		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

		// Each sleeping tenant stopped at a different migration under the
		// predecessor. Repeated wakes advance its persisted pages until it reaches
		// the same step as the tenant that was never behind.
		expect({
			before,
			after: await client.localStepStatus()
		}).toStrictEqual({
			before: {
				current: currentLocalStep,
				required: expansionLocalStep,
				ready: 0,
				pending: resumableFixtureTenants,
				stragglers: [
					'upgrade-active',
					...sleepingFixtureTenants,
					'upgrade-suspended'
				]
			},
			after: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: resumableFixtureTenants,
				pending: 0,
				stragglers: []
			}
		});
	} finally {
		await server.stop();
	}
});

it('serves a suspended predecessor private cache immediately after resume', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);

		const client = await server.deploymentClient();
		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

		await server.resumeTenant('upgrade-suspended');
		await server.configureTenantReadCredential('upgrade-suspended');
		const immediate = await server.tenantNarInfo(
			'upgrade-suspended',
			'secrets'
		);
		await immediate.arrayBuffer();

		await client.wakeLocalStep(wakeLimit);
		const afterWake = await server.tenantNarInfo(
			'upgrade-suspended',
			'secrets'
		);
		await afterWake.arrayBuffer();

		expect({
			immediate: immediate.status,
			afterWake: afterWake.status
		}).toStrictEqual({
			immediate: StatusCodes.OK,
			afterWake: StatusCodes.OK
		});
	} finally {
		await server.stop();
	}
});

it('records the same transitions when an interrupted deploy is run again', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());

	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);

		const first = await server.deploymentClient();

		await wakeUntilStep(server, first, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, first, currentLocalStep);
		const initial = await first.transitions();

		// A rerun repeats every step against the state the first run left.
		const rerunAt = new Date('2026-01-02T00:00:00.000Z');
		await server.restart();
		await deployOverPredecessor(server, rerunAt);
		await contractOverPredecessor(server, rerunAt);

		const client = await server.deploymentClient();
		const recorded = await client.transitions();

		expect({
			initial,
			repeated: recorded,
			terminal: await server.terminalSnapshot()
		}).toStrictEqual({
			initial: completedTransitions,
			repeated: completedTransitions,
			terminal: {
				appliedD1Migrations: server.d1MigrationNames,
				transitions: {
					'cache-identity': 'complete',
					'deployment-transitions': 'complete'
				},
				phase: 'contracted',
				resumableTenantsBelowStep: 0,
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

		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

		// The predecessor seeded retention policies for the default cache and
		// `builds`, a `pr/` root-prefix policy, and grace policies for the empty
		// and `builds` cache-name prefixes. Each cache now has the retention
		// those policies gave it and refers to the shared prefix rule set.
		expect(await server.tenantCaches('upgrade-active')).toStrictEqual({
			caches: [
				{
					scope: { kind: 'default' },
					access: 'public',
					priority: 40,
					storePaths: 0,
					defaultRootRetention: { kind: 'duration', seconds: 1_209_600 },
					grace: { kind: 'duration', graceSeconds: 3600 },
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
					graceManaged: true
				}
			]
		});

		const rpc = await server.tenantOwnerRpc('upgrade-active');
		const details = await Promise.all([
			rpc.caches.get.inDefaultCache({}),
			rpc.caches.get.inNamedCache({
				cacheName: cacheNameSchema.parse('builds')
			}),
			rpc.caches.get.inNamedCache({
				cacheName: cacheNameSchema.parse('secrets')
			})
		]);

		expect(
			details.map(({ scope, rootRetentionOverrides }) => ({
				scope,
				rootRetentionOverrides
			}))
		).toStrictEqual(
			[
				{ kind: 'default' },
				{ kind: 'named', name: 'builds' },
				{ kind: 'named', name: 'secrets' }
			].map((scope) => ({
				scope,
				rootRetentionOverrides: [
					{
						rootPrefix: 'pr/',
						retention: { kind: 'duration', seconds: 86_400 }
					}
				]
			}))
		);
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

		const client = await server.deploymentClient();

		// The wake excludes offboarding tenants, so it leaves this one behind.
		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

		await server.announceTenant('upgrade-offboarding');

		// Admission starts the object before refusing the read. Repeated requests
		// advance its persisted migration pages even though it no longer serves reads.
		let response: Response | undefined;
		let didReturnPending = false;
		for (let attempt = 0; attempt < wakePassLimit; attempt++) {
			response = await server.dispatch('/t/upgrade-offboarding/nix-cache-info');
			if (response.status !== 503) {
				break;
			}
			didReturnPending = true;
		}

		// Recording the catalogue version is the last thing the object's start-up
		// does, so reading it back proves every migration applied, the contraction
		// among them.
		expect({
			didReturnPending,
			read: response?.status,
			catalogueVersion: await server.catalogueVersion('upgrade-offboarding')
		}).toStrictEqual({
			didReturnPending: true,
			read: StatusCodes.NOT_FOUND,
			catalogueVersion: 2
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

		const client = await server.deploymentClient();

		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

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
