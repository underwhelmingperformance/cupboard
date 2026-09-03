import { z } from 'zod';

import { canonicalJson } from './canonical-json.ts';
import {
	type DeploymentArtifactId,
	deploymentArtifactIdSchema,
	type DeploymentInstanceId,
	type DeploymentManifestId,
	type DeploymentStateId,
	deploymentStateIdSchema,
	type DeploymentTransitionId,
	deploymentTransitionIdSchema
} from './deployment.ts';

export type {
	DeploymentArtifactId,
	DeploymentInstanceId,
	DeploymentManifestId,
	DeploymentStateId,
	DeploymentTransitionId
} from './deployment.ts';

const manifestIdentifierSchema = z.string().min(1).max(160);

export const deploymentRecoveryTransitionIdSchema =
	manifestIdentifierSchema.brand('DeploymentRecoveryTransitionId');
export type DeploymentRecoveryTransitionId = z.infer<
	typeof deploymentRecoveryTransitionIdSchema
>;
export const deploymentCheckIdSchema =
	manifestIdentifierSchema.brand('DeploymentCheckId');
export type DeploymentCheckId = z.infer<typeof deploymentCheckIdSchema>;
export const d1MigrationIdSchema =
	manifestIdentifierSchema.brand('D1MigrationId');
export type D1MigrationId = z.infer<typeof d1MigrationIdSchema>;
export const durableObjectMigrationIdSchema = manifestIdentifierSchema.brand(
	'DurableObjectMigrationId'
);
export type DurableObjectMigrationId = z.infer<
	typeof durableObjectMigrationIdSchema
>;
export const dataMigrationIdSchema =
	manifestIdentifierSchema.brand('DataMigrationId');
export type DataMigrationId = z.infer<typeof dataMigrationIdSchema>;
export const runtimeStageIdSchema =
	manifestIdentifierSchema.brand('RuntimeStageId');
export type RuntimeStageId = z.infer<typeof runtimeStageIdSchema>;
export const legacyRuntimeFingerprintIdSchema = manifestIdentifierSchema.brand(
	'LegacyRuntimeFingerprintId'
);
export type LegacyRuntimeFingerprintId = z.infer<
	typeof legacyRuntimeFingerprintIdSchema
>;
export const d1SchemaStateIdSchema =
	manifestIdentifierSchema.brand('D1SchemaStateId');
export type D1SchemaStateId = z.infer<typeof d1SchemaStateIdSchema>;
export const writerEpochSchema = manifestIdentifierSchema.brand('WriterEpoch');
export type WriterEpoch = z.infer<typeof writerEpochSchema>;
export const deploymentBootstrapTransitionIdSchema =
	manifestIdentifierSchema.brand('DeploymentBootstrapTransitionId');
export type DeploymentBootstrapTransitionId = z.infer<
	typeof deploymentBootstrapTransitionIdSchema
>;
export const deploymentExecutorSha256Schema = z
	.string()
	.regex(/^[\da-f]{64}$/)
	.brand('DeploymentExecutorSha256');
export type DeploymentExecutorSha256 = z.infer<
	typeof deploymentExecutorSha256Schema
>;
export const bundleSha256Schema = z
	.string()
	.regex(/^[\da-f]{64}$/)
	.brand('BundleSha256');
export type BundleSha256 = z.infer<typeof bundleSha256Schema>;
export const cloudflareWorkerVersionTagSchema = z
	.string()
	.min(1)
	.max(160)
	.brand('CloudflareWorkerVersionTag');
export type CloudflareWorkerVersionTag = z.infer<
	typeof cloudflareWorkerVersionTagSchema
>;
export const isoDateSchema = z.iso.date().brand('IsoDate');
export type IsoDate = z.infer<typeof isoDateSchema>;
export const dataMigrationRevisionSchema = manifestIdentifierSchema.brand(
	'DataMigrationRevision'
);
export type DataMigrationRevision = z.infer<typeof dataMigrationRevisionSchema>;
export const migrationFailureCodeSchema = manifestIdentifierSchema.brand(
	'MigrationFailureCode'
);
export type MigrationFailureCode = z.infer<typeof migrationFailureCodeSchema>;
export const dataMigrationCheckpointIdSchema = manifestIdentifierSchema.brand(
	'DataMigrationCheckpointId'
);
export type DataMigrationCheckpointId = z.infer<
	typeof dataMigrationCheckpointIdSchema
>;
export const dataMigrationCursorFormatIdSchema = manifestIdentifierSchema.brand(
	'DataMigrationCursorFormatId'
);
export type DataMigrationCursorFormatId = z.infer<
	typeof dataMigrationCursorFormatIdSchema
>;
export const dataMigrationCompatibilityIdSchema =
	manifestIdentifierSchema.brand('DataMigrationCompatibilityId');
export type DataMigrationCompatibilityId = z.infer<
	typeof dataMigrationCompatibilityIdSchema
>;
export const registeredForwardRepairIdSchema = manifestIdentifierSchema.brand(
	'RegisteredForwardRepairId'
);
export type RegisteredForwardRepairId = z.infer<
	typeof registeredForwardRepairIdSchema
>;
export const d1RecoveryEnvelopeIdSchema = manifestIdentifierSchema.brand(
	'D1RecoveryEnvelopeId'
);
export type D1RecoveryEnvelopeId = z.infer<typeof d1RecoveryEnvelopeIdSchema>;

export type RuntimeDeployment =
	| { readonly kind: 'registered'; readonly stage: RuntimeStageId }
	| {
			readonly kind: 'legacy';
			readonly fingerprint: LegacyRuntimeFingerprintId;
	  };

