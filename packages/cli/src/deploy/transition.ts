import {
	contractionMigrations,
	expansionLocalStep,
	type ParsedDeploymentPhase
} from '@cupboard/protocol/deployment';
import {
	freeTierD1StatementsPerInvocation,
	paidTierD1StatementsPerInvocation
} from '@cupboard/protocol/platform';
import type { ResultRow } from '@cupboard/reporter';

import { UnclassifiedD1MigrationError } from '../errors.ts';

import type { DeploymentArtifact } from './artifact.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import { type D1Migration, unclassifiedD1Migrations } from './migrations.ts';
import { withD1StatementAllowance } from './overrides.ts';
import type { LocalStepReadiness } from './phase.ts';
import {
	parseTenantReadinessCount,
	readDeploymentPhase,
	readLocalStepReadiness
} from './phase.ts';
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
			readonly phase: ParsedDeploymentPhase | undefined;
			readonly readiness: LocalStepReadiness;
	  };

/**
The reviewed artifact and migration stages that one deployment executes.
*/
export interface DeploymentPlan {
	readonly artifact: DeploymentArtifact;
	readonly transition: 'cache-identity-v1';
	readonly allowanceSource: WorkersAllowanceSource;
	readonly observation: DeploymentObservation;
	readonly preparation: readonly D1Migration[];
	readonly contraction: readonly D1Migration[];
}

export function planDeployment(
	artifact: DeploymentArtifact,
	observation: DeploymentObservation,
	allowanceSource?: WorkersAllowanceSource
): DeploymentPlan {
	const unclassified = unclassifiedD1Migrations(artifact.d1Migrations);
	if (unclassified.length > 0) {
		throw new UnclassifiedD1MigrationError(unclassified);
	}

	return {
		artifact,
		transition: 'cache-identity-v1',
		allowanceSource: allowanceSource ?? { kind: 'configuration' },
		observation,
		preparation: artifact.d1Migrations.filter(
			(migration) => !contractionMigrations.includes(migration.name)
		),
		contraction: artifact.d1Migrations.filter((migration) =>
			contractionMigrations.includes(migration.name)
		)
	};
}

export function transitionPlanRows(plan: DeploymentPlan): ResultRow[] {
	const observed = plan.observation;
	return [
		{ label: 'Storage transition', value: plan.transition },
		{
			label: 'D1 allowance source',
			value: workersAllowanceSourceText(plan.allowanceSource)
		},
		{
			label: 'Current phase',
			value:
				observed.kind === 'offline'
					? 'unknown (offline)'
					: observed.kind === 'new'
						? 'new deployment'
						: (observed.phase?.name ?? 'not recorded')
		},
		{
			label: 'Before upload',
			value:
				plan.preparation.map((migration) => migration.name).join(', ') ||
				'(none)'
		},
		{
			label: 'Tenant readiness',
			value:
				observed.kind === 'offline'
					? 'unknown (offline)'
					: observed.kind === 'new'
						? 'no existing tenants'
						: `${String(observed.readiness.pending)} pending at local step ${String(expansionLocalStep)}`
		},
		{
			label: 'After settlement',
			value:
				plan.contraction.map((migration) => migration.name).join(', ') ||
				'(none)'
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
		},
		{ label: 'Target phase', value: 'contracted' }
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
	const phase = await readDeploymentPhase(phaseApi, database);
	const columns = await api.d1QueryRows(
		database,
		"SELECT name FROM pragma_table_info('tenant');"
	);
	if (columns.includes('local_step')) {
		return {
			kind: 'existing',
			phase,
			readiness: await readLocalStepReadiness(
				phaseApi,
				database,
				expansionLocalStep
			)
		};
	}
	if (columns.length === 0) {
		return { kind: 'new' };
	}
	const [pending] = await api.d1QueryRows(
		database,
		"SELECT CAST(count(*) AS TEXT) FROM tenant WHERE status = 'active';"
	);
	return {
		kind: 'existing',
		phase,
		readiness: {
			pending: parseTenantReadinessCount(pending),
			stragglers: await api.d1QueryRows(
				database,
				"SELECT id FROM tenant WHERE status = 'active' ORDER BY id LIMIT 20;"
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
			config: withD1StatementAllowance(
				artifact.config,
				override === 'paid'
					? paidTierD1StatementsPerInvocation
					: freeTierD1StatementsPerInvocation
			)
		},
		{ kind: 'offline' },
		override === undefined
			? { kind: 'offline' }
			: { kind: 'override', plan: override }
	);
}
