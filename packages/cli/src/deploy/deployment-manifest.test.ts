import {
	cacheDeploymentManifest,
	d1MigrationId,
	durableObjectMigrationId
} from '@cupboard/protocol/cache-deployment-manifest';
import {
	deploymentStateIdSchema,
	deploymentTransitionIdSchema
} from '@cupboard/protocol/deployment';
import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.ts';
import {
	deploymentArtifactId,
	deploymentInstanceId,
	deploymentManifestId
} from './deployment-identity.ts';
import {
	bundleSha256Schema,
	cloudflareWorkerVersionTagSchema,
	d1SchemaStateIdSchema,
	deploymentExecutorSha256Schema,
	type DeploymentManifestBody,
	type DeploymentState,
	durableObjectMigrationIdSchema,
	type ForwardDeploymentTransition,
	isoDateSchema,
	runtimeStageIdSchema,
	type StaticDeploymentArtifacts,
	validateDeploymentManifest,
	type WorkerUploadTemplate,
	writerEpochSchema
} from './deployment-manifest.ts';

function state(
	id: string,
	overrides: Partial<DeploymentState> = {}
): DeploymentState {
	return {
		id: deploymentStateIdSchema.parse(id),
		d1Schema: d1SchemaStateIdSchema.parse('expanded'),
		tenantRuntime: {
			kind: 'registered',
			stage: runtimeStageIdSchema.parse('foundation')
		},
		controlRuntime: {
			kind: 'registered',
			stage: runtimeStageIdSchema.parse('foundation')
		},
		localSchema: {
			runtimeCeiling: durableObjectMigrationIdSchema.parse('0040_foundation'),
			fleetState: 'complete'
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
			tenantLocalContractAdmission: 'required'
		},
		recoveryPoints: {
			d1: 'absent',
			durableObjectFleet: 'absent'
		},
		...overrides
	};
}

function verifyTransition(
	from: string,
	to: string,
	id = `${from}-to-${to}`
): ForwardDeploymentTransition {
	return {
		id: deploymentTransitionIdSchema.parse(id),
		from: deploymentStateIdSchema.parse(from),
		to: deploymentStateIdSchema.parse(to),
		kind: 'verify',
		checks: []
	};
}

function closeD1FenceTransition(
	from: string,
	to: string
): ForwardDeploymentTransition {
	return {
		id: deploymentTransitionIdSchema.parse(`${from}-to-${to}`),
		from: deploymentStateIdSchema.parse(from),
		to: deploymentStateIdSchema.parse(to),
		kind: 'set-deployment-fence',
		fence: 'd1-application-writes',
		value: 'closed',
		checks: []
	};
}

function manifest(
	states: readonly DeploymentState[],
	forwardTransitions: readonly ForwardDeploymentTransition[] = []
): DeploymentManifestBody {
	const initial = states[0];
	const terminal = states.at(-1);

	if (initial === undefined || terminal === undefined) {
		throw new Error('A test manifest requires at least one state');
	}

	return {
		initialState: initial.id,
		terminalState: terminal.id,
		states,
		forwardTransitions,
		recoveryTransitions: [],
		bootstrapTransitions: [],
		legacyRuntimeFingerprints: [],
		runtimeStages: [
			{
				id: runtimeStageIdSchema.parse('foundation'),
				localMigrationCeiling:
					durableObjectMigrationIdSchema.parse('0040_foundation'),
				supportedD1Schemas: [d1SchemaStateIdSchema.parse('expanded')]
			}
		],
		d1Migrations: [],
		durableObjectMigrations: [
			{
				id: durableObjectMigrationIdSchema.parse('0040_foundation'),
				sha256: 'f'.repeat(64)
			}
		],
		dataMigrations: [],
		checks: []
	};
}

function uploadTemplate(bundleHash: string): WorkerUploadTemplate {
	return {
		bundleHash: bundleSha256Schema.parse(bundleHash),
		versionTag: cloudflareWorkerVersionTagSchema.parse(
			'cache-lifecycle-foundation'
		),
		mainModule: 'worker.js',
		compatibilityDate: isoDateSchema.parse('2026-09-01'),
		compatibilityFlags: ['nodejs_compat'],
		bindings: [{ name: 'CUPBOARD_DB', type: 'd1' }]
	};
}

describe('canonicalJson', () => {
	it('sorts object keys recursively and preserves array order', () => {
		expect(canonicalJson({ z: [{ b: 2, a: 1 }, 3], a: { d: 4, c: 3 } })).toBe(
			'{"a":{"c":3,"d":4},"z":[{"a":1,"b":2},3]}'
		);
	});

	it('rejects values which JSON cannot represent', () => {
		expect(() => canonicalJson(undefined)).toThrow(
			'The value is not representable as canonical JSON'
		);
	});
});

