import {
	type CloudflareDeploymentObservation,
	type DeploymentAdoptionResult,
	type DeploymentAdoptPredecessorInput,
	type DeploymentAdvanceInput,
	type DeploymentAdvanceResult,
	type DeploymentAttemptId,
	type DeploymentExternalAction,
	type DeploymentIdentity,
	type DeploymentPrepareSuccessorInput,
	type DeploymentRecoverInput,
	type DeploymentRecoveryResult,
	type DeploymentRevision,
	type DeploymentStateId,
	type DeploymentStatus,
	type SuccessorPreparationResult
} from '@cupboard/protocol/deployment';
import type {
	DeploymentManifestBody,
	ForwardDeploymentTransition,
	RecoveryDeploymentTransition,
	RuntimeStageId
} from '@cupboard/protocol/deployment-manifest';
import { runtimeStageIdSchema } from '@cupboard/protocol/deployment-manifest';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { DatabaseId } from './identifiers.ts';
import { applyDeclaredD1Migrations, type D1Migration } from './migrations.ts';

export interface DeploymentRunnerClient {
	status(input: {
		readonly deployment: DeploymentIdentity;
	}): Promise<DeploymentStatus>;
	advance(input: DeploymentAdvanceInput): Promise<DeploymentAdvanceResult>;
	prepareSuccessor(
		input: DeploymentPrepareSuccessorInput
	): Promise<SuccessorPreparationResult>;
	adoptPredecessor(
		input: DeploymentAdoptPredecessorInput
	): Promise<DeploymentAdoptionResult>;
}

export interface DeploymentRecoveryClient extends DeploymentRunnerClient {
	recover(input: DeploymentRecoverInput): Promise<DeploymentRecoveryResult>;
}

export type ExecuteDeploymentExternalAction = (
	action: DeploymentExternalAction,
	attemptId: DeploymentAttemptId
) => Promise<CloudflareDeploymentObservation>;

export type RuntimeStageObservation = Extract<
	CloudflareDeploymentObservation,
	{ readonly kind: 'runtime-stage' }
>;

export interface CloudflareDeploymentExecutorOptions {
	readonly api: Pick<
		CloudflareApi,
		'd1QueryBatch' | 'd1QueryRows' | 'getD1Bookmark' | 'restoreD1Database'
	>;
	readonly databaseId: DatabaseId;
	readonly d1Migrations: readonly D1Migration[];
	readonly deployRuntimeStage: (
		stage: RuntimeStageId
	) => Promise<RuntimeStageObservation>;
}

function observedD1Migrations(
	allMigrations: readonly D1Migration[],
	declaredNames: readonly string[]
): Extract<
	CloudflareDeploymentObservation,
	{ readonly kind: 'd1-migrations' }
> {
	const byName = new Map<string, D1Migration>();

	for (const migration of allMigrations) {
		byName.set(migration.name, migration);
	}

	return {
		kind: 'd1-migrations',
		migrations: declaredNames.map((id) => {
			const migration = byName.get(id);

			if (migration === undefined) {
				throw new DeploymentManifestResponseError(
					`The artifact does not contain D1 migration ${id}`
				);
			}

			return { id, sha256: migration.sha256 };
		})
	};
}

export function cloudflareDeploymentExecutor(
	options: CloudflareDeploymentExecutorOptions
): ExecuteDeploymentExternalAction {
	return async (action) => {
		if (action.kind === 'apply-d1') {
			await applyDeclaredD1Migrations(
				{
					queryBatch: (databaseId, statements) =>
						options.api.d1QueryBatch(databaseId, statements),
					queryRows: (databaseId, sql) =>
						options.api.d1QueryRows(databaseId, sql)
				},
				options.databaseId,
				options.d1Migrations,
				action.migrations
			);

			return observedD1Migrations(options.d1Migrations, action.migrations);
		}

		if (action.kind === 'capture-d1-recovery-point') {
			return {
				kind: 'd1-recovery-point',
				databaseId: options.databaseId,
				bookmark: await options.api.getD1Bookmark(options.databaseId)
			};
		}

		if (action.kind === 'restore-d1') {
			if (action.databaseId !== options.databaseId) {
				throw new DeploymentManifestResponseError(
					`The control plane requested recovery for D1 database ${action.databaseId}, but this deployment uses ${options.databaseId}`
				);
			}

			const restored = await options.api.restoreD1Database(
				options.databaseId,
				action.preContractBookmark
			);

			return {
				kind: 'd1-restoration',
				databaseId: options.databaseId,
				preContractBookmark: action.preContractBookmark,
				undoBookmark: restored.undoBookmark,
				recoveryEnvelopeKey: action.recoveryEnvelopeKey
			};
		}

		return options.deployRuntimeStage(runtimeStageIdSchema.parse(action.stage));
	};
}