export interface DeploymentState {
	readonly id: DeploymentStateId;
	readonly d1Schema: D1SchemaStateId;
	readonly tenantRuntime: RuntimeDeployment;
	readonly controlRuntime: RuntimeDeployment;
	readonly localSchema: {
		readonly runtimeCeiling: DurableObjectMigrationId;
		readonly fleetState: 'unreconciled' | 'migrating' | 'complete';
	};
	readonly writerEpoch: WriterEpoch;
	readonly representations: {
		readonly catalogue: 'legacy' | 'dual' | 'native';
		readonly r2Metadata: 'legacy' | 'dual' | 'native';
		readonly retention: 'legacy' | 'dual' | 'native';
		readonly legacyR2: {
			readonly writes: 'enabled' | 'disabled';
			readonly readFallback: 'enabled' | 'disabled';
			readonly deletion: 'forbidden' | 'eligible';
		};
	};
	readonly fences: {
		readonly d1ApplicationWrites: 'open' | 'closed';
		readonly retentionAdministration: 'open' | 'closed';
		readonly tenantLocalContractAdmission: 'not-required' | 'required';
	};
	readonly recoveryPoints: {
		readonly d1: 'absent' | 'recorded';
		readonly durableObjectFleet: 'absent' | 'partial' | 'complete';
	};
}

interface TransitionBase {
	readonly id: DeploymentTransitionId;
	readonly from: DeploymentStateId;
	readonly to: DeploymentStateId;
	readonly checks: readonly DeploymentCheckId[];
}

export type ForwardDeploymentTransition =
	| (TransitionBase & {
			readonly kind: 'apply-d1';
			readonly migrations: readonly D1MigrationId[];
	  })
	| (TransitionBase & {
			readonly kind: 'deploy-runtime-stage';
			readonly stage: RuntimeStageId;
	  })
	| (TransitionBase & {
			readonly kind: 'run-data-migration';
			readonly migration: DataMigrationId;
	  })
	| (TransitionBase & {
			readonly kind: 'drain-writer-epoch';
			readonly before: WriterEpoch;
	  })
	| (TransitionBase & {
			readonly kind: 'set-deployment-fence';
			readonly fence: 'd1-application-writes' | 'retention-administration';
			readonly value: 'open' | 'closed';
	  })
	| (TransitionBase & {
			readonly kind: 'record-recovery-point';
			readonly storage: 'd1' | 'durable-object-fleet';
	  })
	| (TransitionBase & {
			readonly kind: 'set-tenant-local-contract-admission';
			readonly value: 'not-required' | 'required';
	  })
	| (TransitionBase & {
			readonly kind: 'resolve-repair-intents';
			readonly repairClass: 'cross-store-projection';
	  })
	| (TransitionBase & {
			readonly kind: 'close-r2-compatibility-window';
	  })
	| (TransitionBase & { readonly kind: 'verify' });

export interface DataMigrationResultAdoption {
	readonly predecessorMigration: DataMigrationId;
	readonly successorMigration: DataMigrationId;
	readonly completed:
		| {
				readonly kind: 'reverify';
				readonly checks: readonly DeploymentCheckId[];
		  }
		| {
				readonly kind: 'rerun';
				readonly checkpoint: DataMigrationCheckpointId;
		  };
	readonly notApplicable: {
		readonly kind: 'revalidate';
		readonly checks: readonly DeploymentCheckId[];
		readonly becameApplicable: {
			readonly kind: 'restart';
			readonly checkpoint: DataMigrationCheckpointId;
		};
	};
	readonly incomplete:
		| {
				readonly kind: 'resume';
				readonly cursorFormat: DataMigrationCursorFormatId;
				readonly implementationCompatibility: DataMigrationCompatibilityId;
		  }
		| {
				readonly kind: 'restart';
				readonly checkpoint: DataMigrationCheckpointId;
		  };
	readonly invariantFailure:
		| { readonly kind: 'preserve' }
		| {
				readonly kind: 'repair';
				readonly repair: RegisteredForwardRepairId;
		  };
}

export type RecoveryDeploymentTransition =
	| {
			readonly id: DeploymentRecoveryTransitionId;
			readonly from: DeploymentStateId;
			readonly to: DeploymentStateId;
			readonly kind: 'restore-d1';
			readonly recoveryEnvelope: D1RecoveryEnvelopeId;
			readonly checks: readonly DeploymentCheckId[];
	  }
	| {
			readonly id: DeploymentRecoveryTransitionId;
			readonly from: DeploymentStateId;
			readonly to: DeploymentStateId;
			readonly kind: 'restore-durable-objects';
			readonly cohort: DataMigrationId;
			readonly bookmarkPhase:
				| 'pre-contract-bookmark-recorded'
				| 'contracting'
				| 'restoration-scheduled'
				| 'restored-awaiting-verification';
			readonly checks: readonly DeploymentCheckId[];
	  }
	| {
			readonly id: DeploymentRecoveryTransitionId;
			readonly from: DeploymentStateId;
			readonly to: DeploymentStateId;
			readonly kind: 'deploy-recovery-stage';
			readonly stage: RuntimeStageId;
			readonly checks: readonly DeploymentCheckId[];
	  }
	| {
			readonly id: DeploymentRecoveryTransitionId;
			readonly from: DeploymentStateId;
			readonly to: DeploymentStateId;
			readonly kind: 'forward-repair';
			readonly repair: RegisteredForwardRepairId;
			readonly checks: readonly DeploymentCheckId[];
	  }
	| {
			readonly id: DeploymentRecoveryTransitionId;
			readonly kind: 'adopt-predecessor-deployment';
			readonly compatiblePredecessorArtifacts: readonly DeploymentArtifactId[];
			readonly predecessorState: DeploymentStateId;
			readonly to: DeploymentStateId;
			readonly expiredExecution:
				| { readonly kind: 'reject' }
				| { readonly kind: 'abandon-unissued' }
				| {
						readonly kind: 'observe-external-effects';
						readonly checks: readonly DeploymentCheckId[];
				  };
			readonly migrationResults: readonly DataMigrationResultAdoption[];
			readonly checks: readonly DeploymentCheckId[];
	  };

