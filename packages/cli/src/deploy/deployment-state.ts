import {
	hasReachedTransitionState,
	type LocalStep,
	localStepStragglerSampleSize,
	readTransitionRow,
	type SchemaTransition,
	type TransitionId,
	type TransitionState,
	transitionStateRank,
	transitionStateSchema
} from '@cupboard/protocol/deployment';
import { isoTimestamp } from '@cupboard/protocol/scalars';

import { CliError } from '../errors.ts';

import { type D1QueryApi, sqlString } from './d1-query.ts';
import type { DatabaseId } from './identifiers.ts';

// `queryRows` returns one string per row, so a query concatenates its fields
// and the reader splits them. No transition id, state, phase name, step number
// or ISO timestamp contains a vertical bar.
const fieldSeparator = '|';

// Migration `0031` must create the same table. A test compares the two
// statements.
export const ensureTransitionTableStatement =
	'CREATE TABLE IF NOT EXISTS `deployment_transition` (`id` text PRIMARY KEY NOT NULL, `state` text NOT NULL, `updated_at` text NOT NULL, `contracted_at` text);';

// Every field is coalesced, so a NULL written by another release still gives
// one row, which the reader refuses.
const recordedTransitionsQuery = `SELECT COALESCE(id, '') || '${fieldSeparator}' || COALESCE(state, '') || '${fieldSeparator}' || COALESCE(updated_at, '') || '${fieldSeparator}' || COALESCE(contracted_at, '') FROM deployment_transition ORDER BY id;`;

const transitionTableQuery =
	"SELECT tbl_name FROM sqlite_master WHERE type = 'table' AND tbl_name = 'deployment_transition';";

// v0.0.34 and v0.0.35 read their phase from this one-row table, which a D1
// migration creates. `cupboard deploy` writes it for the transition that sets
// `compatibilityPhase`, so that a rollback to one of those releases reads a
// correct phase. Each deploy reads it to determine how far those releases got.
const compatibilityPhaseRowId = 'current';

const compatibilityPhases = [
	'current',
	'expanded',
	'native-reads',
	'contracted'
] as const;
export type CompatibilityPhase = (typeof compatibilityPhases)[number];

const recordedPhaseQuery = `SELECT phase || '${fieldSeparator}' || required_local_step FROM deployment_phase WHERE id = '${compatibilityPhaseRowId}';`;

const phaseTableQuery =
	"SELECT tbl_name FROM sqlite_master WHERE type = 'table' AND tbl_name = 'deployment_phase';";

const tenantColumnsQuery = "SELECT name FROM pragma_table_info('tenant');";

// `queryRows` keeps only string columns, so the count is cast to text.
const tenantCountQuery = 'SELECT CAST(count(*) AS TEXT) FROM tenant;';

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
 * This function does not write to D1. An object records its step when the
 * control Worker wakes it: from `localStep.wake`, or from a sweep chain that a
 * wake or the cron tick starts. The count therefore falls without further
 * calls from the deploy.
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
 * The deployment records a row that this build does not define: a known
 * transition in a state that this build does not define, or a transition that
 * this build does not define in a state other than `expanded` or `complete`.
 * The deploy has no steps to run for such a row, so it stops and reports the
 * stored id and state.
 */
export class UnknownDeploymentTransitionError extends CliError {
	constructor(
		public readonly transition: string,
		public readonly state: string,
		public readonly isKnownTransition: boolean
	) {
		super(
			isKnownTransition
				? `The deployment records transition '${transition}' in state '${state}'. This cupboard build defines the transition but not the state. Deploy a build that defines the state.`
				: `The deployment records transition '${transition}' in state '${state}'. This cupboard build defines neither the transition nor the state. Deploy a build that defines both.`
		);
		this.name = 'UnknownDeploymentTransitionError';
	}
}

/**
 * The deployment records that the contract migrations of a transition have
 * started, and this build does not define the transition. A later release
 * added it, and its contract migrations may have removed schema that this
 * build reads, so this build's deploy stops before it changes anything.
 */
export class UnrecognisedTransitionContractedError extends CliError {
	constructor(public readonly transition: string) {
		super(
			`The deployment records that the contract migrations of transition '${transition}' have started, and this cupboard build does not define that transition. Those migrations may have removed schema that this build needs. Stay on the deployed release, and use its cupboard deployment status and cupboard deployment resume. To roll back to this build anyway, first confirm that those contract migrations remove nothing that this build reads, then clear the row's contracted_at as described under "Rolling back" in docs/deploying.md, and deploy again.`
		);
		this.name = 'UnrecognisedTransitionContractedError';
	}
}

/**
 * A `deployment_transition` row did not split into its four fields, so a
 * field contains the separator that the query puts between them.
 */
