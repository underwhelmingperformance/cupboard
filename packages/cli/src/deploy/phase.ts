import {
	type DeploymentPhaseName,
	deploymentPhaseNameSchema,
	deploymentPhaseRowId,
	deploymentPhaseSchema,
	type LocalStep,
	localStepStragglerSampleSize,
	type ParsedDeploymentPhase
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';

import { CliError, LocalStepUnreachedError } from '../errors.ts';

import { type D1QueryApi, sqlString } from './d1-query.ts';
import type { DatabaseId } from './identifiers.ts';

// `queryRows` returns one string per row, so the query concatenates the three
// fields and the reader splits them. No phase name, step number or ISO
// timestamp contains a vertical bar.
const fieldSeparator = '|';

const recordedPhaseQuery = `SELECT phase || '${fieldSeparator}' || required_local_step || '${fieldSeparator}' || updated_at FROM deployment_phase WHERE id = '${deploymentPhaseRowId}';`;

// The table is created by a D1 migration, so a deployment that has not yet run
// that migration has no table to query.
const phaseTableQuery =
	"SELECT tbl_name FROM sqlite_master WHERE type = 'table' AND tbl_name = 'deployment_phase';";

export class InvalidTenantReadinessCountError extends CliError {
	constructor() {
		super(
			'Invalid tenant readiness count returned by D1. Retry the deployment after checking the D1 response.'
		);
		this.name = 'InvalidTenantReadinessCountError';
	}
}

export function parseTenantReadinessCount(count: string | undefined): number {
	if (
		count === undefined ||
		!/^\d+$/.test(count) ||
		!Number.isSafeInteger(Number(count))
	) {
		throw new InvalidTenantReadinessCountError();
	}
	return Number(count);
}

export interface LocalStepReadiness {
	readonly pending: number;
	readonly stragglers: readonly string[];
}

/**
 * Counts active and suspended tenants below the required step and returns up
 * to {@link localStepStragglerSampleSize} of their ids in slug order.
 *
 * This only reads. An object records its step when the control Worker wakes
 * it, which the hourly sweep does for the tenants that are behind, so the
 * count falls without the deploy doing anything.
 */
export async function readLocalStepReadiness(
	api: D1QueryApi,
	databaseId: DatabaseId,
	requiredStep: LocalStep
): Promise<LocalStepReadiness> {
	const behind = `status IN ('active', 'suspended') AND (local_step IS NULL OR local_step < ${String(requiredStep)})`;
	// `d1QueryRows` keeps only string columns, so the count is cast to text; a
	// bare `count(*)` comes back as a number and is dropped.
	const counted = await api.queryRows(
		databaseId,
		`SELECT CAST(count(*) AS TEXT) FROM tenant WHERE ${behind};`
	);
	const [count] = counted;

	const pending = parseTenantReadinessCount(count);

	if (pending === 0) {
		return { pending: 0, stragglers: [] };
	}

	return {
		pending,
		stragglers: await api.queryRows(
			databaseId,
			`SELECT id FROM tenant WHERE ${behind} ORDER BY id LIMIT ${String(localStepStragglerSampleSize)};`
		)
	};
}

/**
 * Records `phase` once every active or suspended tenant has reached
 * `requiredStep`. A phase describes what every tenant's object has already
 * done. If a tenant is behind, this throws `LocalStepUnreachedError` and
 * leaves the row unchanged.
 */
export async function recordPhaseWhenTenantsReady(
	api: D1QueryApi,
	databaseId: DatabaseId,
	phase: DeploymentPhaseName,
	requiredStep: LocalStep,
	now: Date
): Promise<LocalStepReadiness> {
	const readiness = await readLocalStepReadiness(api, databaseId, requiredStep);

	if (readiness.pending > 0) {
		throw new LocalStepUnreachedError(
			readiness.pending,
			requiredStep,
			readiness.stragglers
		);
	}

	await recordDeploymentPhase(api, databaseId, phase, requiredStep, now);

	return readiness;
}

/**
 * This build does not define the stored phase name. That happens after a
 * rollback past a release that added a phase. The deploy has no steps to run
 * for such a phase, so it stops and reports the name it found.
 */
export class UnknownDeploymentPhaseError extends CliError {
	constructor(public readonly recorded: string) {
		super(
			`The deployment is in phase '${recorded}', which this cupboard build does not know. Deploy the build that introduced that phase.`
		);
		this.name = 'UnknownDeploymentPhaseError';
	}
}

/**
 * Returns the phase the deployment is in, or undefined when no deploy has
 * recorded one or the `deployment_phase` table does not exist yet.
 */
export async function readDeploymentPhase(
	api: D1QueryApi,
	databaseId: DatabaseId
): Promise<ParsedDeploymentPhase | undefined> {
	const tables = await api.queryRows(databaseId, phaseTableQuery);

	if (tables.length === 0) {
		return undefined;
	}

	const [row] = await api.queryRows(databaseId, recordedPhaseQuery);

	if (row === undefined) {
		return undefined;
	}

	const [name, step, updatedAt] = row.split(fieldSeparator);
	const parsed = deploymentPhaseSchema.safeParse({
		name,
		requiredLocalStep: Number(step),
		updatedAt
	});

	if (!parsed.success) {
		throw new UnknownDeploymentPhaseError(name ?? row);
	}

	return parsed.data;
}

/**
 * Records the phase the deployment has reached.
 *
 * The timestamp says when the deployment entered the phase, so rerunning the
 * deploy in the same phase leaves it unchanged. A rerun cannot lower a phase
 * that an earlier run already completed.
 */
export async function recordDeploymentPhase(
	api: D1QueryApi,
	databaseId: DatabaseId,
	phase: DeploymentPhaseName,
	requiredLocalStep: LocalStep,
	now: Date
): Promise<void> {
	const phases = deploymentPhaseNameSchema.options;
	const storedRank = `CASE deployment_phase.phase ${phases.map((name, index) => `WHEN ${sqlString(name)} THEN ${String(index)}`).join(' ')} ELSE ${String(phases.length)} END`;
	await api.queryBatch(databaseId, [
		`INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) ` +
			`VALUES (${sqlString(deploymentPhaseRowId)}, ${sqlString(phase)}, ${String(requiredLocalStep)}, ${sqlString(isoTimestamp(now))}) ` +
			`ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, ` +
			`required_local_step = excluded.required_local_step, ` +
			`updated_at = CASE WHEN deployment_phase.phase = excluded.phase ` +
			`AND deployment_phase.required_local_step = excluded.required_local_step ` +
			`THEN deployment_phase.updated_at ELSE excluded.updated_at END ` +
			`WHERE ${storedRank} <= ${String(phases.indexOf(phase))};`
	]);
}
