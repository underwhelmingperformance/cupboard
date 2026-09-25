import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	currentLocalStep,
	hasReachedTransitionState,
	type LocalStep,
	type SchemaTransition,
	schemaTransitions,
	type TransitionId,
	type TransitionState
} from '@cupboard/protocol/deployment';

import {
	LocalStepUnreachedError,
	MisclassifiedD1MigrationsError,
	TransitionIncompleteError
} from '../errors.ts';

import type { DatabaseId } from './identifiers.ts';
import { applyD1Migrations, type D1Migration } from './migrations.ts';
import {
	type CompatibilityPhase,
	ensureTransitionTable,
	type PhaseApi,
	readCompatibilityPhase,
	readLocalStepReadiness,
	readRecordedTransitions,
	reconcileTransitionStates,
	recordCompatibilityPhase,
	recordTransition,
	type TransitionStates,
	transitionStatesOf
} from './phase.ts';

/**
A transition with the artifact's migrations that belong to it.
*/
export interface PlannedTransition {
	readonly transition: SchemaTransition;
	readonly expand: readonly D1Migration[];
	readonly contract: readonly D1Migration[];
}

class PlannedMigrationMissingError extends Error {
	constructor(public readonly migration: string) {
		super(`The artifact does not contain migration ${migration}`);
		this.name = 'PlannedMigrationMissingError';
	}
}

/**
 * Assigns the artifact's migrations to the transitions. The concatenation of
 * every transition's expand then contract, in list order, must equal the
 * migrations sorted by name; otherwise a migration has been added without a
 * transition, or listed under the wrong one, and the deploy refuses before
 * changing anything.
 */
export function planTransitions(
	migrations: readonly D1Migration[],
	transitions: readonly SchemaTransition[] = schemaTransitions
): readonly PlannedTransition[] {
	const expected = transitions.flatMap((transition) => [
		...transition.expand,
		...transition.contract
	]);
	const found = migrations
		.map((migration) => migration.name)
		.toSorted(byCodeUnit);
	const isMatches =
		expected.length === found.length &&
		expected.every((name, index) => name === found[index]);

	if (!isMatches) {
		throw new MisclassifiedD1MigrationsError(expected, found);
	}

	const byName = new Map(
		migrations.map((migration) => [migration.name, migration])
	);
	const named = (name: string): D1Migration => {
		const migration = byName.get(name);

		if (migration === undefined) {
			throw new PlannedMigrationMissingError(name);
		}

		return migration;
	};

	return transitions.map((transition) => ({
		transition,
		expand: transition.expand.map((name) => named(name)),
		contract: transition.contract.map((name) => named(name))
	}));
}

export type TransitionEvent =
	| {
			readonly kind: 'reconciled';
			readonly transition: TransitionId;
			readonly state: TransitionState;
	  }
	| { readonly kind: 'deferred'; readonly transition: TransitionId }
	| {
			readonly kind: 'expanded';
			readonly transition: TransitionId;
			readonly applied: readonly string[];
	  }
	| {
			readonly kind: 'settled';
			readonly transition: TransitionId;
			readonly step: LocalStep;
	  }
	| {
			readonly kind: 'complete';
			readonly transition: TransitionId;
			readonly applied: readonly string[];
	  };

export interface TransitionHooks {
	readonly now: () => Date;
	/**
	 * Throws unless both Workers serve this build. The post-upload walk calls
	 * it once, before it continues the first pending transition.
	 */
	readonly awaitServing: () => Promise<void>;
	/**
	 * Brings every active tenant to the step. Without it the walk only checks
	 * readiness, which the hourly sweep advances on its own.
	 */
	readonly settleTenants?: (requiredStep: LocalStep) => Promise<void>;
	readonly report?: (event: TransitionEvent) => void;
}

/**
 * Everything the walk touches: the D1 query surface, the transitions with
 * their migrations, and hooks for what happens outside D1. The walk is pure
 * over these, so the deploy and the upgrade tests run the same code.
 */
export interface TransitionWalk {
	readonly api: PhaseApi;
	readonly databaseId: DatabaseId;
	readonly transitions: readonly PlannedTransition[];
	/**
	 * Every transition before this one must be complete before the build can
	 * deploy at all. Undefined when the build serves every state.
	 */
	readonly requiresCompleteBefore?: TransitionId;
	readonly hooks: TransitionHooks;
}

function isComplete(
	states: TransitionStates,
	planned: PlannedTransition
): boolean {
	return hasReachedTransitionState(
		states.get(planned.transition.id),
		'complete'
	);
}

/**
 * Reads the recorded states, reconciled from the phase the preceding release
 * recorded, refuses a build that needs a transition this deployment has not
 * completed, and only then creates the table and writes the reconciled
 * states. A refusal therefore precedes every write.
 */