export interface LegacyBootstrapTransition {
	readonly id: DeploymentBootstrapTransitionId;
	readonly from: DeploymentStateId;
	readonly to: DeploymentStateId;
	readonly kind: 'bootstrap-legacy-runtime';
	readonly sourceFingerprint: LegacyRuntimeFingerprintId;
	readonly migrations: readonly D1MigrationId[];
	readonly stage: RuntimeStageId;
	readonly checks: readonly DeploymentCheckId[];
}

export interface StructuralMigration {
	readonly id: D1MigrationId | DurableObjectMigrationId;
	readonly sha256: string;
}

export interface DataMigrationBudget {
	readonly maximumStatements: number;
	readonly maximumRowsReturned: number;
	readonly maximumReportedD1RowsRead: number;
	readonly maximumRowsWritten: number;
	readonly maximumParametersPerStatement: number;
	readonly maximumR2Operations: number;
	readonly maximumR2BytesRead: number;
	readonly maximumR2BytesWritten: number;
}

export interface DataMigrationDescriptor {
	readonly id: DataMigrationId;
	readonly implementationRevision: DataMigrationRevision;
	readonly source: 'legacy' | 'dual';
	readonly target: 'dual' | 'native';
	readonly tenantStatuses: readonly ('active' | 'suspended' | 'offboarding')[];
	readonly runtimeStage: RuntimeStageId;
	readonly d1Schemas: readonly D1SchemaStateId[];
	readonly budget: DataMigrationBudget;
	readonly retryableFailures: readonly MigrationFailureCode[];
	readonly terminalFailures: readonly MigrationFailureCode[];
}

export interface DeploymentCheckDescriptor {
	readonly id: DeploymentCheckId;
	readonly runtimeStage?: RuntimeStageId;
}

export interface LegacyRuntimeFingerprint {
	readonly id: LegacyRuntimeFingerprintId;
	readonly d1Migration: D1MigrationId;
	readonly durableObjectMigration: DurableObjectMigrationId;
	readonly tenantVersionTag: CloudflareWorkerVersionTag;
	readonly controlVersionTag: CloudflareWorkerVersionTag;
}

export interface RuntimeStage {
	readonly id: RuntimeStageId;
	readonly localMigrationCeiling: DurableObjectMigrationId;
	readonly supportedD1Schemas: readonly D1SchemaStateId[];
}

export interface DeploymentManifestBody {
	readonly initialState: DeploymentStateId;
	readonly terminalState: DeploymentStateId;
	readonly states: readonly DeploymentState[];
	readonly forwardTransitions: readonly ForwardDeploymentTransition[];
	readonly recoveryTransitions: readonly RecoveryDeploymentTransition[];
	readonly bootstrapTransitions: readonly LegacyBootstrapTransition[];
	readonly legacyRuntimeFingerprints: readonly LegacyRuntimeFingerprint[];
	readonly runtimeStages: readonly RuntimeStage[];
	readonly d1Migrations: readonly StructuralMigration[];
	readonly durableObjectMigrations: readonly StructuralMigration[];
	readonly dataMigrations: readonly DataMigrationDescriptor[];
	readonly checks: readonly DeploymentCheckDescriptor[];
}

const runtimeDeploymentSchema: z.ZodType<RuntimeDeployment> =
	z.discriminatedUnion('kind', [
		z.strictObject({
			kind: z.literal('registered'),
			stage: runtimeStageIdSchema
		}),
		z.strictObject({
			kind: z.literal('legacy'),
			fingerprint: legacyRuntimeFingerprintIdSchema
		})
	]);

const legacyR2RepresentationSchema = z.strictObject({
	writes: z.enum(['enabled', 'disabled']),
	readFallback: z.enum(['enabled', 'disabled']),
	deletion: z.enum(['forbidden', 'eligible'])
});

const deploymentRepresentationsSchema = z.strictObject({
	catalogue: z.enum(['legacy', 'dual', 'native']),
	r2Metadata: z.enum(['legacy', 'dual', 'native']),
	retention: z.enum(['legacy', 'dual', 'native']),
	legacyR2: legacyR2RepresentationSchema
});

const deploymentStateSchema: z.ZodType<DeploymentState> = z.strictObject({
	id: deploymentStateIdSchema,
	d1Schema: d1SchemaStateIdSchema,
	tenantRuntime: runtimeDeploymentSchema,
	controlRuntime: runtimeDeploymentSchema,
	localSchema: z.strictObject({
		runtimeCeiling: durableObjectMigrationIdSchema,
		fleetState: z.enum(['unreconciled', 'migrating', 'complete'])
	}),
	writerEpoch: writerEpochSchema,
	representations: deploymentRepresentationsSchema,
	fences: z.strictObject({
		d1ApplicationWrites: z.enum(['open', 'closed']),
		retentionAdministration: z.enum(['open', 'closed']),
		tenantLocalContractAdmission: z.enum(['not-required', 'required'])
	}),
	recoveryPoints: z.strictObject({
		d1: z.enum(['absent', 'recorded']),
		durableObjectFleet: z.enum(['absent', 'partial', 'complete'])
	})
});

const transitionBaseShape = {
	id: deploymentTransitionIdSchema,
	from: deploymentStateIdSchema,
	to: deploymentStateIdSchema,
	checks: z.array(deploymentCheckIdSchema)
};

