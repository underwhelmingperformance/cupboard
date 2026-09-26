import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	currentLocalStep,
	deferredTransition,
	hasReachedTransitionState,
	isCompleteOnExpand,
	type LocalStep,
	type SchemaTransition,
	type TransitionId,
	type TransitionState,
	type TransitionStates
} from '@cupboard/protocol/deployment';

import {
	LocalStepUnreachedError,
	MisclassifiedD1MigrationsError,
	TransitionIncompleteError,
	TransitionMigrationsMissingError,
	TransitionNotExpandedError
} from '../errors.ts';

import type { D1QueryApi } from './d1-query.ts';
import {
	type CompatibilityPhase,
	type CompatibilityPhaseRecord,
	ensureTransitionTable,
	readLocalStepReadiness,
	readReconciledTransitions,
	type ReconciledTransitions,
	recordCompatibilityPhase,
	recordTransition
} from './deployment-state.ts';
import type { DatabaseId } from './identifiers.ts';
import {
	applyD1Migrations,
	type D1Migration,
	readAppliedD1Migrations,
	verifyD1MigrationDigests
} from './migrations.ts';

/**
A transition with the artifact's migrations that belong to it.
*/
export interface PlannedTransition<Id extends string = TransitionId> {
	readonly transition: SchemaTransition<Id>;
	readonly expand: readonly D1Migration[];
	readonly contract: readonly D1Migration[];
}

/**
 * Assigns the artifact's migrations to the transitions. The concatenation of
 * every transition's expand then contract, in list order, must equal the
 * migrations sorted by name; otherwise a migration has been added without a
 * transition, or listed under the wrong one, and the deploy stops with an
 * error before changing anything.
 */
export function planTransitions<Id extends string>(
	migrations: readonly D1Migration[],
	transitions: readonly SchemaTransition<Id>[]
): readonly PlannedTransition<Id>[] {
	const expected = transitions.flatMap((transition) => [
		...transition.expand,
		...transition.contract
	]);
	const sorted = migrations.toSorted((left, right) =>
		byCodeUnit(left.name, right.name)
	);
	const found = sorted.map((migration) => migration.name);
	const isMatches =
		expected.length === found.length &&
		expected.every((name, index) => name === found[index]);

	if (!isMatches) {
		throw new MisclassifiedD1MigrationsError(expected, found);
	}

	let next = 0;
	const take = (count: number): readonly D1Migration[] => {
		const slice = sorted.slice(next, next + count);
		next += count;
		return slice;
	};

	return transitions.map((transition) => ({
		transition,
		expand: take(transition.expand.length),
		contract: take(transition.contract.length)
	}));
}

export type TransitionEvent<Id extends string = TransitionId> =
	| {
			readonly kind: 'reconciled';
			readonly transition: Id;
			readonly state: TransitionState;
	  }
	| {
			readonly kind: 'expanded';
			readonly transition: Id;
			readonly applied: readonly string[];
	  }
	| {
			readonly kind: 'tenants-ready';
			readonly transition: Id;
			readonly step: LocalStep;
	  }
	| {
			readonly kind: 'complete';
			readonly transition: Id;
			readonly applied: readonly string[];
	  };

export interface TransitionHooks<Id extends string = TransitionId> {
	readonly now: () => Date;
	/**
	 * Throws unless both Workers serve this build. It checks once and does not
	 * wait for a rollout. `completeTransitions` calls it on every deploy, before
	 * it writes anything.
	 */
	readonly checkServing: () => Promise<void>;
	/**
	 * Wakes tenants until every active or suspended tenant has recorded the
	 * transition's contract step. Without it the walk only checks the tenants,
	 * and the hourly sweep wakes those below the required local step.
	 */
	readonly wakeTenants?: (contractStep: LocalStep) => Promise<void>;
	readonly report?: (event: TransitionEvent<Id>) => void;
}

/**
 * The inputs to the walk: the D1 query API, the transitions with their
 * migrations, and a set of hooks for what happens outside D1. The walk takes
 * all of them as parameters, so the upgrade tests run it against their own
 * database and Workers.
 */
export interface TransitionWalk<Id extends string = TransitionId> {
	readonly api: D1QueryApi;
	readonly databaseId: DatabaseId;
	readonly transitions: readonly PlannedTransition<Id>[];
	readonly hooks: TransitionHooks<Id>;
}

function isComplete<Id extends string>(
	states: TransitionStates<Id>,
	planned: PlannedTransition<Id>
): boolean {
	return hasReachedTransitionState(
		states.get(planned.transition.id),
		'complete'
	);
}

interface OpenedTransitions<
	Id extends string
> extends ReconciledTransitions<Id> {
	readonly states: Map<Id, TransitionState>;
}

async function readTransitions<Id extends string>(
	walk: TransitionWalk<Id>
): Promise<OpenedTransitions<Id>> {
	const read = await readReconciledTransitions(
		walk.api,
		walk.databaseId,
		walk.transitions.map((planned) => planned.transition)
	);

	return { ...read, states: new Map(read.states) };
}

