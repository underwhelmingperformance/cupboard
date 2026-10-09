import { setImmediate as yieldTurn } from 'node:timers/promises';

import { capturingReporter, fakeCliUi } from '@cupboard/cli-ui/testing';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import {
	currentLocalStep,
	expansionLocalStep,
	type LocalStep,
	type SchemaTransition,
	schemaTransitions,
	type TransitionState,
	type TransitionStates
} from '@cupboard/protocol/deployment';
import { StatusCodes } from 'http-status-codes';
import { expect, it, onTestFinished } from 'vitest';

import { cacheCreateAuthorizationDetails } from '../../packages/cli/src/auth/attenuate.ts';
import { BoundSignIn } from '../../packages/cli/src/auth/bound-sign-in.ts';
import { githubPullRequestClaims } from '../../packages/cli/src/commands/github/claims.ts';
import { pullRequestCacheName } from '../../packages/cli/src/commands/github/convention.ts';
import { githubPrAddBody } from '../../packages/cli/src/commands/oidc-trust.ts';
import {
	AdminTokenRequiredError,
	type AuthorityApi,
	type AuthorityWorld,
	establishAuthority
} from '../../packages/cli/src/deploy/authority.ts';
import { transferControlDatabase } from '../../packages/cli/src/deploy/control-database-transfer.ts';
import type { D1QueryApi } from '../../packages/cli/src/deploy/d1-query.ts';
import { readLocalStepReadiness } from '../../packages/cli/src/deploy/deployment-state.ts';
import { applyD1Migrations } from '../../packages/cli/src/deploy/migrations.ts';
import { settleTenants } from '../../packages/cli/src/deploy/settlement.ts';
import {
	completeTransitions,
	prepareTransitions
} from '../../packages/cli/src/deploy/transitions.ts';
import {
	LocalStepUnreachedError,
	OwnerLoginRequiredError,
	TransitionIncompleteError
} from '../../packages/cli/src/errors.ts';
import {
	predecessorDurableObjectMigration,
	sleepingFixtureTenants
} from '../fixtures/cache-deployment-predecessor/constants.ts';
import { intermediateTransitions } from '../support/intermediate-deployment.ts';
import { ManualClock } from '../support/manual-clock.ts';
import {
	type DeploymentClient,
	stagedDeploymentDatabaseId,
	StagedDeploymentServer
} from '../support/staged-deployment-server.ts';

// The most reads of an offboarding tenant's cache that a test makes while the
// tenant's object continues its migrations.
const pendingReadLimit = 100;

const repository = {
	repositoryId: 4321,
	repositoryOwnerId: 8765,
	fullName: 'owner/repo',
	defaultBranch: 'main'
};

const resumableFixtureTenants = 2 + sleepingFixtureTenants.length;

// The counts in `localStep.status` once every tenant has recorded the step.
const noTenantPending = {
	pending: 0,
	working: 0,
	stalled: 0,
	unwoken: 0,
	stalledSample: [],
	unwokenSample: []
};

// The clock that every walk uses for timestamps, so the recorded timestamps are
// known.
const deployedAt = new Date('2026-01-01T00:00:00.000Z');

function recordedAs(
	state: (transition: SchemaTransition) => TransitionState,
	transitions: readonly SchemaTransition[] = schemaTransitions
) {
	return transitions.map((transition) => ({
		id: transition.id,
		state: state(transition),
		updatedAt: deployedAt.toISOString()
	}));
}

const sharedTransitions = schemaTransitions.filter(
	(transition) => (transition.database ?? 'CUPBOARD_DB') === 'CUPBOARD_DB'
);

const completedTransitions = {
	transitions: recordedAs(() => 'complete'),
	unrecognised: []
};

const terminalTransitions = Object.fromEntries(
	sharedTransitions.map((transition) => [transition.id, 'complete'])
);

// What the intermediate walk records before its upload. The first
// transition has contract migrations, so the walk only expands it. The walk
// expands each later transition before the upload because it is independent,
// and immediately completes a transition with no contract migrations and no
// contract step. The expectation reads the transition's lists directly, not
// the walk's own predicate, so a defect in that predicate fails the test.
const preUploadTransitions = {
	transitions: recordedAs(
		(transition) =>
			transition.contract.length === 0 && transition.contractStep === undefined
				? 'complete'
				: 'expanded',
		intermediateTransitions
	),
	unrecognised: []
};

