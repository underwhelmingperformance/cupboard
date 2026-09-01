import {
	deploymentStateIdSchema,
	deploymentTransitionIdSchema
} from './deployment.ts';
import {
	type D1MigrationId,
	d1MigrationIdSchema,
	d1SchemaStateIdSchema,
	type DataMigrationBudget,
	type DataMigrationDescriptor,
	dataMigrationIdSchema,
	dataMigrationRevisionSchema,
	deploymentBootstrapTransitionIdSchema,
	type DeploymentCheckDescriptor,
	type DeploymentCheckId,
	deploymentCheckIdSchema,
	type DeploymentManifestBody,
	type DeploymentState,
	type DurableObjectMigrationId,
	durableObjectMigrationIdSchema,
	type ForwardDeploymentTransition,
	legacyRuntimeFingerprintIdSchema,
	migrationFailureCodeSchema,
	type RuntimeDeployment,
	type RuntimeStage,
	type RuntimeStageId,
	runtimeStageIdSchema,
	type StructuralMigration,
	writerEpochSchema
} from './deployment-manifest.ts';

const legacyD1 = d1SchemaStateIdSchema.parse('legacy-0019');
const expandedD1 = d1SchemaStateIdSchema.parse('expanded-0023');
const compatibleD1 = d1SchemaStateIdSchema.parse('compatible-0026');
const contractedD1 = d1SchemaStateIdSchema.parse('contracted-0031');

export const cacheMigrationFoundationStage = runtimeStageIdSchema.parse(
	'cache-migration-foundation'
);
export const cacheDataMigrationsStage = runtimeStageIdSchema.parse(
	'cache-data-migrations'
);
export const cacheStorageContractStage = runtimeStageIdSchema.parse(
	'cache-storage-contract'
);

export const cacheCatalogueMigration = dataMigrationIdSchema.parse(
	'cache-catalogue-reconciliation'
);
export const cacheR2MetadataMigration = dataMigrationIdSchema.parse(
	'cache-r2-generation-metadata'
);
export const cacheRetentionMigration = dataMigrationIdSchema.parse(
	'cache-retention-properties'
);
export const cacheLocalContractMigration = dataMigrationIdSchema.parse(
	'cache-local-storage-contract'
);

const legacyRuntime = legacyRuntimeFingerprintIdSchema.parse(
	'cache-identity-predecessor'
);
export const cacheWriterEpoch = writerEpochSchema.parse('cache-lifecycle-v1');
export const legacyCacheWriterEpoch = writerEpochSchema.parse(
	'legacy-cache-identity'
);

const additiveCeiling = durableObjectMigrationIdSchema.parse(
	'0049_cache_retention_migration_rules'
);
const contractCeiling = durableObjectMigrationIdSchema.parse(
	'0052_cache_access_triggers'
);
export const cachePredecessorLocalMigrationCeiling =
	durableObjectMigrationIdSchema.parse('0041_pending_upload_recorded_verdict');

export interface CacheDeploymentChecks {
	readonly foundationObserved: DeploymentCheckId;
	readonly catalogueComplete: DeploymentCheckId;
	readonly compatibleD1: DeploymentCheckId;
	readonly writersDrained: DeploymentCheckId;
	readonly dataRuntimeObserved: DeploymentCheckId;
	readonly r2Complete: DeploymentCheckId;
	readonly retentionComplete: DeploymentCheckId;
	readonly repairsEmpty: DeploymentCheckId;
	readonly d1RecoveryRecorded: DeploymentCheckId;
	readonly contractedD1: DeploymentCheckId;
	readonly compatibilityClosed: DeploymentCheckId;
	readonly contractRuntimeObserved: DeploymentCheckId;
	readonly localContractsComplete: DeploymentCheckId;
	readonly terminal: DeploymentCheckId;
}

