import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

/**
 * How far a tenant's Durable Object has advanced its own store: the migrations
 * it has applied plus any per-object data work a release needed afterwards.
 * Each release that needs such work numbers it as the next step.
 *
 * The step is a watermark, so an object never reports a lower one than it has
 * already reported. The brand stops a step being passed where a tenant count is
 * expected.
 */
export const localStepSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('LocalStep');
export type LocalStep = z.infer<typeof localStepSchema>;

export function localStep(value: number): LocalStep {
	return localStepSchema.parse(value);
}

/**
 * The final local step this build asks each tenant to reach.
 *
 * Step 1 projects missing cache lifecycle rows into D1. Steps 2 and 3 move
 * private-cache objects and later cache generations to their current R2 keys.
 * Step 4 imports legacy retention and grace policies in bounded batches.
 * Step 5 rewrites stored grants once the `cache-identity` transition is
 * complete.
 *
 * Objects report at most step 4 before that transition completes. They remain
 * below this watermark afterwards, so the control plane wakes them for the
 * grant rewrite.
 */
export const currentLocalStep: LocalStep = localStep(5);

/**
The local data work that must finish before the deploy contracts D1.
*/
export const expansionLocalStep: LocalStep = localStep(4);

/**
 * The ids of the schema transitions.
 *
 * A schema transition is a group of D1 migrations in two parts. The expand
 * migrations add schema. The new build, and every build that can still be
 * deployed or rolled back to, must be able to run against it. The contract
 * migrations remove what the preceding build reads, and run once both
 * Workers' deployments send all traffic to the new build. `cupboard deploy`
 * applies the transitions in order and records how far each one has got in
 * `deployment_transition`.
 */
export const transitionIdSchema = z.enum([
	'cache-identity',
	'deployment-transitions'
]);
export type TransitionId = z.infer<typeof transitionIdSchema>;

/**
 * `expanded` means the transition's expand migrations are applied. `complete`
 * means the contract migrations are applied too, or that the transition has
 * no contract migrations and no contract step. A transition with no row is
 * pending.
 */
export const transitionStateSchema = z.enum(['expanded', 'complete']);
export type TransitionState = z.infer<typeof transitionStateSchema>;

// The states in the order that a deploy records them. Recording a state never
// lowers the stored state, and a later release may only append states after
// `complete`.
const transitionStateOrder: readonly TransitionState[] =
	transitionStateSchema.options;

export function transitionStateRank(state: TransitionState): number {
	return transitionStateOrder.indexOf(state);
}

/**
 * How a build reads one `deployment_transition` row. Other releases write rows
 * that this build does not define, so each reader classifies the row first
 * and then applies its own policy to the kinds that this build does not
 * define.
 *
 * - `defined`: this build defines the transition and the state.
 * - `unknown-state`: this build defines the transition but not the state.
 * - `unknown-transition`: this build does not define the transition. `state`
 *   is the stored state when this build defines that state.
 */
export type TransitionRowReading<Id extends string, Row> =
	| {
			readonly kind: 'defined';
			readonly id: Id;
			readonly state: TransitionState;
			readonly row: Row;
	  }
	| { readonly kind: 'unknown-state'; readonly id: Id; readonly row: Row }
	| {
			readonly kind: 'unknown-transition';
			readonly state: TransitionState | undefined;
			readonly row: Row;
	  };

export function readTransitionRow<
	Id extends string,
	Row extends { readonly id: string; readonly state: string }
>(ids: readonly Id[], row: Row): TransitionRowReading<Id, Row> {
	const id = ids.find((candidate) => candidate === row.id);
	const state = transitionStateSchema.safeParse(row.state);

	if (id === undefined) {
		return {
			kind: 'unknown-transition',
			state: state.success ? state.data : undefined,
			row
		};
	}

	return state.success
		? { kind: 'defined', id, state: state.data, row }
		: { kind: 'unknown-state', id, row };
}

/**
 * Whether the recorded state has reached `wanted`. A transition with no
 * recorded state has reached none of them.
 */
export function hasReachedTransitionState(
	recorded: TransitionState | undefined,
	wanted: TransitionState
): boolean {
	if (recorded === undefined) {
		return false;
	}

	return transitionStateRank(recorded) >= transitionStateRank(wanted);
}