/**
 * Creates `deployment_transition`, writes the reconciled states and repairs
 * the compatibility phase. The walk calls this only after all of the pre-write
 * checks pass, so a deploy that fails one of them writes nothing. Rows of
 * transitions that this build does not define stay as they are.
 */
async function recordOpenedTransitions<Id extends string>(
	walk: TransitionWalk<Id>,
	opened: OpenedTransitions<Id>
): Promise<void> {
	const { api, databaseId, hooks } = walk;

	await ensureTransitionTable(api, databaseId);

	for (const planned of walk.transitions) {
		const { id } = planned.transition;
		const state = opened.states.get(id);

		if (state === undefined || state === opened.stored.get(id)) {
			continue;
		}

		await recordTransition(api, databaseId, id, state, hooks.now(), {
			contractStarted: state === 'complete' && planned.contract.length > 0
		});
		hooks.report?.({ kind: 'reconciled', transition: id, state });
	}

	await repairCompatibilityPhase(walk, opened.states, opened.phase);
}

function compatibilityPhaseFor<Id extends string>(
	planned: PlannedTransition<Id>,
	stage: 'tenants-ready' | 'complete'
): { phase: CompatibilityPhase; requiredLocalStep: LocalStep } | undefined {
	if (planned.transition.compatibilityPhase !== true) {
		return undefined;
	}

	return stage === 'tenants-ready'
		? {
				phase: 'native-reads',
				requiredLocalStep: planned.transition.contractStep ?? currentLocalStep
			}
		: { phase: 'contracted', requiredLocalStep: currentLocalStep };
}

/**
 * A run can stop after it records a transition complete and before it writes
 * the compatibility phase. Each run therefore writes the phase again when the
 * recorded phase or its local step differs from what a complete transition
 * implies. The write never lowers a known phase.
 */
async function repairCompatibilityPhase<Id extends string>(
	walk: TransitionWalk<Id>,
	states: TransitionStates<Id>,
	phase: CompatibilityPhaseRecord | undefined
): Promise<void> {
	const { api, databaseId, hooks } = walk;

	for (const planned of walk.transitions) {
		const compatibility = compatibilityPhaseFor(planned, 'complete');

		if (
			compatibility === undefined ||
			!isComplete(states, planned) ||
			(compatibility.phase === phase?.phase &&
				String(compatibility.requiredLocalStep) === phase.requiredLocalStep)
		) {
			continue;
		}

		await recordCompatibilityPhase(
			api,
			databaseId,
			compatibility.phase,
			compatibility.requiredLocalStep,
			hooks.now()
		);
	}
}

async function expand<Id extends string>(
	walk: TransitionWalk<Id>,
	states: Map<Id, TransitionState>,
	planned: PlannedTransition<Id>
): Promise<void> {
	const { api, databaseId, hooks } = walk;
	const { id } = planned.transition;
	const applied =
		planned.expand.length === 0
			? []
			: await applyD1Migrations(api, databaseId, planned.expand);
	const wasExpanded = hasReachedTransitionState(states.get(id), 'expanded');

	if (!wasExpanded) {
		await recordTransition(api, databaseId, id, 'expanded', hooks.now());
		states.set(id, 'expanded');
	}

	if (wasExpanded && applied.length === 0) {
		return;
	}

	hooks.report?.({ kind: 'expanded', transition: id, applied });
}

async function reachContractStep<Id extends string>(
	walk: TransitionWalk<Id>,
	planned: PlannedTransition<Id>
): Promise<void> {
	const step = planned.transition.contractStep;

	if (step === undefined) {
		return;
	}

	const { api, databaseId, hooks } = walk;
	const { id } = planned.transition;
	let readiness = await readLocalStepReadiness(api, databaseId, step);

	if (readiness.pending > 0 && hooks.wakeTenants !== undefined) {
		await hooks.wakeTenants(step);
		readiness = await readLocalStepReadiness(api, databaseId, step);
	}

	if (readiness.pending > 0) {
		throw new LocalStepUnreachedError(
			readiness.pending,
			step,
			readiness.stragglers
		);
	}

	hooks.report?.({ kind: 'tenants-ready', transition: id, step });

	const compatibility = compatibilityPhaseFor(planned, 'tenants-ready');

	if (compatibility !== undefined) {
		await recordCompatibilityPhase(
			api,
			databaseId,
			compatibility.phase,
			compatibility.requiredLocalStep,
			hooks.now()
		);
	}
}

async function contract<Id extends string>(
	walk: TransitionWalk<Id>,
	states: Map<Id, TransitionState>,
	planned: PlannedTransition<Id>
): Promise<void> {
	const { api, databaseId, hooks } = walk;
	const { id } = planned.transition;

	// A build that does not define this transition refuses a row with
	// `contracted_at` set. Recording it before the first contract migration
	// covers a run that stops part-way through them.
	if (planned.contract.length > 0) {
		await recordTransition(api, databaseId, id, 'expanded', hooks.now(), {
			contractStarted: true
		});
	}

	const applied =
		planned.contract.length === 0
			? []
			: await applyD1Migrations(api, databaseId, planned.contract);

	await recordTransition(api, databaseId, id, 'complete', hooks.now());
	states.set(id, 'complete');

	const compatibility = compatibilityPhaseFor(planned, 'complete');

	if (compatibility !== undefined) {
		await recordCompatibilityPhase(
			api,
			databaseId,
			compatibility.phase,
			compatibility.requiredLocalStep,
			hooks.now()
		);
	}

	hooks.report?.({ kind: 'complete', transition: id, applied });
}

