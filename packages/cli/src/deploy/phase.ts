import {
	type DeploymentPhaseName,
	deploymentPhaseRowId,
	deploymentPhaseSchema,
	type LocalStep,
	type ParsedDeploymentPhase
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';

import type { DatabaseId } from './identifiers.ts';

export interface PhaseApi {
	queryBatch(
		databaseId: DatabaseId,
		statements: readonly string[]
	): Promise<void>;
	queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
}

// The D1 query API returns one column per row, so the query concatenates the
// three fields and the reader splits them again. A vertical bar is safe as the
// separator because no phase name, step number or timestamp contains one.
const fieldSeparator = '|';

const recordedPhaseQuery = `SELECT phase || '${fieldSeparator}' || required_local_step || '${fieldSeparator}' || updated_at FROM deployment_phase WHERE id = '${deploymentPhaseRowId}';`;

// How many stragglers a readiness query names. A separate query supplies the
// count, so this limit bounds only the list an error can print.
const laggingTenantSampleSize = 20;

export interface TenantReadiness {
	readonly pending: number;
	readonly stragglers: readonly string[];
}

async function countAndName(
	api: PhaseApi,
	databaseId: DatabaseId,
	predicate: string
): Promise<TenantReadiness> {
	const counted = await api.queryRows(
		databaseId,
		`SELECT count(*) FROM tenant WHERE ${predicate};`
	);
	const [count] = counted;

	if (count === undefined || count === '0') {
		return { pending: 0, stragglers: [] };
	}

	return {
		pending: Number(count),
		stragglers: await api.queryRows(
			databaseId,
			`SELECT id FROM tenant WHERE ${predicate} ORDER BY id LIMIT ${String(laggingTenantSampleSize)};`
		)
	};
}

/**
 * Counts the active tenants whose object has not reached the step this build
 * requires, and returns up to {@link laggingTenantSampleSize} of their ids.
 *
 * A phase describes what every object has already done, so recording one while
 * a tenant is behind would claim work that has not happened. This function
 * only reads: the control plane's scheduled sweep is what wakes a tenant with
 * no traffic of its own, so the count falls without the deploy doing anything
 * and a later deploy can record the phase.
 */
export function readLocalStepReadiness(
	api: PhaseApi,
	databaseId: DatabaseId,
	requiredStep: LocalStep
): Promise<TenantReadiness> {
	return countAndName(
		api,
		databaseId,
		`status = 'active' AND (local_step IS NULL OR local_step < ${String(requiredStep)})`
	);
}

/**
 * This build does not define the stored phase name. That happens after a
 * rollback past a release that added a phase. The deploy has no steps to run
 * for such a phase, so it stops and reports the name it found.
 */
export class UnknownDeploymentPhaseError extends Error {
	constructor(public readonly recorded: string) {
		super(
			`The deployment is in phase '${recorded}', which this cupboard build does not know. Deploy the build that introduced that phase.`
		);
		this.name = 'UnknownDeploymentPhaseError';
	}
}

/**
 * Returns the phase the deployment is in, or undefined when no deploy has
 * recorded one. A deployment set up before phases existed has no phase row.
 *
 * `cupboard deploy` reads this row when it starts. Every step it then takes is
 * idempotent, so running the deploy again after an interrupted run repeats the
 * steps that already ran and continues from the recorded phase.
 */
export async function readDeploymentPhase(
	api: PhaseApi,
	databaseId: DatabaseId
): Promise<ParsedDeploymentPhase | undefined> {
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
 * deploy in the same phase leaves it where it was. The contraction measures the
 * predecessor's drain from it, and a rerun must not push that deadline further
 * away.
 */
export async function recordDeploymentPhase(
	api: PhaseApi,
	databaseId: DatabaseId,
	phase: DeploymentPhaseName,
	requiredLocalStep: LocalStep,
	now: Date
): Promise<void> {
	await api.queryBatch(databaseId, [
		`INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) ` +
			`VALUES (${quote(deploymentPhaseRowId)}, ${quote(phase)}, ${String(requiredLocalStep)}, ${quote(isoTimestamp(now))}) ` +
			`ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, ` +
			`required_local_step = excluded.required_local_step, ` +
			`updated_at = CASE WHEN deployment_phase.phase = excluded.phase ` +
			`AND deployment_phase.required_local_step = excluded.required_local_step ` +
			`THEN deployment_phase.updated_at ELSE excluded.updated_at END;`
	]);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
