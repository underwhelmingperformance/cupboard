import {
	hasReachedTransitionState,
	requiredLocalStepFrom
} from '@cupboard/protocol/deployment';
import { workersInvocationAllowances } from '@cupboard/protocol/platform';
import type { ResultRow } from '@cupboard/reporter';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import type { D1Migration } from './migrations.ts';
import { withWorkersInvocationAllowance } from './overrides.ts';
import type { LocalStepReadiness, TransitionStates } from './phase.ts';
import {
	parseTenantReadinessCount,
	readLocalStepReadiness,
	readTransitionStates
} from './phase.ts';
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
			// The recorded states, reconciled from the preceding release's phase.
			readonly transitions: TransitionStates;
			readonly readiness: LocalStepReadiness;
	  };

/**
The reviewed artifact and the schema transitions one deployment walks.
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
		transitions: planTransitions(artifact.d1Migrations)
	};
}

function migrationNames(migrations: readonly D1Migration[]): string {
	return migrations.map((migration) => migration.name).join(', ') || '(none)';
}

/**
 * What one run does for a transition, from what the observation recorded: a
 * fresh database gets every transition before the upload; otherwise a pending
 * transition expands before the upload and contracts after the tenants
 * settle, an expanded one only contracts, and a complete one is left alone.
 */
function transitionStageText(
	planned: PlannedTransition,
	observation: DeploymentObservation
): string {
	const { transition } = planned;
	const settle =
		transition.settleStep === undefined
			? ''
			: ` once every tenant reaches local step ${String(transition.settleStep)}`;
	const contract =
		planned.contract.length === 0
			? 'no contract'
			: `contract after upload${settle}: ${migrationNames(planned.contract)}`;
	const expand = `expand before upload: ${migrationNames(planned.expand)}`;

	if (observation.kind === 'offline') {
		return `unknown (offline); ${expand}; ${contract}`;
	}

	if (observation.kind === 'new') {
		return 'new deployment; expand and contract before upload';
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

export async function observeDeployment(
	api: CloudflareApi,
	artifact: DeploymentArtifact
): Promise<DeploymentObservation> {
	const name = artifact.config.tenant.d1Databases[0]?.databaseName;
	const database =
		name === undefined ? undefined : await api.findD1Database(name);
	if (database === undefined) {
		return { kind: 'new' };
	}
	const phaseApi = {
		queryRows: api.d1QueryRows.bind(api),
		queryBatch: api.d1QueryBatch.bind(api)
	};
	const transitions = await readTransitionStates(phaseApi, database);
	const columns = await api.d1QueryRows(
		database,
		"SELECT name FROM pragma_table_info('tenant');"
	);
	if (columns.includes('local_step')) {
		return {
			kind: 'existing',
			transitions,
			readiness: await readLocalStepReadiness(
				phaseApi,
				database,
				requiredLocalStepFrom(transitions)
			)
		};
	}
	if (columns.length === 0) {
		return { kind: 'new' };
	}
	const [pending] = await api.d1QueryRows(
		database,
		"SELECT CAST(count(*) AS TEXT) FROM tenant WHERE status IN ('active', 'suspended');"
	);
	return {
		kind: 'existing',
		transitions,
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
