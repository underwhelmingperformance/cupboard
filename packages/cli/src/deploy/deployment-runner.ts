import {
	type CloudflareDeploymentObservation,
	type DeploymentAdvanceInput,
	type DeploymentAdvanceResult,
	type DeploymentAttemptId,
	type DeploymentExternalAction,
	type DeploymentIdentity,
	type DeploymentRevision,
	type DeploymentStateId,
	type DeploymentStatus
} from '@cupboard/protocol/deployment';
import type {
	DeploymentManifestBody,
	ForwardDeploymentTransition,
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

function nextTransition(
	manifest: DeploymentManifestBody,
	state: DeploymentStateId
): ForwardDeploymentTransition | undefined {
	return manifest.forwardTransitions.find(
		(transition) => transition.from === state
	);
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

function existingAttempt(
	status: Extract<DeploymentStatus, { state: 'current' }>,
	transition: ForwardDeploymentTransition
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
	transition: ForwardDeploymentTransition,
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