const forwardDeploymentTransitionSchema: z.ZodType<ForwardDeploymentTransition> =
	z.discriminatedUnion('kind', [
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('apply-d1'),
			migrations: z.array(d1MigrationIdSchema)
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('deploy-runtime-stage'),
			stage: runtimeStageIdSchema
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('run-data-migration'),
			migration: dataMigrationIdSchema
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('drain-writer-epoch'),
			before: writerEpochSchema
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('set-deployment-fence'),
			fence: z.enum(['d1-application-writes', 'retention-administration']),
			value: z.enum(['open', 'closed'])
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('record-recovery-point'),
			storage: z.enum(['d1', 'durable-object-fleet'])
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('set-tenant-local-contract-admission'),
			value: z.enum(['not-required', 'required'])
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('resolve-repair-intents'),
			repairClass: z.literal('cross-store-projection')
		}),
		z.strictObject({
			...transitionBaseShape,
			kind: z.literal('close-r2-compatibility-window')
		}),
		z.strictObject({ ...transitionBaseShape, kind: z.literal('verify') })
	]);

const restartAdoptionSchema = z.strictObject({
	kind: z.literal('restart'),
	checkpoint: dataMigrationCheckpointIdSchema
});
const adoptionCheckListSchema = z.array(deploymentCheckIdSchema);
const reverifyAdoptionSchema = z.strictObject({
	kind: z.literal('reverify'),
	checks: adoptionCheckListSchema
});
const rerunAdoptionSchema = z.strictObject({
	kind: z.literal('rerun'),
	checkpoint: dataMigrationCheckpointIdSchema
});
const resumeAdoptionSchema = z.strictObject({
	kind: z.literal('resume'),
	cursorFormat: dataMigrationCursorFormatIdSchema,
	implementationCompatibility: dataMigrationCompatibilityIdSchema
});
const preserveFailureAdoptionSchema = z.strictObject({
	kind: z.literal('preserve')
});
const repairFailureAdoptionSchema = z.strictObject({
	kind: z.literal('repair'),
	repair: registeredForwardRepairIdSchema
});
const completedAdoptionSchema = z.discriminatedUnion('kind', [
	reverifyAdoptionSchema,
	rerunAdoptionSchema
]);
const incompleteAdoptionSchema = z.discriminatedUnion('kind', [
	resumeAdoptionSchema,
	restartAdoptionSchema
]);
const invariantFailureAdoptionSchema = z.discriminatedUnion('kind', [
	preserveFailureAdoptionSchema,
	repairFailureAdoptionSchema
]);
const notApplicableAdoptionSchema = z.strictObject({
	kind: z.literal('revalidate'),
	checks: adoptionCheckListSchema,
	becameApplicable: restartAdoptionSchema
});

const dataMigrationResultAdoptionSchema: z.ZodType<DataMigrationResultAdoption> =
	z.strictObject({
		predecessorMigration: dataMigrationIdSchema,
		successorMigration: dataMigrationIdSchema,
		completed: completedAdoptionSchema,
		notApplicable: notApplicableAdoptionSchema,
		incomplete: incompleteAdoptionSchema,
		invariantFailure: invariantFailureAdoptionSchema
	});

const rejectExpiredExecutionSchema = z.strictObject({
	kind: z.literal('reject')
});
const abandonExpiredExecutionSchema = z.strictObject({
	kind: z.literal('abandon-unissued')
});
const observeExpiredExecutionSchema = z.strictObject({
	kind: z.literal('observe-external-effects'),
	checks: adoptionCheckListSchema
});
const expiredExecutionAdoptionSchema = z.discriminatedUnion('kind', [
	rejectExpiredExecutionSchema,
	abandonExpiredExecutionSchema,
	observeExpiredExecutionSchema
]);

const recoveryDeploymentTransitionSchema: z.ZodType<RecoveryDeploymentTransition> =
	z.discriminatedUnion('kind', [
		z.strictObject({
			id: deploymentRecoveryTransitionIdSchema,
			from: deploymentStateIdSchema,
			to: deploymentStateIdSchema,
			kind: z.literal('restore-d1'),
			recoveryEnvelope: d1RecoveryEnvelopeIdSchema,
			checks: z.array(deploymentCheckIdSchema)
		}),
		z.strictObject({
			id: deploymentRecoveryTransitionIdSchema,
			from: deploymentStateIdSchema,
			to: deploymentStateIdSchema,
			kind: z.literal('restore-durable-objects'),
			cohort: dataMigrationIdSchema,
			bookmarkPhase: z.enum([
				'pre-contract-bookmark-recorded',
				'contracting',
				'restoration-scheduled',
				'restored-awaiting-verification'
			]),
			checks: z.array(deploymentCheckIdSchema)
		}),
		z.strictObject({
			id: deploymentRecoveryTransitionIdSchema,
			from: deploymentStateIdSchema,
			to: deploymentStateIdSchema,
			kind: z.literal('deploy-recovery-stage'),
			stage: runtimeStageIdSchema,
			checks: z.array(deploymentCheckIdSchema)
		}),
		z.strictObject({
			id: deploymentRecoveryTransitionIdSchema,
			from: deploymentStateIdSchema,
			to: deploymentStateIdSchema,
			kind: z.literal('forward-repair'),
			repair: registeredForwardRepairIdSchema,
			checks: z.array(deploymentCheckIdSchema)
		}),
		z.strictObject({
			id: deploymentRecoveryTransitionIdSchema,
			kind: z.literal('adopt-predecessor-deployment'),
			compatiblePredecessorArtifacts: z.array(deploymentArtifactIdSchema),
			predecessorState: deploymentStateIdSchema,
			to: deploymentStateIdSchema,
			expiredExecution: expiredExecutionAdoptionSchema,
			migrationResults: z.array(dataMigrationResultAdoptionSchema),
			checks: z.array(deploymentCheckIdSchema)
		})
	]);