export interface SchemaTransition<Id extends string = TransitionId> {
	readonly id: Id;
	/**
	 * The D1 migration files that the deploy applies before it uploads the
	 * Workers. The deployed Workers keep serving while these run, and after a
	 * skip-level upgrade (for example from v0.0.33) the deployed build is older
	 * than the preceding release. A rollback can also cross two releases and
	 * leave a later release's expand migrations applied. Expand migrations must
	 * therefore stay compatible with every build that can still be deployed or
	 * rolled back to, not only with the preceding build.
	 */
	readonly expand: readonly string[];
	/**
	 * The D1 migration files that the deploy applies once both Workers serve the
	 * build and every active or suspended tenant has recorded `contractStep`. On
	 * a fresh database the deploy applies them before the upload, because no
	 * Worker serves the preceding build and there are no tenants.
	 */
	readonly contract: readonly string[];
	/**
	 * The transition's contract step: the local step that every active or
	 * suspended tenant must record before the deploy applies the contract
	 * migrations. The deploy wakes tenants in batches until each has recorded
	 * it. An object can record only the steps that its `recordLocalStep`
	 * reports, so a transition may declare only such a step; a protocol test
	 * enforces this.
	 */
	readonly contractStep?: LocalStep;
	/**
	 * Set when the expand migrations do not depend on the contract migrations of
	 * earlier transitions and do not change existing rows. A transition without
	 * the flag is called dependent. Once every earlier transition has expanded,
	 * the deploy may apply an independent transition's expand migrations before
	 * those contract migrations. Like every expand migration, they must stay
	 * compatible with every build that can still be deployed or rolled back to.
	 */
	readonly independent?: true;
	/**
	 * The highest local step that objects can record once this transition is
	 * complete. Until then they record at most `expansionLocalStep`. The
	 * required local step never falls below this step while the transition is
	 * complete.
	 */
	readonly reportableStepOnComplete?: LocalStep;
	/**
	 * Set when v0.0.34 and v0.0.35 read this transition's progress from the
	 * `deployment_phase` row. The deploy reconciles the transition's state with
	 * that row and writes the row as the transition advances, so a rollback to
	 * one of those releases reads a correct phase.
	 */
	readonly compatibilityPhase?: true;
	/**
	 * The first release that can complete this transition. A later release can
	 * also complete it, unless that release includes a transition that depends
	 * on this one. Set it once the release that first includes the transition
	 * has been tagged; until then the deploy's error message describes the
	 * releases without a version.
	 */
	readonly completedBy?: string;
}

/**
 * Every D1 migration belongs to exactly one transition, and the transitions
 * are listed in the order that the deploy applies them. Concatenating each
 * transition's expand then contract, in this order, must give the migration
 * files sorted by name; `check:migrations` and the deploy both verify that.
 *
 * Once a release has shipped a transition, its migration lists must not
 * change: a deployment that recorded the transition complete never applies a
 * migration added to it later. A new migration goes in a new transition.
 *
 * The base schema, migrations `0000` to `0019`, also belongs to
 * `cache-identity`, because it is the first transition and each migration must
 * belong to one.
 */
export const schemaTransitions: readonly SchemaTransition[] = [
	{
		id: 'cache-identity',
		expand: [
			'0000_blob_state.sql',
			'0001_blob_ref_tenant_blob.sql',
			'0002_blob_state_delete_after.sql',
			'0003_control_auth_key.sql',
			'0004_control_trust.sql',
			'0005_tenant_registry.sql',
			'0006_manifest_state.sql',
			'0007_tenant_read_verifier.sql',
			'0008_tenant_usage.sql',
			'0009_tenant_last_maintained.sql',
			'0010_next_pepper_potts.sql',
			'0011_concerned_winter_soldier.sql',
			'0012_spicy_may_parker.sql',
			'0013_common_mac_gargan.sql',
			'0014_reshape_eligibility_projection.sql',
			'0015_lying_thor_girl.sql',
			'0016_global_admin_audience.sql',
			'0017_object_incarnations.sql',
			'0018_tenant_cache_read_credential.sql',
			'0019_nar_read_authority.sql',
			'0020_tenant_local_step.sql',
			'0021_deployment_phase.sql',
			'0022_cache_access_expand.sql',
			'0023_cache_access_legacy_write_mirror.sql',
			'0024_cache_access_backfill.sql',
			'0025_cache_incarnation_expand.sql',
			'0026_cache_identity_contract_assertions.sql',
			'0027_cache_identity_compatible_contract.sql'
		],
		contract: [
			'0028_cache_identity_contract.sql',
			'0029_cache_grant_contract.sql',
			'0030_cache_credential_lifecycle.sql'
		],
		contractStep: expansionLocalStep,
		reportableStepOnComplete: currentLocalStep,
		compatibilityPhase: true,
		completedBy: 'v0.0.34'
	},
	{
		id: 'deployment-transitions',
		expand: ['0031_deployment_transitions.sql'],
		contract: [],
		independent: true
	}
];