export class InvalidTransitionRowError extends CliError {
	constructor(public readonly row: string) {
		super(
			`D1 returned a deployment_transition row that cannot be read: ${row}. Check the row in the deployment_transition table.`
		);
		this.name = 'InvalidTransitionRowError';
	}
}

/**
 * Whether the deploy may treat the deployment as fresh and apply every
 * migration before the upload. That is safe when no Worker of an earlier build
 * serves the database and it has no tenants to wake. A database without a
 * `tenant` table is fresh. So is one whose `tenant` table has no rows while
 * neither Worker script exists: a first deploy that stops after the migration
 * that creates the table, and before the upload, leaves that state.
 *
 * `columns` are the `tenant` columns when the caller has already read them.
 */
export async function isFreshDeployment(
	api: D1QueryApi,
	databaseId: DatabaseId,
	hasWorkerScripts: () => Promise<boolean>,
	columns?: readonly string[]
): Promise<boolean> {
	const tenantColumns = columns ?? (await readTenantColumns(api, databaseId));

	if (tenantColumns.length === 0) {
		return true;
	}

	const [count] = await api.queryRows(databaseId, tenantCountQuery);

	if (parseTenantReadinessCount(count) > 0) {
		return false;
	}

	return !(await hasWorkerScripts());
}

/**
The columns of the `tenant` table, or none when the table does not exist.
*/
export async function readTenantColumns(
	api: D1QueryApi,
	databaseId: DatabaseId
): Promise<readonly string[]> {
	return api.queryRows(databaseId, tenantColumnsQuery);
}

export type TransitionStates<Id extends string = TransitionId> = ReadonlyMap<
	Id,
	TransitionState
>;

export interface RecordedTransition<Id extends string = TransitionId> {
	readonly id: Id;
	readonly state: TransitionState;
	readonly updatedAt: string;
}

/**
 * A row in `deployment_transition`, with its id and state as stored. A row
 * can come from a later release, so neither has to be one that this build
 * defines. `contractedAt` is present once the deploy has started the
 * transition's contract migrations.
 */
export interface StoredTransitionRow {
	readonly id: string;
	readonly state: string;
	readonly updatedAt: string;
	readonly contractedAt?: string;
}

/**
 * Why the deploy refuses a stored row.
 *
 * - `contracted`: this build does not define the transition, and its contract
 *   migrations have started.
 * - `unknown-state`: this build defines the transition but not the state.
 * - `unknown-transition-and-state`: this build defines neither.
 */
export type TransitionRefusal =
	'contracted' | 'unknown-state' | 'unknown-transition-and-state';

/**
 * How this build's deploy treats one stored row.
 *
 * - `defined`: this build defines the transition and the state.
 * - `unrecognised`: this build does not define the transition, the state is
 *   `expanded` or `complete`, and no contract migration of the transition has
 *   started. Only its expand migrations have run, so the deploy leaves the row
 *   unchanged and applies only this build's transitions.
 * - `refused`: the deploy stops with an error before it changes anything.
 */
export type StoredTransitionReading<Id extends string = TransitionId> =
	| { readonly kind: 'defined'; readonly transition: RecordedTransition<Id> }
	| { readonly kind: 'unrecognised'; readonly row: StoredTransitionRow }
	| {
			readonly kind: 'refused';
			readonly reason: TransitionRefusal;
			readonly row: StoredTransitionRow;
	  };

export function readStoredTransition<Id extends string>(
	ids: readonly Id[],
	row: StoredTransitionRow
): StoredTransitionReading<Id> {
	const reading = readTransitionRow(ids, row);

	switch (reading.kind) {
		case 'defined': {
			return {
				kind: 'defined',
				transition: {
					id: reading.id,
					state: reading.state,
					updatedAt: row.updatedAt
				}
			};
		}

		case 'unknown-state': {
			return { kind: 'refused', reason: 'unknown-state', row };
		}

		case 'unknown-transition': {
			if (reading.state === undefined) {
				return { kind: 'refused', reason: 'unknown-transition-and-state', row };
			}

			return row.contractedAt === undefined
				? { kind: 'unrecognised', row }
				: { kind: 'refused', reason: 'contracted', row };
		}
	}
}

/**
The error that the deploy throws for a refused row.
*/
export function refusalError(
	reason: TransitionRefusal,
	row: StoredTransitionRow
): CliError {
	switch (reason) {
		case 'contracted': {
			return new UnrecognisedTransitionContractedError(row.id);
		}

		case 'unknown-state': {
			return new UnknownDeploymentTransitionError(row.id, row.state, true);
		}

		case 'unknown-transition-and-state': {
			return new UnknownDeploymentTransitionError(row.id, row.state, false);
		}
	}
}

/**
Creates the transition table where a deploy has not yet done so.
*/
export async function ensureTransitionTable(
	api: D1QueryApi,
	databaseId: DatabaseId
): Promise<void> {
	await api.queryBatch(databaseId, [ensureTransitionTableStatement]);
}

