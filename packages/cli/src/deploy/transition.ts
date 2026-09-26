import {
	type DeferredTransition,
	deferredTransition,
	hasReachedTransitionState,
	requiredLocalStepFrom,
	type SchemaTransition,
	schemaTransitions
} from '@cupboard/protocol/deployment';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import type { ResultRow } from '@cupboard/reporter';

import { completingReleases, TransitionIncompleteError } from '../errors.ts';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type {
	LocalStepReadiness,
	StoredTransitionRow,
	TransitionStates
} from './deployment-state.ts';
import {
	isFreshDeployment,
	parseTenantReadinessCount,
	readLocalStepReadiness,
	readReconciledTransitions,
	readTenantColumns
} from './deployment-state.ts';
import type { D1Migration } from './migrations.ts';
import { withWorkersInvocationAllowance } from './overrides.ts';
import { type PlannedTransition, planTransitions } from './transitions.ts';
import {
	type WorkersAllowanceSource,
	workersAllowanceSourceText,
	type WorkersPlanOverride
} from './workers-plan.ts';

export type DeploymentObservation =
	| { readonly kind: 'offline' }
	| { readonly kind: 'new' }
	| {
			readonly kind: 'existing';
			// The recorded states, reconciled with the preceding release's phase.
			readonly transitions: TransitionStates;
			readonly readiness: LocalStepReadiness;
			// The transition that makes the deploy stop, because it could expand
			// only after the upload. Undefined when the deploy can proceed.
			readonly blocked: DeferredTransition | undefined;
			// The rows of transitions that this build does not define and whose
			// contract migrations have not started. The deploy leaves them
			// unchanged.
			readonly unrecognised: readonly StoredTransitionRow[];
	  };

/**
The reviewed artifact and the schema transitions that one deployment applies.
*/
export interface DeploymentPlan {
	readonly artifact: DeploymentArtifact;
	readonly allowanceSource: WorkersAllowanceSource;
	readonly observation: DeploymentObservation;
	readonly transitions: readonly PlannedTransition[];
}

export function planDeployment(
	artifact: DeploymentArtifact,
	observation: DeploymentObservation,
	allowanceSource?: WorkersAllowanceSource
): DeploymentPlan {
	return {
		artifact,
		allowanceSource: allowanceSource ?? { kind: 'configuration' },
		observation,
		transitions: planTransitions(artifact.d1Migrations, schemaTransitions)
	};
}

function migrationNames(migrations: readonly D1Migration[]): string {
	return migrations.map((migration) => migration.name).join(', ') || '(none)';
}

/**
 * What one run does for a transition, from the observed states. On a fresh
 * database the deploy applies every migration before the upload. Otherwise
 * the deploy expands a pending transition before the upload and applies its
 * contract migrations after it; for an expanded one it applies only the
 * contract migrations, and it leaves a complete one alone. When a transition
 * could expand only after the upload, the deploy stops with an error, and the
 * plan row for that transition shows what to deploy first.
 */
function transitionStageText(
	planned: PlannedTransition,
	observation: DeploymentObservation
): string {
	const { transition } = planned;
	const tenants =
		transition.contractStep === undefined
			? ''
			: ` once every active or suspended tenant has recorded local step ${String(transition.contractStep)}`;
	const contract =
		planned.contract.length === 0
			? 'no contract'
			: `contract after upload${tenants}: ${migrationNames(planned.contract)}`;
	const expand = `expand before upload: ${migrationNames(planned.expand)}`;

	if (observation.kind === 'offline') {
		return `unknown (offline); ${expand}; ${contract}`;
	}

	if (observation.kind === 'new') {
		return 'new deployment; expand and contract before upload';
	}

	const { blocked } = observation;

	if (blocked?.transition.id === transition.id) {
		const releases = completingReleases(
			blocked.waitsFor.id,
			blocked.waitsFor.completedBy,
			transition.id
		);

		return `blocked: '${blocked.waitsFor.id}' must be complete before this transition can expand; first run cupboard deploy with ${releases}; the deployed release qualifies only if its own deploy stopped before completing '${blocked.waitsFor.id}'`;
	}

	const recorded = observation.transitions.get(transition.id);

	if (hasReachedTransitionState(recorded, 'complete')) {
		return 'complete';
	}

	if (hasReachedTransitionState(recorded, 'expanded')) {
		return `expanded; ${contract}`;
	}

	return `pending; ${expand}; ${contract}`;
}

/**
 * Throws the error that the deploy would throw for the observed states. The
 * deploy command calls this after it shows the plan and before it asks for
 * confirmation, so a blocked deploy creates no credentials or resources. The
 * deploy checks again, because the states can change between the plan and the
 * run.
 */