/**
 * Returns the required local step: the local step that every active or
 * suspended tenant must reach now. This is the contract step of the first
 * incomplete transition that has one, or `currentLocalStep` when every such
 * transition is complete. It is never lower than the `reportableStepOnComplete`
 * of a complete transition.
 *
 * Objects cannot record past step 4 until the deploy records `cache-identity`
 * complete, so the count of tenants below `currentLocalStep` would never reach
 * zero before then. Once it is complete, objects can record
 * `currentLocalStep`, so an incomplete later transition with a lower contract
 * step does not stop the sweep from waking the tenants that are still below
 * `currentLocalStep`.
 */
export function requiredLocalStepFrom(
	recorded: ReadonlyMap<TransitionId, TransitionState>
): LocalStep {
	return requiredLocalStepAmong(schemaTransitions, recorded);
}

/**
{@link requiredLocalStepFrom} for the given transitions.
*/
export function requiredLocalStepAmong<Id extends string>(
	transitions: readonly SchemaTransition<Id>[],
	recorded: ReadonlyMap<Id, TransitionState>
): LocalStep {
	const isComplete = (transition: SchemaTransition<Id>): boolean =>
		hasReachedTransitionState(recorded.get(transition.id), 'complete');
	const reportable = Math.max(
		expansionLocalStep,
		...transitions
			.filter((transition) => isComplete(transition))
			.map((transition) => transition.reportableStepOnComplete ?? 0)
	);
	const contractStep = transitions.find(
		(transition) =>
			transition.contractStep !== undefined && !isComplete(transition)
	)?.contractStep;

	if (contractStep === undefined) {
		return currentLocalStep;
	}

	return localStep(Math.max(contractStep, reportable));
}

/**
 * Whether a transition is complete as soon as it has expanded, because it has
 * no contract migrations and no `contractStep`.
 */
export function isCompleteOnExpand(
	transition: SchemaTransition<string>
): boolean {
	return (
		transition.contract.length === 0 && transition.contractStep === undefined
	);
}

export interface DeferredTransition<Id extends string = TransitionId> {
	readonly transition: SchemaTransition<Id>;
	/**
	The first earlier transition that is not complete.
	*/
	readonly waitsFor: SchemaTransition<Id>;
}

/**
 * Returns the first transition whose expand migrations the deploy could apply
 * only after the upload, or undefined when every incomplete transition can
 * expand before it. Before the upload, the deploy goes through the transitions
 * in order and expands each one when every earlier transition is complete, or
 * when it is independent and every earlier transition has expanded. A
 * transition that is not independent and follows an incomplete one meets
 * neither condition.
 *
 * The deploy stops with an error for such a deployment, because the new
 * Workers would otherwise run without that transition's expand migrations.
 * The plan, the deploy and `check:migrations` all use this function, so they
 * agree on which transition is blocked.
 */
export function deferredTransition<Id extends string>(
	transitions: readonly SchemaTransition<Id>[],
	recorded: ReadonlyMap<Id, TransitionState>
): DeferredTransition<Id> | undefined {
	const states = new Map(recorded);
	const hasReached = (
		transition: SchemaTransition<Id>,
		state: TransitionState
	): boolean => hasReachedTransitionState(states.get(transition.id), state);

	for (const [index, transition] of transitions.entries()) {
		if (hasReached(transition, 'complete')) {
			continue;
		}

		const earlier = transitions.slice(0, index);
		const waitsFor = earlier.find(
			(candidate) => !hasReached(candidate, 'complete')
		);
		const canExpandAhead =
			transition.independent === true &&
			earlier.every((candidate) => hasReached(candidate, 'expanded'));

		if (waitsFor === undefined || canExpandAhead) {
			states.set(
				transition.id,
				isCompleteOnExpand(transition) ? 'complete' : 'expanded'
			);
			continue;
		}

		return { transition, waitsFor };
	}

	return undefined;
}

export const deploymentTransitionSchema = z.strictObject({
	id: transitionIdSchema,
	state: transitionStateSchema,
	updatedAt: isoTimestampSchema
});
export type ParsedDeploymentTransition = z.output<
	typeof deploymentTransitionSchema
>;
export type DeploymentTransition = z.input<typeof deploymentTransitionSchema>;

