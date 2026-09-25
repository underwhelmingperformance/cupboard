import {
	hasReachedTransitionState,
	type LocalStep,
	localStepStragglerSampleSize,
	type TransitionId,
	transitionIdSchema,
	type TransitionState,
	transitionStateRank,
	transitionStateSchema
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';

import { CliError } from '../errors.ts';

import type { DatabaseId } from './identifiers.ts';

export interface PhaseApi {
	queryBatch(
		databaseId: DatabaseId,
		statements: readonly string[]
	): Promise<void>;
	queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
}

// `queryRows` returns one string per row, so a query concatenates its fields
// and the reader splits them. No transition id, state, phase name, step number
// or ISO timestamp contains a vertical bar.
const fieldSeparator = '|';

// The deploy owns this table, like `d1_migrations`: it has to record the first
// transition on a database from before the migration that also creates it.
const ensureTransitionTableStatement =
	'CREATE TABLE IF NOT EXISTS deployment_transition (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL);';

const recordedTransitionsQuery = `SELECT id || '${fieldSeparator}' || state || '${fieldSeparator}' || updated_at FROM deployment_transition ORDER BY id;`;

const transitionTableQuery =
	"SELECT tbl_name FROM sqlite_master WHERE type = 'table' AND tbl_name = 'deployment_transition';";

// The preceding release read its phase from this one-row table, which a D1
// migration creates. This build keeps writing it for the `cache-identity`
// transition so a rollback to that release reads a correct phase, and reads
// it once to learn how far that release got.
const compatibilityPhaseRowId = 'current';

const compatibilityPhases = [
	'current',
	'expanded',
	'native-reads',
	'contracted'
] as const;
export type CompatibilityPhase = (typeof compatibilityPhases)[number];

const recordedPhaseQuery = `SELECT phase FROM deployment_phase WHERE id = '${compatibilityPhaseRowId}';`;

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
	api: PhaseApi,
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
 * This build does not define the stored transition id or state. That happens
 * after a rollback past a release that added one. The deploy has no steps to
 * run for such a transition, so it stops and reports what it found.
 */
export class UnknownDeploymentTransitionError extends CliError {
	constructor(
		public readonly transition: string,
		public readonly state: string
	) {
		super(
			`The deployment records transition '${transition}' in state '${state}', which this cupboard build does not know. Deploy the build that introduced it.`
		);
		this.name = 'UnknownDeploymentTransitionError';
	}
}

export type TransitionStates = ReadonlyMap<TransitionId, TransitionState>;

export interface RecordedTransition {
	readonly id: TransitionId;
	readonly state: TransitionState;
	readonly updatedAt: string;
}

/**
Creates the transition table where a deploy has not yet done so.
*/
export async function ensureTransitionTable(
	api: PhaseApi,
	databaseId: DatabaseId
): Promise<void> {
	await api.queryBatch(databaseId, [ensureTransitionTableStatement]);
}

/**
 * The transitions recorded in `deployment_transition`, or none when no deploy
 * has created the table yet. Throws `UnknownDeploymentTransitionError` for a
 * row this build does not define.
 */
export async function readRecordedTransitions(
	api: PhaseApi,
	databaseId: DatabaseId
): Promise<readonly RecordedTransition[]> {
	const tables = await api.queryRows(databaseId, transitionTableQuery);

	if (tables.length === 0) {
		return [];
	}

	const rows = await api.queryRows(databaseId, recordedTransitionsQuery);

	return rows.map((row) => {
		const [id = row, state = '', updatedAt = ''] = row.split(fieldSeparator);
		const parsedId = transitionIdSchema.safeParse(id);
		const parsedState = transitionStateSchema.safeParse(state);

		if (!parsedId.success || !parsedState.success) {
			throw new UnknownDeploymentTransitionError(id, state);
		}

		return { id: parsedId.data, state: parsedState.data, updatedAt };
	});
}

export function transitionStatesOf(
	recorded: readonly RecordedTransition[]
): TransitionStates {
	return new Map(recorded.map(({ id, state }) => [id, state]));
}

/**
 * The phase the preceding release recorded, or undefined when it recorded
 * none or the table does not exist yet. A name this build does not list is
 * returned as it is: the reconciliation below only asks whether it is
 * `contracted`.
 */
export async function readCompatibilityPhase(
	api: PhaseApi,
	databaseId: DatabaseId
): Promise<string | undefined> {
	const tables = await api.queryRows(databaseId, phaseTableQuery);

	if (tables.length === 0) {
		return undefined;
	}

	const [phase] = await api.queryRows(databaseId, recordedPhaseQuery);

	return phase;
}

/**
 * The states with what the preceding release's phase implies for the
 * `cache-identity` transition: `contracted` means its contract ran, so it is
 * complete; any other recorded phase means at least its expansion ran. The
 * implied state replaces a recorded one only when it is higher, so a rerun
 * never lowers a state.
 */
export function reconcileTransitionStates(
	stored: TransitionStates,
	phase: string | undefined
): TransitionStates {
	if (phase === undefined) {
		return stored;
	}

	const implied: TransitionState =
		phase === 'contracted' ? 'complete' : 'expanded';

	if (hasReachedTransitionState(stored.get('cache-identity'), implied)) {
		return stored;
	}

	return new Map([...stored, ['cache-identity', implied]]);
}

/**
 * Reads the recorded transitions and reconciles them from the compatibility
 * phase, without writing either.
 */
export async function readTransitionStates(
	api: PhaseApi,
	databaseId: DatabaseId
): Promise<TransitionStates> {
	const stored = transitionStatesOf(
		await readRecordedTransitions(api, databaseId)
	);

	return reconcileTransitionStates(
		stored,
		await readCompatibilityPhase(api, databaseId)
	);
}

/**
 * Records the state a transition has reached.
 *
 * The timestamp says when the transition entered the state, so rerunning the
 * deploy in the same state leaves it unchanged. A rerun cannot lower a state
 * that an earlier run already recorded, and a state this build does not
 * define is never overwritten.
 */
export async function recordTransition(
	api: PhaseApi,
	databaseId: DatabaseId,
	id: TransitionId,
	state: TransitionState,
	now: Date
): Promise<void> {
	const states = transitionStateSchema.options;
	const storedRank = `CASE deployment_transition.state ${states.map((name) => `WHEN ${quote(name)} THEN ${String(transitionStateRank(name))}`).join(' ')} ELSE ${String(states.length)} END`;
	await api.queryBatch(databaseId, [
		`INSERT INTO deployment_transition (id, state, updated_at) ` +
			`VALUES (${quote(id)}, ${quote(state)}, ${quote(isoTimestamp(now))}) ` +
			`ON CONFLICT (id) DO UPDATE SET state = excluded.state, ` +
			`updated_at = CASE WHEN deployment_transition.state = excluded.state ` +
			`THEN deployment_transition.updated_at ELSE excluded.updated_at END ` +
			`WHERE ${storedRank} <= ${String(transitionStateRank(state))};`
	]);
}

/**
 * Records the phase the preceding release reads, for the `cache-identity`
 * transition: `native-reads` once its tenants have settled and `contracted`
 * once its contract has run. The write is monotonic and keeps the timestamp
 * of a phase already recorded, as that release's own deploy did.
 */
export async function recordCompatibilityPhase(
	api: PhaseApi,
	databaseId: DatabaseId,
	phase: CompatibilityPhase,
	requiredLocalStep: LocalStep,
	now: Date
): Promise<void> {
	const storedRank = `CASE deployment_phase.phase ${compatibilityPhases.map((name, index) => `WHEN ${quote(name)} THEN ${String(index)}`).join(' ')} ELSE ${String(compatibilityPhases.length)} END`;
	await api.queryBatch(databaseId, [
		`INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) ` +
			`VALUES (${quote(compatibilityPhaseRowId)}, ${quote(phase)}, ${String(requiredLocalStep)}, ${quote(isoTimestamp(now))}) ` +
			`ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, ` +
			`required_local_step = excluded.required_local_step, ` +
			`updated_at = CASE WHEN deployment_phase.phase = excluded.phase ` +
			`AND deployment_phase.required_local_step = excluded.required_local_step ` +
			`THEN deployment_phase.updated_at ELSE excluded.updated_at END ` +
			`WHERE ${storedRank} <= ${String(compatibilityPhases.indexOf(phase))};`
	]);
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}