export type DeploymentAdvanceOutcome =
	| {
			readonly state: 'completed';
			readonly deploymentState: DeploymentStateId;
			readonly revision: DeploymentRevision;
	  }
	| {
			readonly state: 'running';
			readonly deploymentState: DeploymentStateId;
			readonly revision: DeploymentRevision;
			readonly attemptId: DeploymentAttemptId;
	  };

export class DeploymentNotInitialisedError extends Error {
	constructor() {
		super('The deployment ledger has not been initialised');
		this.name = 'DeploymentNotInitialisedError';
	}
}

export class DeploymentManifestResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DeploymentManifestResponseError';
	}
}

export class DeploymentTransitionFailedError extends Error {
	constructor(
		public readonly code: string,
		public readonly detail?: string
	) {
		super(
			detail === undefined
				? `Deployment transition failed: ${code}`
				: `Deployment transition failed: ${code}: ${detail}`
		);
		this.name = 'DeploymentTransitionFailedError';
	}
}

interface AdvanceDeploymentOptions {
	readonly client: DeploymentRunnerClient;
	readonly deployment: DeploymentIdentity;
	readonly manifest: DeploymentManifestBody;
	readonly executeExternalAction: ExecuteDeploymentExternalAction;
}

interface RecoverDeploymentOptions {
	readonly client: DeploymentRecoveryClient;
	readonly deployment: DeploymentIdentity;
	readonly manifest: DeploymentManifestBody;
	readonly targetState: DeploymentStateId;
	readonly executeExternalAction: ExecuteDeploymentExternalAction;
}

type ExecutableRecoveryTransition = Exclude<
	RecoveryDeploymentTransition,
	{ readonly kind: 'adopt-predecessor-deployment' }
>;

interface AdoptSuccessorDeploymentOptions {
	readonly predecessorClient: DeploymentRunnerClient;
	readonly connectSuccessor: () => Promise<DeploymentRunnerClient>;
	readonly predecessor: DeploymentIdentity;
	readonly successor: DeploymentIdentity;
	readonly manifest: DeploymentManifestBody;
	readonly deployRuntimeStage: (
		stage: RuntimeStageId
	) => Promise<RuntimeStageObservation>;
}

function successorTransition(
	manifest: DeploymentManifestBody,
	predecessor: DeploymentIdentity,
	state: DeploymentStateId
): Extract<
	RecoveryDeploymentTransition,
	{ readonly kind: 'adopt-predecessor-deployment' }
> {
	const matches = manifest.recoveryTransitions.filter(
		(transition) =>
			transition.kind === 'adopt-predecessor-deployment' &&
			transition.predecessorState === state &&
			transition.compatiblePredecessorArtifacts.includes(predecessor.artifactId)
	);
	const [transition, ...extra] = matches;

	if (transition?.kind !== 'adopt-predecessor-deployment' || extra.length > 0) {
		throw new DeploymentManifestResponseError(
			`The manifest does not contain one successor transition for predecessor state ${state}`
		);
	}

	return transition;
}

function successorRuntimeStage(
	manifest: DeploymentManifestBody,
	transition: Extract<
		RecoveryDeploymentTransition,
		{ readonly kind: 'adopt-predecessor-deployment' }
	>
): RuntimeStageId {
	const target = manifest.states.find((state) => state.id === transition.to);

	if (
		target?.tenantRuntime.kind !== 'registered' ||
		target.controlRuntime.kind !== 'registered' ||
		target.tenantRuntime.stage !== target.controlRuntime.stage
	) {
		throw new DeploymentManifestResponseError(
			`Successor state ${transition.to} does not deploy one registered runtime stage`
		);
	}

	return target.tenantRuntime.stage;
}

/**
 * Replaces a failed deployment with the sole compatible successor declared by
 * the new manifest. The predecessor is fenced before the CLI uploads the new
 * runtime, and the new runtime must observe and adopt that exact preparation.
 */
export async function adoptSuccessorDeployment(
	options: AdoptSuccessorDeploymentOptions
): Promise<
	Extract<DeploymentAdoptionResult, { readonly outcome: 'completed' }>
> {
	const status = await options.predecessorClient.status({
		deployment: options.predecessor
	});

	if (status.state !== 'current') {
		throw new DeploymentNotInitialisedError();
	}

	const transition = successorTransition(
		options.manifest,
		options.predecessor,
		status.deploymentState
	);
	const prepared = await options.predecessorClient.prepareSuccessor({
		predecessor: options.predecessor,
		successor: options.successor,
		expectedState: status.deploymentState,
		expectedRevision: status.revision
	});
	const stage = successorRuntimeStage(options.manifest, transition);
	const observation = await options.deployRuntimeStage(stage);
	const successorClient = await options.connectSuccessor();
	const adopted = await successorClient.adoptPredecessor({
		predecessor: options.predecessor,
		successor: options.successor,
		predecessorState: status.deploymentState,
		expectedRevision: prepared.revision,
		attemptId: prepared.execution.attemptId,
		externalObservation: observation
	});

	if (adopted.outcome === 'failed') {
		throw new DeploymentTransitionFailedError(
			adopted.failure.code,
			adopted.failure.detail
		);
	}

	if (
		adopted.deployment.artifactId !== options.successor.artifactId ||
		adopted.deployment.instanceId !== options.successor.instanceId ||
		adopted.state !== transition.to ||
		adopted.revision !== prepared.revision + 1
	) {
		throw new DeploymentManifestResponseError(
			'The successor runtime adopted an unexpected deployment state'
		);
	}

	return adopted;
}