export function throwIfPlanBlocked(plan: DeploymentPlan): void {
	const { observation } = plan;

	if (observation.kind !== 'existing' || observation.blocked === undefined) {
		return;
	}

	const { transition, waitsFor } = observation.blocked;

	throw new TransitionIncompleteError(
		waitsFor.id,
		transition.id,
		waitsFor.completedBy
	);
}

export function transitionPlanRows(plan: DeploymentPlan): ResultRow[] {
	const observed = plan.observation;
	const requiredStep =
		observed.kind === 'existing'
			? requiredLocalStepFrom(observed.transitions)
			: undefined;

	return [
		{
			label: 'Subrequest allowance source',
			value: workersAllowanceSourceText(plan.allowanceSource)
		},
		...plan.transitions.map((planned) => ({
			label: `Transition ${planned.transition.id}`,
			value: transitionStageText(planned, observed)
		})),
		...(observed.kind === 'existing' ? observed.unrecognised : []).map(
			(row) => ({
				label: `Transition ${row.id}`,
				value: `${row.state}; this build does not define this transition, and no contract migration of it has started, so the deploy leaves it unchanged`
			})
		),
		{
			label: 'Tenant readiness',
			value:
				observed.kind === 'offline'
					? 'unknown (offline)'
					: observed.kind === 'new'
						? 'no existing tenants'
						: `${String(observed.readiness.pending)} pending at local step ${String(requiredStep)}`
		},
		{
			label: 'Rollback boundary',
			value:
				'Uploading the tenant Worker allows each object to contract its local SQLite schema. After that point, recover by completing this deployment; redeploying an older Worker cannot restore removed tables.'
		},
		{
			label: 'Settlement',
			value:
				'Up to 100 batches of 20 tenants; failures remain resumable with cupboard deployment resume.'
		}
	];
}

/**
Whether either of the artifact's Worker scripts exists in the account.
*/
export async function hasWorkerScripts(
	api: Pick<CloudflareApi, 'getScriptConfiguration'>,
	artifact: DeploymentArtifact
): Promise<boolean> {
	const configurations = await Promise.all(
		[artifact.config.control.name, artifact.config.tenant.name].map(
			(scriptName) => api.getScriptConfiguration(scriptName)
		)
	);

	return configurations.some((configuration) => configuration !== undefined);
}

export async function observeDeployment(
	api: CloudflareApi,
	artifact: DeploymentArtifact,
	transitions: readonly SchemaTransition[] = schemaTransitions
): Promise<DeploymentObservation> {
	const name = artifact.config.tenant.d1Databases[0]?.databaseName;
	const database =
		name === undefined ? undefined : await api.findD1Database(name);
	if (database === undefined) {
		return { kind: 'new' };
	}
	const d1QueryApi = {
		queryRows: api.d1QueryRows.bind(api),
		queryBatch: api.d1QueryBatch.bind(api)
	};
	const columns = await readTenantColumns(d1QueryApi, database);
	if (
		await isFreshDeployment(
			d1QueryApi,
			database,
			() => hasWorkerScripts(api, artifact),
			columns
		)
	) {
		return { kind: 'new' };
	}
	const { states, unrecognised } = await readReconciledTransitions(
		d1QueryApi,
		database,
		transitions
	);
	const blocked = deferredTransition(transitions, states);
	if (columns.includes('local_step')) {
		return {
			kind: 'existing',
			transitions: states,
			readiness: await readLocalStepReadiness(
				d1QueryApi,
				database,
				requiredLocalStepFrom(states)
			),
			blocked,
			unrecognised
		};
	}
	const [pending] = await api.d1QueryRows(
		database,
		"SELECT CAST(count(*) AS TEXT) FROM tenant WHERE status IN ('active', 'suspended');"
	);
	return {
		kind: 'existing',
		transitions: states,
		blocked,
		unrecognised,
		readiness: {
			pending: parseTenantReadinessCount(pending),
			stragglers: await api.d1QueryRows(
				database,
				"SELECT id FROM tenant WHERE status IN ('active', 'suspended') ORDER BY id LIMIT 20;"
			)
		}
	};
}

export function planOfflineDeployment(
	artifact: DeploymentArtifact,
	override?: WorkersPlanOverride
): DeploymentPlan {
	return planDeployment(
		{
			...artifact,
			config: withWorkersInvocationAllowance(
				artifact.config,
				workersInvocationAllowances[override ?? 'free']
			)
		},
		{ kind: 'offline' },
		override === undefined
			? { kind: 'offline' }
			: { kind: 'override', plan: override }
	);
}