describe('validateDeploymentManifest', () => {
	it('accepts the checked cache release sequence', () => {
		const d1 = [
			'0019_nar_read_authority.sql',
			'0020_deployment_ledger.sql',
			'0020a_deployment_runtime_controls.sql',
			'0021_cache_access_expand.sql',
			'0022_cache_access_legacy_write_mirror.sql',
			'0023_cache_access_backfill.sql',
			'0024_cache_access_contract_assertions.sql',
			'0025_cache_access_compatible_contract.sql',
			'0026_cache_incarnation_expand.sql',
			'0027_cache_generation_contract_assertions.sql',
			'0028_drop_cache_credential_lifecycle_guard.sql',
			'0029_cache_identity_contract.sql',
			'0030_cache_credential_lifecycle_guard.sql',
			'0031_cache_lifecycle_lookup_index.sql',
			'0032_chemical_silver_surfer.sql',
			'0032a_suspend_cache_credential_lifecycle_guard.sql',
			'0033_parallel_leo.sql',
			'0034_abnormal_the_stranger.sql',
			'0034a_restore_cache_credential_lifecycle_guard.sql',
			'0035_managed_group_access_transition.sql',
			'0036_managed_group_access_worklist.sql'
		].map((id) => ({ id: d1MigrationId(id), sha256: '1'.repeat(64) }));
		const durableObject = [
			'0041_pending_upload_recorded_verdict',
			'0049_cache_retention_migration_rules',
			'0056_small_longshot',
			'0057_managed_group_single_view'
		].map((id) => ({
			id: durableObjectMigrationId(id),
			sha256: '2'.repeat(64)
		}));

		expect(() => {
			validateDeploymentManifest(
				cacheDeploymentManifest({ d1, durableObject })
			);
		}).not.toThrow();
	});

	it('accepts a linear manifest whose transitions have their declared effects', () => {
		const before = state('before', {
			fences: {
				d1ApplicationWrites: 'open',
				retentionAdministration: 'open',
				tenantLocalContractAdmission: 'required'
			}
		});
		const after = state('after', {
			fences: {
				d1ApplicationWrites: 'closed',
				retentionAdministration: 'open',
				tenantLocalContractAdmission: 'required'
			}
		});
		const closeFence = closeD1FenceTransition('before', 'after');

		expect(() => {
			validateDeploymentManifest(manifest([before, after], [closeFence]));
		}).not.toThrow();
	});

	it('rejects a transition which changes an undeclared state fact', () => {
		const before = state('before');
		const after = state('after', {
			d1Schema: d1SchemaStateIdSchema.parse('contracted'),
			fences: {
				d1ApplicationWrites: 'closed',
				retentionAdministration: 'open',
				tenantLocalContractAdmission: 'required'
			}
		});
		const closeFence = closeD1FenceTransition('before', 'after');

		expect(() => {
			validateDeploymentManifest(manifest([before, after], [closeFence]));
		}).toThrow('changes facts outside set-deployment-fence');
	});

	it('rejects multiple forward successors', () => {
		const before = state('before');
		const after = state('after');
		const other = state('other');

		expect(() => {
			validateDeploymentManifest({
				...manifest([before, after]),
				states: [before, after, other],
				forwardTransitions: [
					verifyTransition('before', 'after'),
					verifyTransition('before', 'other', 'other-transition')
				]
			});
		}).toThrow('has more than one forward successor');
	});

	it('requires tenant-local admission in the terminal state', () => {
		const terminal = state('terminal', {
			fences: {
				d1ApplicationWrites: 'open',
				retentionAdministration: 'open',
				tenantLocalContractAdmission: 'not-required'
			}
		});

		expect(() => {
			validateDeploymentManifest(manifest([terminal]));
		}).toThrow('must retain tenant-local contract admission');
	});
});

describe('deployment identities', () => {
	it('keeps the artifact identity static and binds the instance to topology', () => {
		const body = manifest([state('installed')]);
		const manifestId = deploymentManifestId(body);
		const artifacts: StaticDeploymentArtifacts = {
			manifestId,
			deploymentExecutorHash: deploymentExecutorSha256Schema.parse(
				'1'.repeat(64)
			),
			tenant: uploadTemplate('2'.repeat(64)),
			control: uploadTemplate('3'.repeat(64))
		};
		const artifactId = deploymentArtifactId(artifacts);
		const first = deploymentInstanceId(artifactId, {
			accountId: 'account-a',
			tenantScript: 'cupboard-tenant',
			controlScript: 'cupboard-control',
			resources: { database: 'database-a' }
		});
		const second = deploymentInstanceId(artifactId, {
			accountId: 'account-a',
			tenantScript: 'cupboard-tenant',
			controlScript: 'cupboard-control',
			resources: { database: 'database-b' }
		});

		expect(artifactId).toMatch(/^[\da-f]{64}$/);
		expect(manifestId).toMatch(/^[\da-f]{64}$/);
		expect(first === second).toBe(false);
	});
});