function allMigrations<Id extends string>(
	walk: TransitionWalk<Id>
): readonly D1Migration[] {
	return walk.transitions.flatMap((planned) => [
		...planned.expand,
		...planned.contract
	]);
}

function throwIfMigrationsMissing<Id extends string>(
	walk: TransitionWalk<Id>,
	states: TransitionStates<Id>,
	applied: ReadonlyMap<string, unknown>
): void {
	for (const planned of walk.transitions) {
		if (!isComplete(states, planned)) {
			continue;
		}

		const missing = [...planned.expand, ...planned.contract]
			.map((migration) => migration.name)
			.filter((name) => !applied.has(name));

		if (missing.length > 0) {
			throw new TransitionMigrationsMissingError(
				planned.transition.id,
				missing
			);
		}
	}
}

/**
 * The walk before the Workers are uploaded.
 *
 * The walk writes nothing until these checks pass:
 *
 * - every migration file matches the digest recorded when it was applied,
 *   including the migrations of complete transitions;
 * - every recorded row is one that `readStoredTransition` does not refuse: a
 *   transition and state that this build defines, or a transition that this
 *   build does not define and whose contract migrations have not started,
 *   which the walk leaves unchanged;
 * - every transition that the deployment records as complete has all of its
 *   migrations recorded in `d1_migrations`;
 * - no transition that is not independent follows a transition that is not
 *   complete. Such a transition could expand only after the upload. A fresh
 *   database is exempt, because every transition completes on it before the
 *   upload.
 *
 * No Workers of an earlier build serve a fresh database and it has no tenants,
 * so every transition's expand and contract migrations run now and each
 * transition is recorded complete. On any other database each incomplete
 * transition's expand migrations run and the transition is recorded
 * `expanded`. A transition with no contract migrations and no contract step is
 * then complete immediately. {@link completeTransitions} continues the others
 * after the upload.
 */
export async function prepareTransitions<Id extends string>(
	walk: TransitionWalk<Id>,
	isFresh: boolean
): Promise<TransitionStates<Id>> {
	const applied = await readAppliedD1Migrations(walk.api, walk.databaseId);

	verifyD1MigrationDigests(applied, allMigrations(walk));

	const opened = await readTransitions(walk);
	const { states } = opened;

	throwIfMigrationsMissing(walk, states, applied);

	const deferred = isFresh
		? undefined
		: deferredTransition(
				walk.transitions.map((planned) => planned.transition),
				states
			);

	if (deferred !== undefined) {
		throw new TransitionIncompleteError(
			deferred.waitsFor.id,
			deferred.transition.id,
			deferred.waitsFor.completedBy
		);
	}

	await recordOpenedTransitions(walk, opened);

	for (const planned of walk.transitions) {
		if (isComplete(states, planned)) {
			continue;
		}

		await expand(walk, states, planned);

		if (isFresh || isCompleteOnExpand(planned.transition)) {
			await contract(walk, states, planned);
		}
	}

	return states;
}

/**
 * The walk once the Workers have been uploaded. Before it writes anything, it
 * reads the states again and repeats the checks on the applied migrations. A
 * v0.0.34 or v0.0.35 deploy that runs during the upload can change the
 * `deployment_phase` row. The walk then checks that both Workers serve this
 * build, and throws `WorkersNotServingBuildError` while a script is split
 * across versions or still serves an earlier build. Then, in list order, it
 * wakes tenants until every active or suspended tenant has recorded each
 * incomplete transition's contract step, applies the transition's contract
 * migrations and records the transition complete. `LocalStepUnreachedError`
 * reports the tenants below the step.
 */
export async function completeTransitions<Id extends string>(
	walk: TransitionWalk<Id>
): Promise<TransitionStates<Id>> {
	const opened = await readTransitions(walk);
	const { states } = opened;
	const unexpanded = walk.transitions.find(
		(planned) =>
			!hasReachedTransitionState(states.get(planned.transition.id), 'expanded')
	);

	if (unexpanded !== undefined) {
		throw new TransitionNotExpandedError(unexpanded.transition.id);
	}

	const applied = await readAppliedD1Migrations(walk.api, walk.databaseId);

	verifyD1MigrationDigests(applied, allMigrations(walk));
	throwIfMigrationsMissing(walk, states, applied);

	await walk.hooks.checkServing();
	await recordOpenedTransitions(walk, opened);

	for (const planned of walk.transitions) {
		if (isComplete(states, planned)) {
			continue;
		}

		await reachContractStep(walk, planned);
		await contract(walk, states, planned);
	}

	return states;
}