const legacyBootstrapTransitionSchema: z.ZodType<LegacyBootstrapTransition> =
	z.strictObject({
		id: deploymentBootstrapTransitionIdSchema,
		from: deploymentStateIdSchema,
		to: deploymentStateIdSchema,
		kind: z.literal('bootstrap-legacy-runtime'),
		sourceFingerprint: legacyRuntimeFingerprintIdSchema,
		migrations: z.array(d1MigrationIdSchema),
		stage: runtimeStageIdSchema,
		checks: z.array(deploymentCheckIdSchema)
	});

const structuralMigrationSchema: z.ZodType<StructuralMigration> =
	z.strictObject({
		id: z.union([d1MigrationIdSchema, durableObjectMigrationIdSchema]),
		sha256: z.string().regex(/^[\da-f]{64}$/)
	});

const dataMigrationBudgetSchema: z.ZodType<DataMigrationBudget> =
	z.strictObject({
		maximumStatements: z.int().nonnegative(),
		maximumRowsReturned: z.int().nonnegative(),
		maximumReportedD1RowsRead: z.int().nonnegative(),
		maximumRowsWritten: z.int().nonnegative(),
		maximumParametersPerStatement: z.int().nonnegative(),
		maximumR2Operations: z.int().nonnegative(),
		maximumR2BytesRead: z.int().nonnegative(),
		maximumR2BytesWritten: z.int().nonnegative()
	});

const dataMigrationDescriptorSchema: z.ZodType<DataMigrationDescriptor> =
	z.strictObject({
		id: dataMigrationIdSchema,
		implementationRevision: dataMigrationRevisionSchema,
		source: z.enum(['legacy', 'dual']),
		target: z.enum(['dual', 'native']),
		tenantStatuses: z.array(z.enum(['active', 'suspended', 'offboarding'])),
		runtimeStage: runtimeStageIdSchema,
		d1Schemas: z.array(d1SchemaStateIdSchema),
		budget: dataMigrationBudgetSchema,
		retryableFailures: z.array(migrationFailureCodeSchema),
		terminalFailures: z.array(migrationFailureCodeSchema)
	});

const deploymentCheckDescriptorSchema: z.ZodType<DeploymentCheckDescriptor> =
	z.strictObject({
		id: deploymentCheckIdSchema,
		runtimeStage: runtimeStageIdSchema.optional()
	});

const legacyRuntimeFingerprintSchema: z.ZodType<LegacyRuntimeFingerprint> =
	z.strictObject({
		id: legacyRuntimeFingerprintIdSchema,
		d1Migration: d1MigrationIdSchema,
		durableObjectMigration: durableObjectMigrationIdSchema,
		tenantVersionTag: cloudflareWorkerVersionTagSchema,
		controlVersionTag: cloudflareWorkerVersionTagSchema
	});

const runtimeStageSchema: z.ZodType<RuntimeStage> = z.strictObject({
	id: runtimeStageIdSchema,
	localMigrationCeiling: durableObjectMigrationIdSchema,
	supportedD1Schemas: z.array(d1SchemaStateIdSchema)
});

export const deploymentManifestBodySchema: z.ZodType<DeploymentManifestBody> =
	z.strictObject({
		initialState: deploymentStateIdSchema,
		terminalState: deploymentStateIdSchema,
		states: z.array(deploymentStateSchema),
		forwardTransitions: z.array(forwardDeploymentTransitionSchema),
		recoveryTransitions: z.array(recoveryDeploymentTransitionSchema),
		bootstrapTransitions: z.array(legacyBootstrapTransitionSchema),
		legacyRuntimeFingerprints: z.array(legacyRuntimeFingerprintSchema),
		runtimeStages: z.array(runtimeStageSchema),
		d1Migrations: z.array(structuralMigrationSchema),
		durableObjectMigrations: z.array(structuralMigrationSchema),
		dataMigrations: z.array(dataMigrationDescriptorSchema),
		checks: z.array(deploymentCheckDescriptorSchema)
	});

export interface DeploymentIdentity {
	readonly artifactId: DeploymentArtifactId;
	readonly instanceId: DeploymentInstanceId;
}

export interface WorkerUploadTemplate {
	readonly bundleHash: BundleSha256;
	readonly versionTag: CloudflareWorkerVersionTag;
	readonly mainModule: string;
	readonly compatibilityDate: IsoDate;
	readonly compatibilityFlags: readonly string[];
	readonly observability: {
		readonly enabled: boolean;
		readonly tracing: boolean;
	};
	readonly keepBindings: readonly string[];
	readonly cache: {
		readonly enabled: boolean;
		readonly crossVersion: boolean;
	};
	readonly exports: Readonly<Record<string, unknown>>;
	readonly cpuMilliseconds?: number;
	readonly bindings: readonly {
		readonly name: string;
		readonly type: string;
		readonly target?: string;
	}[];
}

export interface StaticDeploymentArtifacts {
	readonly manifestId: DeploymentManifestId;
	readonly deploymentExecutorHash: DeploymentExecutorSha256;
	readonly tenant: WorkerUploadTemplate;
	readonly control: WorkerUploadTemplate;
}

export interface ResolvedDeploymentTopology {
	readonly accountId: string;
	readonly tenantScript: string;
	readonly controlScript: string;
	readonly resources: Readonly<Record<string, string>>;
}

export class DeploymentManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeploymentManifestError';
	}
}

function uniqueBy<T>(
	values: readonly T[],
	identifier: (value: T) => string,
	description: string
): Map<string, T> {
	const result = new Map<string, T>();

	for (const value of values) {
		const id = identifier(value);

		if (result.has(id)) {
			throw new DeploymentManifestError(`Duplicate ${description} ${id}`);
		}

		result.set(id, value);
	}

	return result;
}