export const cacheDeploymentChecks: CacheDeploymentChecks = {
	foundationObserved: deploymentCheckIdSchema.parse(
		'foundation-runtime-observed'
	),
	catalogueComplete: deploymentCheckIdSchema.parse('cache-catalogue-complete'),
	compatibleD1: deploymentCheckIdSchema.parse('compatible-d1-verified'),
	writersDrained: deploymentCheckIdSchema.parse('legacy-writers-drained'),
	dataRuntimeObserved: deploymentCheckIdSchema.parse(
		'data-migration-runtime-observed'
	),
	r2Complete: deploymentCheckIdSchema.parse('r2-metadata-complete'),
	retentionComplete: deploymentCheckIdSchema.parse(
		'retention-migration-complete'
	),
	repairsEmpty: deploymentCheckIdSchema.parse('projection-repairs-empty'),
	d1RecoveryRecorded: deploymentCheckIdSchema.parse(
		'd1-recovery-point-recorded'
	),
	contractedD1: deploymentCheckIdSchema.parse('contracted-d1-verified'),
	compatibilityClosed: deploymentCheckIdSchema.parse(
		'legacy-r2-compatibility-closed'
	),
	contractRuntimeObserved: deploymentCheckIdSchema.parse(
		'contract-runtime-observed'
	),
	localContractsComplete: deploymentCheckIdSchema.parse(
		'local-contracts-complete'
	),
	terminal: deploymentCheckIdSchema.parse('cache-release-terminal')
};

const migrationBudget: DataMigrationBudget = {
	maximumStatements: 64,
	maximumRowsReturned: 512,
	maximumReportedD1RowsRead: 4096,
	maximumRowsWritten: 512,
	maximumParametersPerStatement: 100,
	maximumR2Operations: 128,
	maximumR2BytesRead: 8 * 1024 * 1024,
	maximumR2BytesWritten: 8 * 1024 * 1024
};

function dataMigration(
	id: DataMigrationDescriptor['id'],
	runtimeStage: RuntimeStageId,
	d1Schemas: DataMigrationDescriptor['d1Schemas'],
	source: DataMigrationDescriptor['source'],
	target: DataMigrationDescriptor['target']
): DataMigrationDescriptor {
	return {
		id,
		implementationRevision: dataMigrationRevisionSchema.parse(
			`implementation-${id}`
		),
		source,
		target,
		tenantStatuses: ['active', 'suspended', 'offboarding'],
		runtimeStage,
		d1Schemas,
		budget: migrationBudget,
		retryableFailures: [migrationFailureCodeSchema.parse('tenant-busy')],
		terminalFailures: [
			migrationFailureCodeSchema.parse('migration-invariant-failed')
		]
	};
}

function registeredRuntime(stage: RuntimeStageId): RuntimeDeployment {
	return { kind: 'registered', stage };
}

function state(
	id: string,
	overrides: Partial<DeploymentState> = {}
): DeploymentState {
	return {
		id: deploymentStateIdSchema.parse(id),
		d1Schema: expandedD1,
		tenantRuntime: registeredRuntime(cacheMigrationFoundationStage),
		controlRuntime: registeredRuntime(cacheMigrationFoundationStage),
		localSchema: {
			runtimeCeiling: additiveCeiling,
			fleetState: 'migrating'
		},
		writerEpoch: cacheWriterEpoch,
		representations: {
			catalogue: 'dual',
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
			tenantLocalContractAdmission: 'not-required'
		},
		recoveryPoints: {
			d1: 'absent',
			durableObjectFleet: 'absent'
		},
		...overrides
	};
}

function transitionBase(from: string, to: string) {
	return {
		id: deploymentTransitionIdSchema.parse(`${from}-to-${to}`),
		from: deploymentStateIdSchema.parse(from),
		to: deploymentStateIdSchema.parse(to),
		checks: []
	};
}

function dataMigrationTransition(
	from: string,
	to: string,
	migration: DataMigrationDescriptor['id']
): ForwardDeploymentTransition {
	return { ...transitionBase(from, to), kind: 'run-data-migration', migration };
}

