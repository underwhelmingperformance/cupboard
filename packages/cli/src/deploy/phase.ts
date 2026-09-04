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
 * Records the phase the deployment has reached. Rerunning it with the same
 * phase rewrites the row with a later timestamp and changes nothing else.
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
			`updated_at = excluded.updated_at;`
	]);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