// A recorded row whose transition id or state this build does not define. A
// rollback past the release that added the transition leaves such a row.
// Another release wrote the row, so its fields are reported as stored.
export const unrecognisedDeploymentTransitionSchema = z.strictObject({
	id: z.string(),
	state: z.string(),
	updatedAt: z.string(),
	// Set once the deploy has started the transition's contract migrations.
	contractedAt: z.string().optional()
});
export type UnrecognisedDeploymentTransition = z.infer<
	typeof unrecognisedDeploymentTransitionSchema
>;

// The recorded transitions that this build defines, in the order that the
// deploy applies them, and the rows that it does not define. Both lists are
// empty until a build with schema transitions has been deployed. The response
// does not include the required local step; `localStep.status` reports it.
export const deploymentTransitionsResponseSchema = z.strictObject({
	transitions: z.array(deploymentTransitionSchema),
	unrecognised: z.array(unrecognisedDeploymentTransitionSchema)
});
export type ParsedDeploymentTransitionsResponse = z.output<
	typeof deploymentTransitionsResponseSchema
>;
export type DeploymentTransitionsResponse = z.input<
	typeof deploymentTransitionsResponseSchema
>;

export const localStepStragglerSampleSize = 20;

export const localStepStatusQuerySchema = z.strictObject({
	requiredStep: localStepSchema.optional()
});

export const localStepStatusSchema = z.strictObject({
	// This build's final local step (`currentLocalStep`).
	current: localStepSchema,
	// The step that `ready` and `pending` are counted against: the query's
	// `requiredStep`, or else the required local step.
	required: localStepSchema,
	// Active or suspended tenants that have reported `required` or later.
	ready: z.number().int().nonnegative(),
	// Active or suspended tenants that have not, whether they reported an
	// earlier step or
	// have not reported since the column was added.
	pending: z.number().int().nonnegative(),
	// Up to `localStepStragglerSampleSize` of the pending tenants, in slug order.
	stragglers: z.array(tenantIdSchema).max(localStepStragglerSampleSize)
});
export type ParsedLocalStepStatus = z.output<typeof localStepStatusSchema>;
export type LocalStepStatus = z.input<typeof localStepStatusSchema>;

export const localStepWakeMaxTenants = 100;

export const localStepWakeBodySchema = z.strictObject({
	limit: z.number().int().positive().max(localStepWakeMaxTenants)
});
export type ParsedLocalStepWakeBody = z.output<typeof localStepWakeBodySchema>;
export type LocalStepWakeBody = z.input<typeof localStepWakeBodySchema>;

/**
 * The longest error summary that a `failed` outcome contains.
 */
export const localStepWakeErrorMaxLength = 500;

// Waking a tenant is a request to its object, so a batch can partly fail. A
// failed tenant stays in the straggler list and the next batch retries it.
//
// `progressed` is whether the wake moved the object's durable state forward.
// A `recorded` wake progressed when it raised the recorded step or projected
// or moved any item. Recording the same step again is not progress. An
// `advanced` wake leaves the object with more work to do; it progressed when
// it committed a migration or a page of one, saved a cursor, or completed a
// batch of work. `projected` counts the caches projected, the objects moved,
// or the rows rewritten in a batch, and is 0 for a schema migration or a
// catalogue page. `step` is the step that the tenant had recorded before the
// wake, and is absent if it had recorded none. A `failed` wake is one whose
// request to the object threw; `error` summarises what it threw.
export const localStepWakeOutcomeSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		tenant: tenantIdSchema,
		kind: z.literal('recorded'),
		step: localStepSchema,
		progressed: z.boolean()
	}),
	z.strictObject({
		tenant: tenantIdSchema,
		kind: z.literal('advanced'),
		projected: z.number().int().nonnegative(),
		progressed: z.boolean(),
		step: localStepSchema.optional()
	}),
	z.strictObject({ tenant: tenantIdSchema, kind: z.literal('unconfigured') }),
	z.strictObject({
		tenant: tenantIdSchema,
		kind: z.literal('failed'),
		error: z.string().max(localStepWakeErrorMaxLength)
	})
]);
export type LocalStepWakeOutcome = z.input<typeof localStepWakeOutcomeSchema>;

export const localStepWakeResponseSchema = z.strictObject({
	current: localStepSchema,
	// This batch selected the tenants below this step.
	required: localStepSchema,
	woken: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	outcomes: z.array(localStepWakeOutcomeSchema).max(localStepWakeMaxTenants)
});
export type ParsedLocalStepWakeResponse = z.output<
	typeof localStepWakeResponseSchema
>;
export type LocalStepWakeResponse = z.input<typeof localStepWakeResponseSchema>;