function applyD1Transition(
	from: string,
	to: string,
	migrations: readonly D1MigrationId[]
): ForwardDeploymentTransition {
	return { ...transitionBase(from, to), kind: 'apply-d1', migrations };
}

function deployRuntimeTransition(
	from: string,
	to: string,
	stage: RuntimeStageId
): ForwardDeploymentTransition {
	return { ...transitionBase(from, to), kind: 'deploy-runtime-stage', stage };
}

function fenceTransition(
	from: string,
	to: string,
	fence: 'd1-application-writes' | 'retention-administration',
	value: 'open' | 'closed'
): ForwardDeploymentTransition {
	return {
		...transitionBase(from, to),
		kind: 'set-deployment-fence',
		fence,
		value
	};
}

function simpleTransition(
	from: string,
	to: string,
	kind: 'close-r2-compatibility-window' | 'resolve-repair-intents' | 'verify',
	transitionChecks: readonly DeploymentCheckId[] = []
): ForwardDeploymentTransition {
	if (kind === 'resolve-repair-intents') {
		return {
			...transitionBase(from, to),
			kind,
			repairClass: 'cross-store-projection',
			checks: transitionChecks
		};
	}

	return { ...transitionBase(from, to), kind, checks: transitionChecks };
}

function recoveryPointTransition(
	from: string,
	to: string,
	storage: 'd1' | 'durable-object-fleet'
): ForwardDeploymentTransition {
	return {
		...transitionBase(from, to),
		kind: 'record-recovery-point',
		storage
	};
}

function localAdmissionTransition(
	from: string,
	to: string,
	value: 'not-required' | 'required'
): ForwardDeploymentTransition {
	return {
		...transitionBase(from, to),
		kind: 'set-tenant-local-contract-admission',
		value
	};
}

function writerDrainTransition(
	from: string,
	to: string
): ForwardDeploymentTransition {
	return {
		...transitionBase(from, to),
		kind: 'drain-writer-epoch',
		before: cacheWriterEpoch
	};
}

function checkDescriptors(): DeploymentCheckDescriptor[] {
	return [
		cacheDeploymentChecks.foundationObserved,
		cacheDeploymentChecks.catalogueComplete,
		cacheDeploymentChecks.compatibleD1,
		cacheDeploymentChecks.writersDrained,
		cacheDeploymentChecks.dataRuntimeObserved,
		cacheDeploymentChecks.r2Complete,
		cacheDeploymentChecks.retentionComplete,
		cacheDeploymentChecks.repairsEmpty,
		cacheDeploymentChecks.d1RecoveryRecorded,
		cacheDeploymentChecks.contractedD1,
		cacheDeploymentChecks.compatibilityClosed,
		cacheDeploymentChecks.contractRuntimeObserved,
		cacheDeploymentChecks.localContractsComplete,
		cacheDeploymentChecks.terminal
	].map((id) => ({ id }));
}

function runtimeStages(): RuntimeStage[] {
	return [
		{
			id: cacheMigrationFoundationStage,
			localMigrationCeiling: additiveCeiling,
			supportedD1Schemas: [expandedD1, compatibleD1]
		},
		{
			id: cacheDataMigrationsStage,
			localMigrationCeiling: additiveCeiling,
			supportedD1Schemas: [compatibleD1, contractedD1]
		},
		{
			id: cacheStorageContractStage,
			localMigrationCeiling: contractCeiling,
			supportedD1Schemas: [contractedD1]
		}
	];
}

export interface CacheDeploymentStructuralMigrations {
	readonly d1: readonly StructuralMigration[];
	readonly durableObject: readonly StructuralMigration[];
}

/**
 * Builds the checked release sequence around the exact structural migration
 * bytes embedded in one artifact.
 */