async function openTransitions(
	walk: TransitionWalk
): Promise<Map<TransitionId, TransitionState>> {
	const { api, databaseId, hooks } = walk;
	const stored = transitionStatesOf(
		await readRecordedTransitions(api, databaseId)
	);
	const states = new Map(
		reconcileTransitionStates(
			stored,
			await readCompatibilityPhase(api, databaseId)
		)
	);

	if (walk.requiresCompleteBefore !== undefined) {
		for (const planned of walk.transitions) {
			if (planned.transition.id === walk.requiresCompleteBefore) {
				break;
			}

			if (!isComplete(states, planned)) {
				throw new TransitionIncompleteError(
					planned.transition.id,
					planned.transition.completedBy
				);
			}
		}
	}

	await ensureTransitionTable(api, databaseId);

	for (const [id, state] of states) {
		if (state === stored.get(id)) {
			continue;
		}

		await recordTransition(api, databaseId, id, state, hooks.now());
		hooks.report?.({ kind: 'reconciled', transition: id, state });
	}

	return states;
}

// The preceding release reads its phase from `deployment_phase`, and it only
// knows the cache-identity transition. The deploy keeps that row current for
// one release so a rollback to that build reads a correct phase.
function compatibilityPhaseFor(
	planned: PlannedTransition,
	stage: 'settled' | 'complete'
): { phase: CompatibilityPhase; requiredLocalStep: LocalStep } | undefined {
	if (planned.transition.id !== 'cache-identity') {
		return undefined;
	}

	return stage === 'settled'
		? {
				phase: 'native-reads',
				requiredLocalStep: planned.transition.settleStep ?? currentLocalStep
			}
		: { phase: 'contracted', requiredLocalStep: currentLocalStep };
}

async function expand(
	walk: TransitionWalk,
	states: Map<TransitionId, TransitionState>,
	planned: PlannedTransition
): Promise<void> {
	const { api, databaseId, hooks } = walk;
	const { id } = planned.transition;
	const applied =
		planned.expand.length === 0
			? []
			: await applyD1Migrations(api, databaseId, planned.expand);

	if (!hasReachedTransitionState(states.get(id), 'expanded')) {
		await recordTransition(api, databaseId, id, 'expanded', hooks.now());
		states.set(id, 'expanded');
	}

	hooks.report?.({ kind: 'expanded', transition: id, applied });
}

async function settle(
	walk: TransitionWalk,
	planned: PlannedTransition
): Promise<void> {
	const step = planned.transition.settleStep;

	if (step === undefined) {
		return;
	}

	const { api, databaseId, hooks } = walk;
	const { id } = planned.transition;
	let readiness = await readLocalStepReadiness(api, databaseId, step);

	if (readiness.pending > 0 && hooks.settleTenants !== undefined) {
		await hooks.settleTenants(step);
		readiness = await readLocalStepReadiness(api, databaseId, step);
	}

	if (readiness.pending > 0) {
		throw new LocalStepUnreachedError(
			readiness.pending,
			step,
			readiness.stragglers
		);
	}

	hooks.report?.({ kind: 'settled', transition: id, step });

	const compatibility = compatibilityPhaseFor(planned, 'settled');

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

async function contract(
	walk: TransitionWalk,
	states: Map<TransitionId, TransitionState>,
	planned: PlannedTransition
): Promise<void> {
	const { api, databaseId, hooks } = walk;
	const { id } = planned.transition;
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

/**
 * The walk before the Workers are uploaded.
 *
 * A fresh database has no old Workers to drain and no tenants to settle, so
 * every transition's expand and contract run now and each is recorded
 * complete. Otherwise each pending transition's expand migrations run when
 * every earlier transition is complete or the transition is independent of
 * their contracts, and it is recorded `expanded`; one with no contract and no
 * settle step is complete at once. A transition that qualifies for neither is
 * left for {@link completeTransitions}, and later independent ones still run.
 */
export async function prepareTransitions(
	walk: TransitionWalk,
	isFreshDatabase: boolean
): Promise<TransitionStates> {
	const states = await openTransitions(walk);

	for (const [index, planned] of walk.transitions.entries()) {
		if (isComplete(states, planned)) {
			continue;
		}

		if (isFreshDatabase) {
			await expand(walk, states, planned);
			await contract(walk, states, planned);
			continue;
		}

		const earlier = walk.transitions.slice(0, index);
		const isMayExpand =
			planned.transition.independent === true ||
			earlier.every((other) => isComplete(states, other));

		if (!isMayExpand) {
			walk.hooks.report?.({
				kind: 'deferred',
				transition: planned.transition.id
			});
			continue;
		}

		await expand(walk, states, planned);

		if (
			planned.contract.length === 0 &&
			planned.transition.settleStep === undefined
		) {
			await contract(walk, states, planned);
		}
	}

	return states;
}

/**
 * The walk once both Workers serve this build. Each transition still pending
 * is expanded if it was deferred, its tenants are settled to its settle step
 * (`LocalStepUnreachedError` names those that are behind), and its contract
 * migrations run and it is recorded complete, in list order. The serving
 * check runs once, before the first pending transition, and throws
 * `DeploymentPhaseUnsettledError` while a script is split across versions or
 * still serves an earlier build.
 */
export async function completeTransitions(
	walk: TransitionWalk
): Promise<TransitionStates> {
	const states = await openTransitions(walk);
	let isServingConfirmed = false;

	for (const planned of walk.transitions) {
		if (isComplete(states, planned)) {
			continue;
		}

		if (!isServingConfirmed) {
			await walk.hooks.awaitServing();
			isServingConfirmed = true;
		}

		await expand(walk, states, planned);
		await settle(walk, planned);
		await contract(walk, states, planned);
	}

	return states;
}
