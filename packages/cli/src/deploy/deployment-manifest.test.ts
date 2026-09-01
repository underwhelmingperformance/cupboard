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
	type BrandedString,
	deploymentContentId,
	type DeploymentManifestBody,
	type DeploymentState,
	type ForwardDeploymentTransition,
	type StaticDeploymentArtifacts,
	validateDeploymentManifest,
	type WorkerUploadTemplate
} from './deployment-manifest.ts';

function branded<Name extends string>(value: string): BrandedString<Name> {
	return value as BrandedString<Name>;
}

function state(
	id: string,
	overrides: Partial<DeploymentState> = {}
): DeploymentState {
	return {
		id: deploymentStateIdSchema.parse(id),
		d1Schema: branded('expanded'),
		tenantRuntime: { kind: 'registered', stage: branded('foundation') },
		controlRuntime: { kind: 'registered', stage: branded('foundation') },
		localSchema: {
			runtimeCeiling: branded('0040_foundation'),
			fleetState: 'complete'
		},
		writerEpoch: branded('cache-lifecycle-v1'),
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

function transition(
	from: string,
	to: string,
	overrides: Partial<ForwardDeploymentTransition> = {}
): ForwardDeploymentTransition {
	return {
		id: deploymentTransitionIdSchema.parse(`${from}-to-${to}`),
		from: deploymentStateIdSchema.parse(from),
		to: deploymentStateIdSchema.parse(to),
		kind: 'verify',
		checks: [],
		...overrides
	} as ForwardDeploymentTransition;
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
		runtimeStages: [],
		d1Migrations: [],
		durableObjectMigrations: [],
		dataMigrations: [],
		checks: []
	};
}

function uploadTemplate(bundleHash: string): WorkerUploadTemplate {
	return {
		bundleHash: deploymentContentId(bundleHash, 'BundleSha256'),
		versionTag: branded('cache-lifecycle-foundation'),
		mainModule: 'worker.js',
		compatibilityDate: branded('2026-09-01'),
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
		const closeFence = transition('before', 'after', {
			kind: 'set-deployment-fence',
			fence: 'd1-application-writes',
			value: 'closed'
		});

		expect(() => {
			validateDeploymentManifest(manifest([before, after], [closeFence]));
		}).not.toThrow();
	});

	it('rejects a transition which changes an undeclared state fact', () => {
		const before = state('before');
		const after = state('after', {
			d1Schema: branded('contracted'),
			fences: {
				d1ApplicationWrites: 'closed',
				retentionAdministration: 'open',
				tenantLocalContractAdmission: 'required'
			}
		});
		const closeFence = transition('before', 'after', {
			kind: 'set-deployment-fence',
			fence: 'd1-application-writes',
			value: 'closed'
		});

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
					transition('before', 'after'),
					transition('before', 'other', {
						id: deploymentTransitionIdSchema.parse('other-transition')
					})
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
			deploymentExecutorHash: deploymentContentId(
				'1'.repeat(64),
				'DeploymentExecutorSha256'
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