export interface RecordedTransitions<Id extends string = TransitionId> {
	/**
	The rows for the transitions in `ids`.
	*/
	readonly defined: readonly RecordedTransition<Id>[];
	/**
	The rows that {@link readStoredTransition} reads as `unrecognised`.
	*/
	readonly unrecognised: readonly StoredTransitionRow[];
}

function parseStoredTransitionRow(row: string): StoredTransitionRow {
	const [id, state, updatedAt, contractedAt, ...extra] =
		row.split(fieldSeparator);

	if (
		id === undefined ||
		state === undefined ||
		updatedAt === undefined ||
		contractedAt === undefined ||
		extra.length > 0
	) {
		throw new InvalidTransitionRowError(row);
	}

	return {
		id,
		state,
		updatedAt,
		...(contractedAt !== '' && { contractedAt })
	};
}

/**
 * The transitions recorded in `deployment_transition`, or none when no deploy
 * has created the table yet. Throws the error for the first row that the
 * deploy refuses.
 */
export async function readTransitionsForDeploy<Id extends string>(
	api: D1QueryApi,
	databaseId: DatabaseId,
	ids: readonly Id[]
): Promise<RecordedTransitions<Id>> {
	const tables = await api.queryRows(databaseId, transitionTableQuery);

	if (tables.length === 0) {
		return { defined: [], unrecognised: [] };
	}

	const rows = await api.queryRows(databaseId, recordedTransitionsQuery);
	const defined: RecordedTransition<Id>[] = [];
	const unrecognised: StoredTransitionRow[] = [];

	for (const row of rows) {
		const reading = readStoredTransition(ids, parseStoredTransitionRow(row));

		if (reading.kind === 'refused') {
			throw refusalError(reading.reason, reading.row);
		}

		if (reading.kind === 'unrecognised') {
			unrecognised.push(reading.row);
			continue;
		}

		defined.push(reading.transition);
	}

	return { defined, unrecognised };
}

export function transitionStatesOf<Id extends string>(
	recorded: readonly RecordedTransition<Id>[]
): TransitionStates<Id> {
	return new Map(recorded.map(({ id, state }) => [id, state]));
}

/**
The `deployment_phase` row, with its values as stored.
*/
export interface CompatibilityPhaseRecord {
	readonly phase: string;
	readonly requiredLocalStep: string;
}

/**
 * The phase that an earlier build recorded, or undefined when none is recorded
 * or the table does not exist yet. The name is returned unchanged, and
 * `reconcileTransitionStates` treats any name other than `native-reads` or
 * `contracted` as no phase.
 */
export async function readCompatibilityPhase(
	api: D1QueryApi,
	databaseId: DatabaseId
): Promise<CompatibilityPhaseRecord | undefined> {
	const tables = await api.queryRows(databaseId, phaseTableQuery);

	if (tables.length === 0) {
		return undefined;
	}

	const [row] = await api.queryRows(databaseId, recordedPhaseQuery);

	if (row === undefined) {
		return undefined;
	}

	const separator = row.lastIndexOf(fieldSeparator);

	return {
		phase: row.slice(0, separator),
		requiredLocalStep: row.slice(separator + 1)
	};
}

// The state that each phase name implies for the transition that sets
// `compatibilityPhase`. Released builds recorded only these two names:
// `native-reads` once the expand migrations had run and every active or
// suspended tenant had recorded local step 4, and `contracted` once the
// contract migrations had run too. Development builds between releases also
// recorded `current` and `expanded`, which do not show that the expand
// migrations ran.
const impliedByReleasedPhase = new Map<string, TransitionState>([
	['native-reads', 'expanded'],
	['contracted', 'complete']
]);

/**
 * Returns the stored states, with each transition that sets
 * `compatibilityPhase` raised to the state that the phase implies. Only the
 * phase names that a released build recorded imply a state; any other name
 * counts as no phase. The implied state replaces a recorded one only when it
 * is higher, so a rerun never lowers a state.
 */
export function reconcileTransitionStates<Id extends string>(
	stored: TransitionStates<Id>,
	phase: string | undefined,
	transitions: readonly SchemaTransition<Id>[]
): TransitionStates<Id> {
	const implied =
		phase === undefined ? undefined : impliedByReleasedPhase.get(phase);

	if (implied === undefined) {
		return stored;
	}

	const reconciled = new Map(stored);

	for (const transition of transitions) {
		if (
			transition.compatibilityPhase !== true ||
			hasReachedTransitionState(stored.get(transition.id), implied)
		) {
			continue;
		}

		reconciled.set(transition.id, implied);
	}

	return reconciled;
}