export function cacheDeploymentManifest(
	migrations: CacheDeploymentStructuralMigrations
): DeploymentManifestBody {
	const legacySource: DeploymentState = state('legacy-source', {
		d1Schema: legacyD1,
		tenantRuntime: { kind: 'legacy', fingerprint: legacyRuntime },
		controlRuntime: { kind: 'legacy', fingerprint: legacyRuntime },
		localSchema: {
			runtimeCeiling: cachePredecessorLocalMigrationCeiling,
			fleetState: 'unreconciled'
		},
		writerEpoch: legacyCacheWriterEpoch,
		representations: {
			catalogue: 'legacy',
			r2Metadata: 'legacy',
			retention: 'legacy',
			legacyR2: {
				writes: 'enabled',
				readFallback: 'enabled',
				deletion: 'forbidden'
			}
		}
	});
	const foundationReady: DeploymentState = state('foundation-ready');
	const catalogueNative: DeploymentState = state('catalogue-native', {
		localSchema: { runtimeCeiling: additiveCeiling, fleetState: 'complete' },
		representations: {
			...foundationReady.representations,
			catalogue: 'native'
		}
	});
	const compatibleD1State: DeploymentState = state('compatible-d1', {
		d1Schema: compatibleD1,
		localSchema: catalogueNative.localSchema,
		representations: catalogueNative.representations
	});
	const writersDrained: DeploymentState = {
		...compatibleD1State,
		id: deploymentStateIdSchema.parse('writers-drained')
	};
	const dataRuntime: DeploymentState = state('data-runtime', {
		d1Schema: compatibleD1,
		tenantRuntime: registeredRuntime(cacheDataMigrationsStage),
		controlRuntime: registeredRuntime(cacheDataMigrationsStage),
		localSchema: writersDrained.localSchema,
		representations: writersDrained.representations
	});
	const retentionFenced: DeploymentState = {
		...dataRuntime,
		id: deploymentStateIdSchema.parse('retention-fenced'),
		fences: {
			...dataRuntime.fences,
			retentionAdministration: 'closed'
		}
	};
	const r2Native: DeploymentState = {
		...retentionFenced,
		id: deploymentStateIdSchema.parse('r2-native'),
		representations: {
			...retentionFenced.representations,
			r2Metadata: 'native'
		}
	};
	const retentionNative: DeploymentState = {
		...r2Native,
		id: deploymentStateIdSchema.parse('retention-native'),
		representations: {
			...r2Native.representations,
			retention: 'native'
		}
	};
	const retentionOpen: DeploymentState = {
		...retentionNative,
		id: deploymentStateIdSchema.parse('retention-open'),
		fences: {
			...retentionNative.fences,
			retentionAdministration: 'open'
		}
	};
	const d1Fenced: DeploymentState = {
		...retentionOpen,
		id: deploymentStateIdSchema.parse('d1-fenced'),
		fences: {
			...retentionOpen.fences,
			d1ApplicationWrites: 'closed'
		}
	};
	const repairsResolved: DeploymentState = {
		...d1Fenced,
		id: deploymentStateIdSchema.parse('repairs-resolved')
	};
	const d1RecoveryRecorded: DeploymentState = {
		...repairsResolved,
		id: deploymentStateIdSchema.parse('d1-recovery-recorded'),
		recoveryPoints: {
			...repairsResolved.recoveryPoints,
			d1: 'recorded'
		}
	};
	const d1Contracted: DeploymentState = {
		...d1RecoveryRecorded,
		id: deploymentStateIdSchema.parse('d1-contracted'),
		d1Schema: contractedD1
	};
	const d1Verified: DeploymentState = {
		...d1Contracted,
		id: deploymentStateIdSchema.parse('d1-verified')
	};
	const r2WindowClosed: DeploymentState = {
		...d1Verified,
		id: deploymentStateIdSchema.parse('r2-window-closed'),
		representations: {
			...d1Verified.representations,
			legacyR2: {
				writes: 'disabled',
				readFallback: 'disabled',
				deletion: 'eligible'
			}
		}
	};
	const localAdmissionRequired: DeploymentState = {
		...r2WindowClosed,
		id: deploymentStateIdSchema.parse('local-admission-required'),
		fences: {
			...r2WindowClosed.fences,
			tenantLocalContractAdmission: 'required'
		}
	};
	const contractRuntime: DeploymentState = {
		...localAdmissionRequired,
		id: deploymentStateIdSchema.parse('contract-runtime'),
		tenantRuntime: registeredRuntime(cacheStorageContractStage),
		controlRuntime: registeredRuntime(cacheStorageContractStage),
		localSchema: { runtimeCeiling: contractCeiling, fleetState: 'migrating' }
	};
	const localContractsComplete: DeploymentState = {
		...contractRuntime,
		id: deploymentStateIdSchema.parse('local-contracts-complete'),
		localSchema: { runtimeCeiling: contractCeiling, fleetState: 'complete' }
	};
	const doRecoveryRecorded: DeploymentState = {
		...localContractsComplete,
		id: deploymentStateIdSchema.parse('do-recovery-recorded'),
		recoveryPoints: {
			d1: 'recorded',
			durableObjectFleet: 'complete'
		}
	};
	const appWritesOpen: DeploymentState = {
		...doRecoveryRecorded,
		id: deploymentStateIdSchema.parse('application-writes-open'),
		fences: {
			...doRecoveryRecorded.fences,
			d1ApplicationWrites: 'open'
		}
	};
	const cacheReleaseComplete: DeploymentState = {
		...appWritesOpen,
		id: deploymentStateIdSchema.parse('cache-release-complete')
	};
	const states: DeploymentState[] = [
		legacySource,
		foundationReady,
		catalogueNative,
		compatibleD1State,
		writersDrained,
		dataRuntime,
		retentionFenced,
		r2Native,
		retentionNative,
		retentionOpen,
		d1Fenced,
		repairsResolved,
		d1RecoveryRecorded,
		d1Contracted,
		d1Verified,
		r2WindowClosed,
		localAdmissionRequired,
		contractRuntime,
		localContractsComplete,
		doRecoveryRecorded,
		appWritesOpen,
		cacheReleaseComplete
	];

	const forwardTransitions: ForwardDeploymentTransition[] = [
		dataMigrationTransition(
			'foundation-ready',
			'catalogue-native',
			cacheCatalogueMigration
		),
		applyD1Transition('catalogue-native', 'compatible-d1', [
			d1MigrationIdSchema.parse('0024_cache_access_contract_assertions.sql'),
			d1MigrationIdSchema.parse('0025_cache_access_compatible_contract.sql'),
			d1MigrationIdSchema.parse('0026_cache_incarnation_expand.sql')
		]),
		writerDrainTransition('compatible-d1', 'writers-drained'),
		deployRuntimeTransition(
			'writers-drained',
			'data-runtime',
			cacheDataMigrationsStage
		),
		fenceTransition(
			'data-runtime',
			'retention-fenced',
			'retention-administration',
			'closed'
		),
		dataMigrationTransition(
			'retention-fenced',
			'r2-native',
			cacheR2MetadataMigration
		),
		dataMigrationTransition(
			'r2-native',
			'retention-native',
			cacheRetentionMigration
		),
		fenceTransition(
			'retention-native',
			'retention-open',
			'retention-administration',
			'open'
		),
		fenceTransition(
			'retention-open',
			'd1-fenced',
			'd1-application-writes',
			'closed'
		),
		simpleTransition('d1-fenced', 'repairs-resolved', 'resolve-repair-intents'),
		recoveryPointTransition('repairs-resolved', 'd1-recovery-recorded', 'd1'),
		applyD1Transition('d1-recovery-recorded', 'd1-contracted', [
			d1MigrationIdSchema.parse(
				'0027_cache_generation_contract_assertions.sql'
			),
			d1MigrationIdSchema.parse(
				'0028_drop_cache_credential_lifecycle_guard.sql'
			),
			d1MigrationIdSchema.parse('0029_cache_identity_contract.sql'),
			d1MigrationIdSchema.parse('0030_cache_credential_lifecycle_guard.sql'),
			d1MigrationIdSchema.parse('0031_cache_lifecycle_lookup_index.sql')
		]),
		simpleTransition('d1-contracted', 'd1-verified', 'verify', [
			cacheDeploymentChecks.contractedD1
		]),
		simpleTransition(
			'd1-verified',
			'r2-window-closed',
			'close-r2-compatibility-window'
		),
		localAdmissionTransition(
			'r2-window-closed',
			'local-admission-required',
			'required'
		),
		deployRuntimeTransition(
			'local-admission-required',
			'contract-runtime',
			cacheStorageContractStage
		),
		dataMigrationTransition(
			'contract-runtime',
			'local-contracts-complete',
			cacheLocalContractMigration
		),
		recoveryPointTransition(
			'local-contracts-complete',
			'do-recovery-recorded',
			'durable-object-fleet'
		),
		fenceTransition(
			'do-recovery-recorded',
			'application-writes-open',
			'd1-application-writes',
			'open'
		),
		simpleTransition(
			'application-writes-open',
			'cache-release-complete',
			'verify'
		)
	];

	return {
		initialState: deploymentStateIdSchema.parse('legacy-source'),
		terminalState: deploymentStateIdSchema.parse('cache-release-complete'),
		states,
		forwardTransitions,
		recoveryTransitions: [],
		bootstrapTransitions: [
			{
				id: deploymentBootstrapTransitionIdSchema.parse(
					'bootstrap-cache-migration-foundation'
				),
				from: deploymentStateIdSchema.parse('legacy-source'),
				to: deploymentStateIdSchema.parse('foundation-ready'),
				kind: 'bootstrap-legacy-runtime',
				sourceFingerprint: legacyRuntime,
				migrations: [
					d1MigrationIdSchema.parse('0020_deployment_ledger.sql'),
					d1MigrationIdSchema.parse('0020a_deployment_runtime_controls.sql'),
					d1MigrationIdSchema.parse('0021_cache_access_expand.sql'),
					d1MigrationIdSchema.parse(
						'0022_cache_access_legacy_write_mirror.sql'
					),
					d1MigrationIdSchema.parse('0023_cache_access_backfill.sql')
				],
				stage: cacheMigrationFoundationStage,
				checks: [cacheDeploymentChecks.foundationObserved]
			}
		],
		legacyRuntimeFingerprints: [
			{
				id: legacyRuntime,
				d1Migration: d1MigrationIdSchema.parse('0019_nar_read_authority.sql'),
				durableObjectMigration: cachePredecessorLocalMigrationCeiling
			}
		],
		runtimeStages: runtimeStages(),
		d1Migrations: migrations.d1,
		durableObjectMigrations: migrations.durableObject,
		dataMigrations: [
			dataMigration(
				cacheCatalogueMigration,
				cacheMigrationFoundationStage,
				[expandedD1],
				'dual',
				'native'
			),
			dataMigration(
				cacheR2MetadataMigration,
				cacheDataMigrationsStage,
				[compatibleD1],
				'dual',
				'native'
			),
			dataMigration(
				cacheRetentionMigration,
				cacheDataMigrationsStage,
				[compatibleD1],
				'dual',
				'native'
			),
			dataMigration(
				cacheLocalContractMigration,
				cacheStorageContractStage,
				[contractedD1],
				'dual',
				'native'
			)
		],
		checks: checkDescriptors()
	};
}

export function d1MigrationId(value: string): D1MigrationId {
	return d1MigrationIdSchema.parse(value);
}

export function durableObjectMigrationId(
	value: string
): DurableObjectMigrationId {
	return durableObjectMigrationIdSchema.parse(value);
}