function nextTransition(
	manifest: DeploymentManifestBody,
	state: DeploymentStateId
): ForwardDeploymentTransition | undefined {
	return manifest.forwardTransitions.find(
		(transition) => transition.from === state
	);
}

function recoveryTransition(
	manifest: DeploymentManifestBody,
	from: DeploymentStateId,
	to: DeploymentStateId
): ExecutableRecoveryTransition {
	const matches = manifest.recoveryTransitions.filter(
		(transition) =>
			transition.kind !== 'adopt-predecessor-deployment' &&
			transition.from === from &&
			transition.to === to
	);
	const [transition, ...extra] = matches;

	if (
		transition === undefined ||
		transition.kind === 'adopt-predecessor-deployment' ||
		extra.length > 0
	) {
		throw new DeploymentManifestResponseError(
			`The manifest does not contain one recovery transition from ${from} to ${to}`
		);
	}

	return transition;
}

function expectedExternalAction(
	transition: ForwardDeploymentTransition
): DeploymentExternalAction | undefined {
	if (transition.kind === 'apply-d1') {
		return { kind: 'apply-d1', migrations: [...transition.migrations] };
	}

	if (transition.kind === 'deploy-runtime-stage') {
		return {
			kind: 'deploy-runtime-stage',
			stage: transition.stage,
			tenantFirst: true
		};
	}

	if (
		transition.kind === 'record-recovery-point' &&
		transition.storage === 'd1'
	) {
		return { kind: 'capture-d1-recovery-point' };
	}
}

function assertExternalAction(
	transition: ForwardDeploymentTransition,
	action: DeploymentExternalAction
): void {
	const expected = expectedExternalAction(transition);

	if (
		expected === undefined ||
		JSON.stringify(action) !== JSON.stringify(expected)
	) {
		throw new DeploymentManifestResponseError(
			`The control plane returned an external action which does not match transition ${transition.id}`
		);
	}
}

function assertRecoveryExternalAction(
	transition: ExecutableRecoveryTransition,
	action: DeploymentExternalAction
): void {
	if (
		transition.kind === 'deploy-recovery-stage' &&
		action.kind === 'deploy-runtime-stage' &&
		action.stage === transition.stage
	) {
		return;
	}

	if (transition.kind === 'restore-d1' && action.kind === 'restore-d1') {
		return;
	}

	throw new DeploymentManifestResponseError(
		`The control plane returned an external action which does not match recovery transition ${transition.id}`
	);
}

function existingAttempt(
	status: Extract<DeploymentStatus, { state: 'current' }>,
	transition:
		Pick<ForwardDeploymentTransition, 'id'> | ExecutableRecoveryTransition
): DeploymentAttemptId | undefined {
	const execution = status.execution;

	if (
		execution?.transitionId !== transition.id ||
		execution.status !== 'running'
	) {
		return;
	}

	if (execution.attemptId === undefined) {
		throw new DeploymentManifestResponseError(
			`Running transition ${transition.id} has no attempt ID`
		);
	}

	return execution.attemptId;
}

function completedOutcome(
	result: Extract<DeploymentAdvanceResult, { outcome: 'completed' }>,
	transition:
		| Pick<ForwardDeploymentTransition, 'id' | 'to'>
		| ExecutableRecoveryTransition,
	expectedRevision: DeploymentRevision
): DeploymentAdvanceOutcome {
	if (
		result.state !== transition.to ||
		result.revision !== expectedRevision + 1
	) {
		throw new DeploymentManifestResponseError(
			`Transition ${transition.id} completed at an unexpected state or revision`
		);
	}

	return {
		state: 'completed',
		deploymentState: result.state,
		revision: result.revision
	};
}

function runningOutcome(
	result: Extract<DeploymentAdvanceResult, { outcome: 'running' }>,
	status: Extract<DeploymentStatus, { state: 'current' }>
): DeploymentAdvanceOutcome {
	return {
		state: 'running',
		deploymentState: status.deploymentState,
		revision: status.revision,
		attemptId: result.attemptId
	};
}