export interface ReconciledTransitions<Id extends string = TransitionId> {
	/**
	The states that `deployment_transition` records.
	*/
	readonly stored: TransitionStates<Id>;
	/**
	The `deployment_phase` row, or undefined when there is none.
	*/
	readonly phase: CompatibilityPhaseRecord | undefined;
	/**
	The stored states reconciled with the phase.
	*/
	readonly states: TransitionStates<Id>;
	/**
	The rows that {@link readStoredTransition} reads as `unrecognised`.
	*/
	readonly unrecognised: readonly StoredTransitionRow[];
}

/**
 * Reads the recorded states of the transitions and reconciles them with the
 * compatibility phase, without writing either. The plan uses the reconciled
 * states. The deploy also writes the difference from the stored states and
 * repairs the phase.
 */
export async function readReconciledTransitions<Id extends string>(
	api: D1QueryApi,
	databaseId: DatabaseId,
	transitions: readonly SchemaTransition<Id>[]
): Promise<ReconciledTransitions<Id>> {
	const recorded = await readTransitionsForDeploy(
		api,
		databaseId,
		transitions.map((transition) => transition.id)
	);
	const stored = transitionStatesOf(recorded.defined);
	const phase = await readCompatibilityPhase(api, databaseId);

	return {
		stored,
		phase,
		states: reconcileTransitionStates(stored, phase?.phase, transitions),
		unrecognised: recorded.unrecognised
	};
}

/**
 * Records the state that a transition has reached. With `contractStarted`, it
 * also records when the deploy started the transition's contract migrations.
 * The deploy of a build that does not define the transition reads this value.
 *
 * The timestamps record when the transition entered the state and when its
 * contract migrations started, so rerunning the deploy leaves them unchanged.
 * A rerun cannot lower a state that an earlier run already recorded, and a
 * state that this build does not define is never overwritten.
 */
export async function recordTransition(
	api: D1QueryApi,
	databaseId: DatabaseId,
	id: string,
	state: TransitionState,
	now: Date,
	options: { readonly contractStarted?: boolean } = {}
): Promise<void> {
	const states = transitionStateSchema.options;
	const storedRank = `CASE deployment_transition.state ${states.map((name) => `WHEN ${sqlString(name)} THEN ${String(transitionStateRank(name))}`).join(' ')} ELSE ${String(states.length)} END`;
	const timestamp = sqlString(isoTimestamp(now));
	const contractedAt = options.contractStarted === true ? timestamp : 'NULL';
	await api.queryBatch(databaseId, [
		`INSERT INTO deployment_transition (id, state, updated_at, contracted_at) ` +
			`VALUES (${sqlString(id)}, ${sqlString(state)}, ${timestamp}, ${contractedAt}) ` +
			`ON CONFLICT (id) DO UPDATE SET state = excluded.state, ` +
			`updated_at = CASE WHEN deployment_transition.state = excluded.state ` +
			`THEN deployment_transition.updated_at ELSE excluded.updated_at END, ` +
			`contracted_at = COALESCE(deployment_transition.contracted_at, excluded.contracted_at) ` +
			`WHERE ${storedRank} <= ${String(transitionStateRank(state))};`
	]);
}

/**
 * Records the phase that v0.0.34 and v0.0.35 read, for the transition that
 * sets `compatibilityPhase`: `native-reads` once every active or suspended
 * tenant has recorded local step 4, and `contracted` once its contract
 * migrations have run. The write never lowers a known phase and keeps the
 * timestamp of a phase already recorded, as those releases' deploys did. A
 * name that this build does not list is replaced, because no release writes
 * other names that it must keep.
 */
export async function recordCompatibilityPhase(
	api: D1QueryApi,
	databaseId: DatabaseId,
	phase: CompatibilityPhase,
	requiredLocalStep: LocalStep,
	now: Date
): Promise<void> {
	const storedRank = `CASE deployment_phase.phase ${compatibilityPhases.map((name, index) => `WHEN ${sqlString(name)} THEN ${String(index)}`).join(' ')} ELSE -1 END`;
	await api.queryBatch(databaseId, [
		`INSERT INTO deployment_phase (id, phase, required_local_step, updated_at) ` +
			`VALUES (${sqlString(compatibilityPhaseRowId)}, ${sqlString(phase)}, ${String(requiredLocalStep)}, ${sqlString(isoTimestamp(now))}) ` +
			`ON CONFLICT (id) DO UPDATE SET phase = excluded.phase, ` +
			`required_local_step = excluded.required_local_step, ` +
			`updated_at = CASE WHEN deployment_phase.phase = excluded.phase ` +
			`AND deployment_phase.required_local_step = excluded.required_local_step ` +
			`THEN deployment_phase.updated_at ELSE excluded.updated_at END ` +
			`WHERE ${storedRank} <= ${String(compatibilityPhases.indexOf(phase))};`
	]);
}