/**
 * Wakes the tenants and waits for them as the deploy does, then checks that
 * every active or suspended tenant has recorded `requiredStep`. The wake goes
 * through the maintenance queue, and each woken tenant object continues its
 * own work on its alarm.
 */
async function wakeUntilStep(
	server: StagedDeploymentServer,
	client: DeploymentClient,
	requiredStep: LocalStep
): Promise<void> {
	const clock = new ManualClock();
	const controller = new AbortController();
	onTestFinished(() => {
		controller.abort();
	});
	await settleTenants(
		{
			status: () => client.localStepStatus(),
			wake: () => client.wakeLocalStep()
		},
		capturingReporter([]),
		{ now: clock.now, delay: () => yieldTurn(), signal: controller.signal }
	);
	const readiness = await readLocalStepReadiness(
		d1QueryApi(server),
		stagedDeploymentDatabaseId,
		requiredStep
	);

	if (readiness.pending === 0) {
		return;
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
 * Expands the intermediate release before its upload. A rerun after the
 * handoff expands and uploads the current release.
 */
async function deployOverPredecessor(
	server: StagedDeploymentServer,
	now = deployedAt
): Promise<void> {
	const stage =
		server.deploymentStage === 'current' ? 'current' : 'intermediate';
	if (stage === 'current') {
		await prepareTransitions(
			server.transitionWalk({ now: () => now }, stage, 'CONTROL_DB'),
			false
		);
	}
	await prepareTransitions(
		server.transitionWalk({ now: () => now }, stage),
		false
	);
	if (stage === 'current') {
		await server.deployCurrent();
		return;
	}
	await server.deployIntermediate();
}

/**
 * Completes the transitions as the deploy does once both Workers serve the
 * build: checks that every active or suspended tenant has recorded the required
 * local step, applies the contract migrations and records the transition
 * complete.
 */
async function contractOverPredecessor(
	server: StagedDeploymentServer,
	now = deployedAt
): Promise<TransitionStates> {
	if (server.deploymentStage === 'intermediate') {
		await completeTransitions(
			server.transitionWalk({ now: () => now }, 'intermediate')
		);
		await prepareTransitions(
			server.transitionWalk({ now: () => now }, 'current', 'CONTROL_DB'),
			false
		);
		await prepareTransitions(server.transitionWalk({ now: () => now }), false);
		await server.deployCurrent();
	}
	return completeTransitions(server.transitionWalk({ now: () => now }));
}

it.each(['predecessor', 'intermediate'] as const)(
	'refuses a direct upgrade from %s until cache identity is complete',
	async (stage) => {
		const server = await StagedDeploymentServer.start(process.cwd());

		try {
			await server.seedPredecessor();
			if (stage === 'intermediate') {
				await deployOverPredecessor(server);
			}
			const database = await server.database();
			const before = await database
				.prepare('SELECT name, type, sql FROM sqlite_master ORDER BY name')
				.all();

			await expect(
				prepareTransitions(
					server.transitionWalk({ now: () => deployedAt }),
					false
				)
			).rejects.toStrictEqual(
				new TransitionIncompleteError(
					'cache-identity',
					'blob-reference-read-authority',
					'v0.0.34'
				)
			);

			const after = await database
				.prepare('SELECT name, type, sql FROM sqlite_master ORDER BY name')
				.all();
			expect({
				stage: server.deploymentStage,
				schema: after.results
			}).toStrictEqual({ stage, schema: before.results });
		} finally {
			await server.stop();
		}
	}
);

/**
 * The tenants that `LocalStepUnreachedError` lists when the deploy stops before
 * the contract migrations, or undefined when it applied them.
 */
async function stoppedBeforeContract(
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

it('defines the dependencies of the staged schema transitions', () => {
	expect(
		sharedTransitions.map((transition) => ({
			id: transition.id,
			independent: transition.independent === true
		}))
	).toStrictEqual([
		{ id: 'cache-identity', independent: false },
		{ id: 'deployment-transitions', independent: true },
		{ id: 'attestation-path-index', independent: true },
		{ id: 'local-step-attempts', independent: true },
		{ id: 'publication-identity', independent: true },
		{ id: 'blob-reference-read-authority', independent: false },
		{ id: 'tenant-retry-clock', independent: true },
		{ id: 'tenant-schema-progress', independent: true },
		{ id: 'control-refresh-sessions', independent: true },
		{ id: 'control-subject-nonces', independent: true },
		{ id: 'control-database-split', independent: true }
	]);
});

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
		// the deploy stops before the contract migrations.
		const refused = await stoppedBeforeContract(server);

		const client = await server.deploymentClient();
		const expanded = await client.transitions();
		await server.restart();
		const intermediateStage = server.deploymentStage;
		await wakeUntilStep(server, client, expansionLocalStep);
		const expandedStatus = await client.localStepStatus();

		await contractOverPredecessor(server);
		await wakeUntilStep(server, client, currentLocalStep);

		expect({
			refused,
			expanded,
			intermediateStage,
			currentStage: server.deploymentStage,
			expandedStatus,
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
			// Before the upload the deploy expanded every transition and completed
			// the transitions with no contract migrations and no contract step.
			// The tenants then had to record step 4.
			expanded: preUploadTransitions,
			intermediateStage: 'intermediate',
			currentStage: 'current',
			expandedStatus: {
				current: currentLocalStep,
				required: expansionLocalStep,
				ready: resumableFixtureTenants,
				...noTenantPending
			},
			status: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: resumableFixtureTenants,
				workingSample: [],
				...noTenantPending
			},
			recorded: completedTransitions,
			terminal: {
				appliedD1Migrations: server.upgradeMigrationOrder,
				transitions: terminalTransitions,
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
	const nativeReadsAt = '2025-12-01T00:00:00.000Z';
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
			`INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) VALUES ('current', 'native-reads', 4, '${nativeReadsAt}')`
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
			// The walk records the `cache-identity` expansion at the time of the
			// phase row that v0.0.35 wrote.
			expanded: {
				...preUploadTransitions,
				transitions: preUploadTransitions.transitions.map((transition) =>
					transition.id === 'cache-identity'
						? { ...transition, updatedAt: nativeReadsAt }
						: transition
				)
			},
			recorded: completedTransitions,
			terminal: {
				appliedD1Migrations: server.upgradeMigrationOrder,
				transitions: terminalTransitions,
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
		// predecessor. After one wake, its object runs its persisted pages on its
		// alarm until it reaches the same step as the tenant that was never
		// behind.
		expect({
			before,
			after: await client.localStepStatus()
		}).toStrictEqual({
			before: {
				current: currentLocalStep,
				required: expansionLocalStep,
				ready: 0,
				pending: resumableFixtureTenants,
				working: 0,
				stalled: 0,
				unwoken: resumableFixtureTenants,
				stalledSample: [],
				unwokenSample: [
					'upgrade-active',
					...sleepingFixtureTenants,
					'upgrade-suspended'
				].map((tenant) => ({ tenant }))
			},
			after: {
				current: currentLocalStep,
				required: currentLocalStep,
				ready: resumableFixtureTenants,
				workingSample: [],
				...noTenantPending
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

		await client.wakeLocalStep();
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
				appliedD1Migrations: server.upgradeMigrationOrder,
				transitions: terminalTransitions,
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
		for (let attempt = 0; attempt < pendingReadLimit; attempt++) {
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

it('moves predecessor control authority to a separate database', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());
	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);
		const client = await server.deploymentClient();
		await wakeUntilStep(server, client, expansionLocalStep);
		await contractOverPredecessor(server);
		const control = await server.controlDatabase();
		const shared = await server.database();
		const ready = await control
			.prepare(
				"SELECT source_database_id, state FROM control_database_ready WHERE id = 'current'"
			)
			.first();
		const authority = await control
			.prepare(
				"SELECT id, subject, audience FROM global_admin WHERE id = 'singleton'"
			)
			.first();
		const sharedControlTables = await shared
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('control_auth_key', 'control_trust', 'global_admin') ORDER BY name"
			)
			.all();
		const targetTransitions = await control
			.prepare('SELECT id, state FROM deployment_transition ORDER BY id')
			.all();
		expect({
			ready,
			authority,
			sharedControlTables: sharedControlTables.results,
			targetTransitions: targetTransitions.results
		}).toStrictEqual({
			ready: { source_database_id: stagedDeploymentDatabaseId, state: 'ready' },
			authority: {
				id: 'singleton',
				subject: 'upgrade-deployment-operator',
				audience: 'upgrade-deployment-client'
			},
			sharedControlTables: [],
			targetTransitions: [{ id: 'control-database-initial', state: 'complete' }]
		});
		await server.restart();
		const restarted = await server.deploymentClient();
		expect(await restarted.transitions()).toStrictEqual(completedTransitions);
	} finally {
		await server.stop();
	}
});

it('completes a transfer when another deploy contracts during a source schema read', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());
	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);
		const client = await server.deploymentClient();
		await wakeUntilStep(server, client, expansionLocalStep);
		await completeTransitions(
			server.transitionWalk({ now: () => deployedAt }, 'intermediate')
		);
		await prepareTransitions(
			server.transitionWalk({ now: () => deployedAt }, 'current', 'CONTROL_DB'),
			false
		);
		await prepareTransitions(
			server.transitionWalk({ now: () => deployedAt }),
			false
		);
		await server.deployCurrent();
		const controlWalk = server.transitionWalk({}, 'current', 'CONTROL_DB');
		const other = server.transitionWalk({ now: () => deployedAt });
		let didContract = false;
		const api: D1QueryApi = {
			queryBatch: (id, statements) => server.api.d1QueryBatch(id, statements),
			queryRows: async (id, sql) => {
				if (
					!didContract &&
					id === stagedDeploymentDatabaseId &&
					sql.includes('pragma_table_info')
				) {
					didContract = true;
					await completeTransitions(other);
				}
				return server.api.d1QueryRows(id, sql);
			}
		};
		const first = server.transitionWalk({
			now: () => deployedAt,
			beforeContract: async (id) => {
				if (id !== 'control-database-split') {
					return;
				}
				await transferControlDatabase({
					api,
					source: stagedDeploymentDatabaseId,
					target: controlWalk.database.id,
					now: deployedAt,
					validateKeys: () =>
						Promise.reject(
							new Error(
								'The completed transfer must use the other deploy validation'
							)
						)
				});
			}
		});
		const states = await completeTransitions(first);
		const target = await server.controlDatabase();
		const shared = await server.database();
		expect({
			didContract,
			states: Object.fromEntries(states),
			ready: await target
				.prepare(
					"SELECT source_database_id, state FROM control_database_ready WHERE id = 'current'"
				)
				.first(),
			copied: await shared
				.prepare(
					"SELECT copied_at FROM control_database_split WHERE id = 'current'"
				)
				.first()
		}).toStrictEqual({
			didContract: true,
			states: terminalTransitions,
			ready: { source_database_id: stagedDeploymentDatabaseId, state: 'ready' },
			copied: { copied_at: deployedAt.toISOString() }
		});
	} finally {
		await server.stop();
	}
});

it('uses Cloudflare recovery only while a real control transfer remains frozen', async () => {
	const server = await StagedDeploymentServer.start(process.cwd());
	try {
		await server.seedPredecessor();
		await deployOverPredecessor(server);
		const client = await server.deploymentClient();
		await wakeUntilStep(server, client, expansionLocalStep);
		await completeTransitions(
			server.transitionWalk({ now: () => deployedAt }, 'intermediate')
		);
		await prepareTransitions(
			server.transitionWalk({ now: () => deployedAt }, 'current', 'CONTROL_DB'),
			false
		);
		await prepareTransitions(
			server.transitionWalk({ now: () => deployedAt }),
			false
		);
		await server.deployCurrent();
		const target = server.transitionWalk({}, 'current', 'CONTROL_DB').database
			.id;
		const incomplete = server.transitionWalk({
			now: () => deployedAt,
			beforeContract: async (id) => {
				if (id !== 'control-database-split') {
					return;
				}
				await transferControlDatabase({
					api: d1QueryApi(server),
					source: stagedDeploymentDatabaseId,
					target,
					now: deployedAt,
					validateKeys: () =>
						Promise.reject(new Error('Interrupted before readiness'))
				});
			}
		});
		await expect(completeTransitions(incomplete)).rejects.toThrow(
			'Interrupted before readiness'
		);
		await expect(server.deploymentClient()).rejects.toThrow('503');
		const sharedName = server.artifact.config.control.d1Databases.find(
			(binding) => binding.binding === 'CUPBOARD_DB'
		)?.databaseName;
		const targetName = server.artifact.config.control.d1Databases.find(
			(binding) => binding.binding === 'CONTROL_DB'
		)?.databaseName;
		const api: AuthorityApi = {
			findD1Database: (name) =>
				Promise.resolve(
					name === sharedName
						? stagedDeploymentDatabaseId
						: name === targetName
							? target
							: undefined
				),
			findD1DatabaseName: (id) =>
				Promise.resolve(
					id === stagedDeploymentDatabaseId ? sharedName : targetName
				),
			d1QueryRows: (id, sql) => server.api.d1QueryRows(id, sql),
			findCustomDomain: () => Promise.resolve('cupboard.invalid'),
			listCustomDomains: () => Promise.resolve(['cupboard.invalid']),
			getWorkersDevSubdomain: () => Promise.resolve(undefined),
			getScriptConfiguration: () =>
				Promise.resolve({
					bindings: [
						{
							type: 'd1',
							name: 'CUPBOARD_DB',
							database_id: stagedDeploymentDatabaseId
						},
						{ type: 'd1', name: 'CONTROL_DB', database_id: target }
					],
					cacheEnabled: false,
					crossVersionCache: false
				})
		};
		let credentialReads = 0;
		const expired = () => {
			credentialReads += 1;
			return Promise.reject<string>(new OwnerLoginRequiredError());
		};
		const access = {
			credentialFor: () => ({ get: expired, refresh: expired })
		};
		const world: AuthorityWorld = {
			api,
			ui: {
				...fakeCliUi().ui,
				chooseAccount: () => Promise.resolve(undefined)
			},
			adminAccess: () => access,
			checkAdmin: async (_url, credential) => {
				await credential.get();
			},
			servesCupboard: () => Promise.resolve(true),
			signIn: new BoundSignIn(undefined),
			chooseFirstTenantSlug: () => Promise.resolve(undefined),
			confirmClaim: () => Promise.resolve(false),
			interactive: false
		};
		const plans = {
			agreed: { config: server.artifact.config, domain: 'cupboard.invalid' }
		};
		expect({
			authority: await establishAuthority(plans, world),
			credentialReads
		}).toStrictEqual({
			authority: {
				kind: 'admin',
				admin: {
					issuer: server.issuerUrl,
					subject: 'upgrade-deployment-operator',
					audience: 'upgrade-deployment-client'
				},
				access
			},
			credentialReads: 0
		});
		const readyInterrupted = server.transitionWalk({
			now: () => deployedAt,
			beforeContract: async (id) => {
				if (id !== 'control-database-split') {
					return;
				}
				await transferControlDatabase({
					api: {
						queryRows: (database, sql) => server.api.d1QueryRows(database, sql),
						queryBatch: (database, statements) => {
							if (
								database === stagedDeploymentDatabaseId &&
								statements.some((statement) =>
									(typeof statement === 'string'
										? statement
										: statement.sql
									).startsWith('UPDATE control_database_split SET copied_at')
								)
							) {
								return Promise.reject(new Error('Interrupted after readiness'));
							}
							return server.api.d1QueryBatch(database, statements);
						}
					},
					source: stagedDeploymentDatabaseId,
					target,
					now: deployedAt,
					validateKeys: () => server.validateControlDatabase()
				});
			}
		});
		await expect(completeTransitions(readyInterrupted)).rejects.toThrow(
			'Interrupted after readiness'
		);
		const control = await server.controlDatabase();
		const shared = await server.database();
		const copied = await shared
			.prepare(
				"SELECT copied_at FROM control_database_split WHERE id = 'current'"
			)
			.first<{ copied_at: string | null }>();
		expect({
			authority: await establishAuthority(plans, world),
			credentialReads,
			ready: await control
				.prepare(
					"SELECT state FROM control_database_ready WHERE id = 'current'"
				)
				.first(),
			copied: { copied_at: copied?.copied_at ?? undefined }
		}).toStrictEqual({
			authority: {
				kind: 'admin',
				admin: {
					issuer: server.issuerUrl,
					subject: 'upgrade-deployment-operator',
					audience: 'upgrade-deployment-client'
				},
				access
			},
			credentialReads: 0,
			ready: { state: 'ready' },
			copied: { copied_at: undefined }
		});
		await completeTransitions(server.transitionWalk({ now: () => deployedAt }));
		await expect(establishAuthority(plans, world)).rejects.toBeInstanceOf(
			AdminTokenRequiredError
		);
		expect(credentialReads).toBe(1);
	} finally {
		await server.stop();
	}
});