type DeploymentStateFacts = Omit<DeploymentState, 'id'>;

function stateFacts(state: DeploymentState): DeploymentStateFacts {
	const { id: _id, ...facts } = state;

	return facts;
}

function areFactsEqual(left: DeploymentState, right: DeploymentState): boolean {
	return canonicalJson(stateFacts(left)) === canonicalJson(stateFacts(right));
}

function stateAfterTransition(
	transition: ForwardDeploymentTransition,
	from: DeploymentState,
	to: DeploymentState
): DeploymentState {
	switch (transition.kind) {
		case 'apply-d1': {
			return { ...from, id: to.id, d1Schema: to.d1Schema };
		}
		case 'deploy-runtime-stage': {
			return {
				...from,
				id: to.id,
				tenantRuntime: to.tenantRuntime,
				controlRuntime: to.controlRuntime,
				localSchema: to.localSchema
			};
		}
		case 'run-data-migration': {
			return {
				...from,
				id: to.id,
				localSchema: to.localSchema,
				representations: to.representations
			};
		}
		case 'drain-writer-epoch':
		case 'resolve-repair-intents':
		case 'verify': {
			return { ...from, id: to.id };
		}
		case 'set-deployment-fence': {
			const fence =
				transition.fence === 'd1-application-writes'
					? 'd1ApplicationWrites'
					: 'retentionAdministration';

			return {
				...from,
				id: to.id,
				fences: { ...from.fences, [fence]: transition.value }
			};
		}
		case 'record-recovery-point': {
			const recoveryPoint =
				transition.storage === 'd1' ? 'd1' : 'durableObjectFleet';
			const value = transition.storage === 'd1' ? 'recorded' : 'complete';

			return {
				...from,
				id: to.id,
				recoveryPoints: {
					...from.recoveryPoints,
					[recoveryPoint]: value
				}
			};
		}
		case 'set-tenant-local-contract-admission': {
			return {
				...from,
				id: to.id,
				fences: {
					...from.fences,
					tenantLocalContractAdmission: transition.value
				}
			};
		}
		case 'close-r2-compatibility-window': {
			return {
				...from,
				id: to.id,
				representations: {
					...from.representations,
					legacyR2: {
						writes: 'disabled',
						readFallback: 'disabled',
						deletion: 'eligible'
					}
				}
			};
		}
	}
}

function validateVerifyTransition(
	transition: ForwardDeploymentTransition,
	from: DeploymentState,
	to: DeploymentState
): void {
	if (transition.kind === 'verify' && !areFactsEqual(from, to)) {
		throw new DeploymentManifestError(
			`Verify transition ${transition.id} changes deployment state`
		);
	}
}

function validateTransitionEffect(
	transition: ForwardDeploymentTransition,
	from: DeploymentState,
	to: DeploymentState
): void {
	if (areFactsEqual(stateAfterTransition(transition, from, to), to)) {
		return;
	}

	throw new DeploymentManifestError(
		`Transition ${transition.id} changes facts outside ${transition.kind}`
	);
}

function validateTerminalState(state: DeploymentState): void {
	if (state.fences.tenantLocalContractAdmission !== 'required') {
		throw new DeploymentManifestError(
			'The terminal state must retain tenant-local contract admission'
		);
	}
}

function requireDeclared(
	declared: ReadonlySet<string>,
	value: string,
	description: string
): void {
	if (!declared.has(value)) {
		throw new DeploymentManifestError(
			`${description} ${value} is not declared by the manifest`
		);
	}
}

function validateMigrationDigests(
	migrations: readonly StructuralMigration[],
	description: string
): void {
	for (const migration of migrations) {
		if (!/^[\da-f]{64}$/.test(migration.sha256)) {
			throw new DeploymentManifestError(
				`${description} migration ${migration.id} does not have a lowercase SHA-256 digest`
			);
		}
	}
}

function validateRuntimeDeployment(
	runtime: RuntimeDeployment,
	state: DeploymentState,
	runtimeStages: ReadonlyMap<string, RuntimeStage>,
	legacyFingerprints: ReadonlySet<string>
): void {
	if (runtime.kind === 'registered') {
		const stage = runtimeStages.get(runtime.stage);

		if (stage === undefined) {
			throw new DeploymentManifestError(
				`State ${state.id} runtime stage ${runtime.stage} is not declared by the manifest`
			);
		}

		if (!stage.supportedD1Schemas.includes(state.d1Schema)) {
			throw new DeploymentManifestError(
				`State ${state.id} runtime stage ${runtime.stage} does not support D1 schema ${state.d1Schema}`
			);
		}

		if (stage.localMigrationCeiling !== state.localSchema.runtimeCeiling) {
			throw new DeploymentManifestError(
				`State ${state.id} runtime stage ${runtime.stage} does not match local migration ceiling ${state.localSchema.runtimeCeiling}`
			);
		}
		return;
	}

	requireDeclared(
		legacyFingerprints,
		runtime.fingerprint,
		`State ${state.id} legacy runtime fingerprint`
	);
}