function failTransition(
	result: Extract<DeploymentAdvanceResult, { outcome: 'failed' }>
): never {
	throw new DeploymentTransitionFailedError(
		result.failure.code,
		result.failure.detail
	);
}

async function settleAdvanceResult(
	options: AdvanceDeploymentOptions,
	status: Extract<DeploymentStatus, { state: 'current' }>,
	transition: ForwardDeploymentTransition,
	input: DeploymentAdvanceInput,
	result: DeploymentAdvanceResult
): Promise<DeploymentAdvanceOutcome> {
	if (result.outcome === 'completed') {
		return completedOutcome(result, transition, status.revision);
	}

	if (result.outcome === 'running') {
		return runningOutcome(result, status);
	}

	if (result.outcome === 'failed') {
		return failTransition(result);
	}

	assertExternalAction(transition, result.action);
	const observation = await options.executeExternalAction(
		result.action,
		result.attemptId
	);
	const observed = await options.client.advance({
		...input,
		attemptId: result.attemptId,
		externalObservation: observation
	});

	if (observed.outcome === 'external-action-required') {
		throw new DeploymentManifestResponseError(
			`Transition ${transition.id} requested another external action after observing the first one`
		);
	}

	if (observed.outcome === 'completed') {
		return completedOutcome(observed, transition, status.revision);
	}

	if (observed.outcome === 'running') {
		return runningOutcome(observed, status);
	}

	return failTransition(observed);
}

/**
 * Advances at most one manifest transition. The control plane claims a
 * transition before this function performs an external Cloudflare action.
 */
export async function advanceDeployment(
	options: AdvanceDeploymentOptions
): Promise<DeploymentAdvanceOutcome> {
	const status = await options.client.status({
		deployment: options.deployment
	});

	if (status.state === 'uninitialised') {
		throw new DeploymentNotInitialisedError();
	}

	if (status.deploymentState === options.manifest.terminalState) {
		return {
			state: 'completed',
			deploymentState: status.deploymentState,
			revision: status.revision
		};
	}

	const transition = nextTransition(options.manifest, status.deploymentState);

	if (transition === undefined || status.nextState !== transition.to) {
		throw new DeploymentManifestResponseError(
			`The control plane state ${status.deploymentState} does not have the manifest's next transition`
		);
	}

	const attemptId = existingAttempt(status, transition);
	const input: DeploymentAdvanceInput = {
		deployment: options.deployment,
		expectedState: transition.from,
		targetState: transition.to,
		expectedRevision: status.revision,
		...(attemptId !== undefined && { attemptId })
	};
	const result = await options.client.advance(input);

	return settleAdvanceResult(options, status, transition, input, result);
}

async function settleRecoveryResult(
	options: RecoverDeploymentOptions,
	status: Extract<DeploymentStatus, { state: 'current' }>,
	transition: ExecutableRecoveryTransition,
	input: DeploymentRecoverInput,
	result: DeploymentRecoveryResult
): Promise<DeploymentAdvanceOutcome> {
	if (result.outcome === 'completed') {
		return completedOutcome(result, transition, status.revision);
	}

	if (result.outcome === 'running') {
		return runningOutcome(result, status);
	}

	if (result.outcome === 'failed') {
		return failTransition(result);
	}

	assertRecoveryExternalAction(transition, result.action);
	const observation = await options.executeExternalAction(
		result.action,
		result.attemptId
	);
	const observed = await options.client.recover({
		...input,
		attemptId: result.attemptId,
		externalObservation: observation
	});

	if (observed.outcome === 'external-action-required') {
		throw new DeploymentManifestResponseError(
			`Recovery transition ${transition.id} requested another external action after observing the first one`
		);
	}

	if (observed.outcome === 'completed') {
		return completedOutcome(observed, transition, status.revision);
	}

	if (observed.outcome === 'running') {
		return runningOutcome(observed, status);
	}

	return failTransition(observed);
}

/**
 * Advances one manifest-declared recovery edge from the current deployment
 * state. The caller chooses only the target state; the control plane derives
 * the recovery operation and claims it before the CLI performs any external
 * action.
 */
export async function recoverDeployment(
	options: RecoverDeploymentOptions
): Promise<DeploymentAdvanceOutcome> {
	const status = await options.client.status({
		deployment: options.deployment
	});

	if (status.state === 'uninitialised') {
		throw new DeploymentNotInitialisedError();
	}

	const transition = recoveryTransition(
		options.manifest,
		status.deploymentState,
		options.targetState
	);
	const attemptId = existingAttempt(status, transition);
	const input: DeploymentRecoverInput = {
		deployment: options.deployment,
		expectedState: transition.from,
		targetRecoveryState: transition.to,
		expectedRevision: status.revision,
		...(attemptId !== undefined && { attemptId })
	};
	const result = await options.client.recover(input);

	return settleRecoveryResult(options, status, transition, input, result);
}
