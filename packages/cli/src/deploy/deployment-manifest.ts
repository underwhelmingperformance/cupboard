import {
	type DeploymentArtifactId,
	type DeploymentInstanceId,
	type DeploymentManifestId,
	type DeploymentStateId,
	type DeploymentTransitionId
} from '@cupboard/protocol/deployment';

import { canonicalJson } from './canonical-json.ts';

export type {
	DeploymentArtifactId,
	DeploymentInstanceId,
	DeploymentManifestId,
	DeploymentStateId,
	DeploymentTransitionId
} from '@cupboard/protocol/deployment';

interface Brand<Name extends string> {
	readonly __brand: Name;
}

export type BrandedString<Name extends string> = string & Brand<Name>;

export type DeploymentRecoveryTransitionId =
	BrandedString<'DeploymentRecoveryTransitionId'>;
export type DeploymentCheckId = BrandedString<'DeploymentCheckId'>;
export type D1MigrationId = BrandedString<'D1MigrationId'>;
export type DurableObjectMigrationId =
	BrandedString<'DurableObjectMigrationId'>;
export type DataMigrationId = BrandedString<'DataMigrationId'>;
export type RuntimeStageId = BrandedString<'RuntimeStageId'>;
export type LegacyRuntimeFingerprintId =
	BrandedString<'LegacyRuntimeFingerprintId'>;
export type D1SchemaStateId = BrandedString<'D1SchemaStateId'>;
export type WriterEpoch = BrandedString<'WriterEpoch'>;
export type DeploymentBootstrapTransitionId =
	BrandedString<'DeploymentBootstrapTransitionId'>;
export type DeploymentExecutorSha256 =
	BrandedString<'DeploymentExecutorSha256'>;
export type BundleSha256 = BrandedString<'BundleSha256'>;
export type CloudflareWorkerVersionTag =
	BrandedString<'CloudflareWorkerVersionTag'>;
export type IsoDate = BrandedString<'IsoDate'>;

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

export interface RecoveryDeploymentTransition {
	readonly id: DeploymentRecoveryTransitionId;
	readonly from: DeploymentStateId;
	readonly to: DeploymentStateId;
	readonly kind:
		| 'restore-d1'
		| 'restore-durable-objects'
		| 'deploy-recovery-stage'
		| 'forward-repair'
		| 'adopt-predecessor-deployment';
	readonly checks: readonly DeploymentCheckId[];
}

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
	readonly legacyRuntimeFingerprints: readonly LegacyRuntimeFingerprintId[];
	readonly runtimeStages: readonly RuntimeStage[];
	readonly d1Migrations: readonly StructuralMigration[];
	readonly durableObjectMigrations: readonly StructuralMigration[];
	readonly dataMigrations: readonly DataMigrationId[];
	readonly checks: readonly DeploymentCheckId[];
}

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
	readonly bindings: readonly {
		readonly name: string;
		readonly type: string;
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
		(fingerprint) => fingerprint,
		'legacy runtime fingerprint'
	);
	uniqueBy(manifest.runtimeStages, (stage) => stage.id, 'runtime stage');
	uniqueBy(manifest.d1Migrations, (migration) => migration.id, 'D1 migration');
	uniqueBy(
		manifest.durableObjectMigrations,
		(migration) => migration.id,
		'Durable Object migration'
	);
	uniqueBy(manifest.dataMigrations, (migration) => migration, 'data migration');
	uniqueBy(manifest.checks, (check) => check, 'check');

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
		validateVerifyTransition(transition, from, to);
		validateTransitionEffect(transition, from, to);
	}

	const visited = new Set<DeploymentStateId>();
	let current: DeploymentStateId | undefined = manifest.initialState;

	while (current !== undefined) {
		if (visited.has(current)) {
			throw new DeploymentManifestError(
				'The forward transitions contain a cycle'
			);
		}

		visited.add(current);
		current = successorByState.get(current);
	}

	if (!visited.has(manifest.terminalState)) {
		throw new DeploymentManifestError(
			'The terminal state is not reachable from the initial state'
		);
	}
}

/**
Validates and brands a SHA-256 deployment content identity.
*/
export function deploymentContentId<Name extends string>(
	value: string,
	description: Name
): BrandedString<Name> {
	if (!/^[\da-f]{64}$/.test(value)) {
		throw new DeploymentManifestError(
			`${description} must be lowercase SHA-256`
		);
	}

	return value as BrandedString<Name>;
}