function validateRecoveryTransition(
	transition: RecoveryDeploymentTransition,
	states: ReadonlyMap<string, DeploymentState>,
	runtimeStages: ReadonlySet<string>,
	dataMigrations: ReadonlySet<string>,
	checks: ReadonlySet<string>
): void {
	const fromState =
		transition.kind === 'adopt-predecessor-deployment'
			? transition.predecessorState
			: transition.from;

	const declaredStates = new Set(states.keys());
	requireDeclared(declaredStates, fromState, 'Recovery source state');
	requireDeclared(declaredStates, transition.to, 'Recovery target state');

	for (const check of transition.checks) {
		requireDeclared(
			checks,
			check,
			`Recovery transition ${transition.id} check`
		);
	}

	switch (transition.kind) {
		case 'deploy-recovery-stage': {
			requireDeclared(
				runtimeStages,
				transition.stage,
				`Recovery transition ${transition.id} runtime stage`
			);
			break;
		}
		case 'restore-durable-objects': {
			requireDeclared(
				dataMigrations,
				transition.cohort,
				`Recovery transition ${transition.id} data migration`
			);
			break;
		}
		case 'adopt-predecessor-deployment': {
			if (transition.compatiblePredecessorArtifacts.length === 0) {
				throw new DeploymentManifestError(
					`Recovery transition ${transition.id} has no compatible predecessor artifact`
				);
			}

			for (const adoption of transition.migrationResults) {
				requireDeclared(
					dataMigrations,
					adoption.successorMigration,
					`Recovery transition ${transition.id} successor data migration`
				);
			}
			break;
		}
	}
}

function validateOrderedD1Coverage(
	manifest: DeploymentManifestBody,
	path: readonly (ForwardDeploymentTransition | LegacyBootstrapTransition)[]
): void {
	const declared = manifest.d1Migrations.map((migration) => migration.id);
	const applied = path.flatMap((transition) =>
		transition.kind === 'apply-d1' ||
		transition.kind === 'bootstrap-legacy-runtime'
			? transition.migrations
			: []
	);
	const uniqueApplied = new Set(applied);

	if (uniqueApplied.size !== applied.length) {
		throw new DeploymentManifestError(
			'The deployment path applies a D1 migration more than once'
		);
	}

	const bootstrap = path.find(
		(transition) => transition.kind === 'bootstrap-legacy-runtime'
	);

	if (bootstrap === undefined) {
		for (const [index, migration] of applied.entries()) {
			const declaredIndex = declared.indexOf(migration);
			const previousMigration = applied[index - 1];
			const previousIndex =
				previousMigration === undefined
					? -1
					: declared.indexOf(previousMigration);

			if (declaredIndex <= previousIndex) {
				throw new DeploymentManifestError(
					'The deployment path does not preserve D1 migration order'
				);
			}
		}
		return;
	}

	const fingerprint = manifest.legacyRuntimeFingerprints.find(
		(candidate) => candidate.id === bootstrap.sourceFingerprint
	);
	const sourceIndex =
		fingerprint === undefined ? -1 : declared.indexOf(fingerprint.d1Migration);
	const expected = declared.slice(sourceIndex + 1);

	if (
		fingerprint === undefined ||
		sourceIndex === -1 ||
		canonicalJson(applied) !== canonicalJson(expected)
	) {
		throw new DeploymentManifestError(
			'The legacy deployment path does not apply every remaining D1 migration exactly once and in order'
		);
	}
}

function validateTransitionDeclarations(
	transition: ForwardDeploymentTransition,
	d1Migrations: ReadonlySet<string>,
	dataMigrations: ReadonlySet<string>,
	runtimeStages: ReadonlySet<string>
): void {
	if (transition.kind === 'apply-d1') {
		for (const migration of transition.migrations) {
			requireDeclared(
				d1Migrations,
				migration,
				`Transition ${transition.id} D1 migration`
			);
		}
		return;
	}

	if (transition.kind === 'run-data-migration') {
		requireDeclared(
			dataMigrations,
			transition.migration,
			`Transition ${transition.id} data migration`
		);
		return;
	}

	if (transition.kind === 'deploy-runtime-stage') {
		requireDeclared(
			runtimeStages,
			transition.stage,
			`Transition ${transition.id} runtime stage`
		);
	}
}

