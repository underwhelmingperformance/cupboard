import { deploymentStateIdSchema } from '@cupboard/protocol/deployment';
import {
	d1SchemaStateIdSchema,
	type DeploymentManifestBody,
	durableObjectMigrationIdSchema,
	runtimeStageIdSchema,
	writerEpochSchema
} from '@cupboard/protocol/deployment-manifest';

export const testDeploymentManifest: DeploymentManifestBody = {
	initialState: deploymentStateIdSchema.parse('installed'),
	terminalState: deploymentStateIdSchema.parse('installed'),
	states: [
		{
			id: deploymentStateIdSchema.parse('installed'),
			d1Schema: d1SchemaStateIdSchema.parse('installed'),
			tenantRuntime: {
				kind: 'registered',
				stage: runtimeStageIdSchema.parse('installed')
			},
			controlRuntime: {
				kind: 'registered',
				stage: runtimeStageIdSchema.parse('installed')
			},
			localSchema: {
				runtimeCeiling: durableObjectMigrationIdSchema.parse('0000_installed'),
				fleetState: 'complete'
			},
			writerEpoch: writerEpochSchema.parse('installed'),
			representations: {
				catalogue: 'native',
				r2Metadata: 'native',
				retention: 'native',
				legacyR2: {
					writes: 'disabled',
					readFallback: 'disabled',
					deletion: 'eligible'
				}
			},
			fences: {
				d1ApplicationWrites: 'open',
				retentionAdministration: 'open',
				tenantLocalContractAdmission: 'required'
			},
			recoveryPoints: { d1: 'recorded', durableObjectFleet: 'complete' }
		}
	],
	forwardTransitions: [],
	recoveryTransitions: [],
	bootstrapTransitions: [],
	legacyRuntimeFingerprints: [],
	runtimeStages: [
		{
			id: runtimeStageIdSchema.parse('installed'),
			localMigrationCeiling:
				durableObjectMigrationIdSchema.parse('0000_installed'),
			supportedD1Schemas: [d1SchemaStateIdSchema.parse('installed')]
		}
	],
	d1Migrations: [],
	durableObjectMigrations: [
		{
			id: durableObjectMigrationIdSchema.parse('0000_installed'),
			sha256: '0'.repeat(64)
		}
	],
	dataMigrations: [],
	checks: []
};