/**
Validates the structural invariants of a deployment manifest.
*/
export function validateDeploymentManifest(
	manifest: DeploymentManifestBody
): void {
	const states = uniqueBy(manifest.states, (state) => state.id, 'state');
	const transitions = uniqueBy(
		manifest.forwardTransitions,
		(transition) => transition.id,
		'forward transition'
	);
	uniqueBy(
		manifest.recoveryTransitions,
		(transition) => transition.id,
		'recovery transition'
	);
	uniqueBy(
		manifest.bootstrapTransitions,
		(transition) => transition.id,
		'bootstrap transition'
	);
	uniqueBy(
		manifest.legacyRuntimeFingerprints,
		(fingerprint) => fingerprint.id,
		'legacy runtime fingerprint'
	);
	const runtimeStages = uniqueBy(
		manifest.runtimeStages,
		(stage) => stage.id,
		'runtime stage'
	);
	const d1Migrations = uniqueBy(
		manifest.d1Migrations,
		(migration) => migration.id,
		'D1 migration'
	);
	const durableObjectMigrations = uniqueBy(
		manifest.durableObjectMigrations,
		(migration) => migration.id,
		'Durable Object migration'
	);
	const dataMigrations = uniqueBy(
		manifest.dataMigrations,
		(migration) => migration.id,
		'data migration'
	);
	const checks = uniqueBy(manifest.checks, (check) => check.id, 'check');
	const legacyFingerprints = new Set(
		manifest.legacyRuntimeFingerprints.map((fingerprint) => fingerprint.id)
	);

	validateMigrationDigests(manifest.d1Migrations, 'D1');
	validateMigrationDigests(manifest.durableObjectMigrations, 'Durable Object');

	for (const stage of runtimeStages.values()) {
		requireDeclared(
			new Set(durableObjectMigrations.keys()),
			stage.localMigrationCeiling,
			`Runtime stage ${stage.id} ceiling`
		);
	}

	const declaredRuntimeStages = new Set(runtimeStages.keys());

	for (const state of states.values()) {
		validateRuntimeDeployment(
			state.tenantRuntime,
			state,
			runtimeStages,
			legacyFingerprints
		);
		validateRuntimeDeployment(
			state.controlRuntime,
			state,
			runtimeStages,
			legacyFingerprints
		);

		requireDeclared(
			new Set(durableObjectMigrations.keys()),
			state.localSchema.runtimeCeiling,
			`State ${state.id} local migration ceiling`
		);
	}

	const initial = states.get(manifest.initialState);

	if (initial === undefined) {
		throw new DeploymentManifestError('The initial state is not declared');
	}

	const terminal = states.get(manifest.terminalState);

	if (terminal === undefined) {
		throw new DeploymentManifestError('The terminal state is not declared');
	}

	validateTerminalState(terminal);

	const successorByState = new Map<DeploymentStateId, DeploymentStateId>();
	const declaredChecks = new Set(checks.keys());
	const declaredD1Migrations = new Set(d1Migrations.keys());
	const declaredDataMigrations = new Set(dataMigrations.keys());

	for (const check of checks.values()) {
		if (check.runtimeStage !== undefined) {
			requireDeclared(
				declaredRuntimeStages,
				check.runtimeStage,
				`Check ${check.id} runtime stage`
			);
		}
	}

	for (const migration of dataMigrations.values()) {
		requireDeclared(
			declaredRuntimeStages,
			migration.runtimeStage,
			`Data migration ${migration.id} runtime stage`
		);

		for (const schema of migration.d1Schemas) {
			const stage = runtimeStages.get(migration.runtimeStage);

			if (stage !== undefined && !stage.supportedD1Schemas.includes(schema)) {
				throw new DeploymentManifestError(
					`Data migration ${migration.id} uses D1 schema ${schema} outside runtime stage ${migration.runtimeStage}`
				);
			}
		}
	}
	for (const transition of transitions.values()) {
		const from = states.get(transition.from);
		const to = states.get(transition.to);

		if (from === undefined || to === undefined) {
			throw new DeploymentManifestError(
				`Transition ${transition.id} refers to an undeclared state`
			);
		}

		if (successorByState.has(transition.from)) {
			throw new DeploymentManifestError(
				`State ${transition.from} has more than one forward successor`
			);
		}

		successorByState.set(transition.from, transition.to);

		for (const check of transition.checks) {
			requireDeclared(
				declaredChecks,
				check,
				`Transition ${transition.id} check`
			);
		}

		validateTransitionDeclarations(
			transition,
			declaredD1Migrations,
			declaredDataMigrations,
			declaredRuntimeStages
		);

		validateVerifyTransition(transition, from, to);
		validateTransitionEffect(transition, from, to);
	}

	const bootstrapByState = new Map<DeploymentStateId, DeploymentStateId>();

	for (const bootstrap of manifest.bootstrapTransitions) {
		const from = states.get(bootstrap.from);
		const to = states.get(bootstrap.to);

		if (from === undefined || to === undefined) {
			throw new DeploymentManifestError(
				`Bootstrap transition ${bootstrap.id} refers to an undeclared state`
			);
		}

		if (bootstrapByState.has(bootstrap.from)) {
			throw new DeploymentManifestError(
				`State ${bootstrap.from} has more than one bootstrap successor`
			);
		}

		if (
			from.tenantRuntime.kind !== 'legacy' ||
			from.controlRuntime.kind !== 'legacy' ||
			from.tenantRuntime.fingerprint !== bootstrap.sourceFingerprint ||
			from.controlRuntime.fingerprint !== bootstrap.sourceFingerprint
		) {
			throw new DeploymentManifestError(
				`Bootstrap transition ${bootstrap.id} does not match its legacy source state`
			);
		}

		if (
			to.tenantRuntime.kind !== 'registered' ||
			to.controlRuntime.kind !== 'registered' ||
			to.tenantRuntime.stage !== bootstrap.stage ||
			to.controlRuntime.stage !== bootstrap.stage
		) {
			throw new DeploymentManifestError(
				`Bootstrap transition ${bootstrap.id} does not produce its target runtime stage`
			);
		}

		for (const migration of bootstrap.migrations) {
			requireDeclared(
				declaredD1Migrations,
				migration,
				`Bootstrap transition ${bootstrap.id} D1 migration`
			);
		}

		for (const check of bootstrap.checks) {
			requireDeclared(
				declaredChecks,
				check,
				`Bootstrap transition ${bootstrap.id} check`
			);
		}

		bootstrapByState.set(bootstrap.from, bootstrap.to);
	}

	for (const recovery of manifest.recoveryTransitions) {
		validateRecoveryTransition(
			recovery,
			states,
			declaredRuntimeStages,
			declaredDataMigrations,
			declaredChecks
		);
	}

	const visited = new Set<DeploymentStateId>();
	const path: (ForwardDeploymentTransition | LegacyBootstrapTransition)[] = [];
	let current: DeploymentStateId | undefined = manifest.initialState;

	while (current !== undefined) {
		if (visited.has(current)) {
			throw new DeploymentManifestError(
				'The forward transitions contain a cycle'
			);
		}

		visited.add(current);
		const bootstrap = manifest.bootstrapTransitions.find(
			(transition) => transition.from === current
		);
		const transition = manifest.forwardTransitions.find(
			(candidate) => candidate.from === current
		);

		if (bootstrap !== undefined) {
			path.push(bootstrap);
		} else if (transition !== undefined) {
			path.push(transition);
		}

		current = bootstrapByState.get(current) ?? successorByState.get(current);
	}

	if (!visited.has(manifest.terminalState)) {
		throw new DeploymentManifestError(
			'The terminal state is not reachable from the initial state'
		);
	}

	if (visited.size !== states.size) {
		throw new DeploymentManifestError(
			'The manifest contains a state outside the forward deployment path'
		);
	}

	validateOrderedD1Coverage(manifest, path);
}
