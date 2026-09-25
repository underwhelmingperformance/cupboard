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
 * The schema transitions a deployment passes through, each identified here.
 * A transition is a group of D1 migrations: the expand migrations, which the
 * Workers of the build that adds them can run against, and the contract
 * migrations, which remove what the preceding build still reads once nothing
 * serves it. `cupboard deploy` walks the list in order and records how far
 * each transition has got in `deployment_transition`.
 */
export const transitionIdSchema = z.enum([
	'cache-identity',
	'deployment-transitions',
	'local-step-sweep'
]);
export type TransitionId = z.infer<typeof transitionIdSchema>;

/**
 * `expanded` means the transition's expand migrations are applied. `complete`
 * means the contract migrations are applied too, or the transition has none.
 * A transition with no row is not expanded.
 */
export const transitionStateSchema = z.enum(['expanded', 'complete']);
export type TransitionState = z.infer<typeof transitionStateSchema>;

// The states in the order a deploy records them. A record never lowers one.
const transitionStateOrder: readonly TransitionState[] =
	transitionStateSchema.options;

export function transitionStateRank(state: TransitionState): number {
	return transitionStateOrder.indexOf(state);
}

/**
 * Whether the recorded state has reached the one asked about. A transition
 * with no recorded state has reached none of them.
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

export interface SchemaTransition {
	readonly id: TransitionId;
	/**
	The D1 migration files applied before the Workers are uploaded.
	*/
	readonly expand: readonly string[];
	/**
	 * The D1 migration files applied once both Workers serve the build and the
	 * tenants have settled.
	 */
	readonly contract: readonly string[];
	/**
	The local step every active tenant must reach before the contract.
	*/
	readonly settleStep?: LocalStep;
	/**
	 * The expand migrations do not depend on the contracts of earlier
	 * transitions, so the deploy may apply them before those contracts.
	 * `check:migrations` verifies the claim by replay.
	 */
	readonly independent?: true;
	/**
	 * The earliest release that can complete this transition, named when a
	 * build refuses to start from before it.
	 */
	readonly completedBy?: string;
}

/**
 * Every D1 migration belongs to exactly one transition, and the transitions
 * are listed in the order the deploy walks them. Concatenating each
 * transition's expand then contract, in this order, must give the migration
 * files sorted by name; `check:migrations` and the deploy both verify that.
 *
 * The migrations before the cache-identity contract belong to that
 * transition because they are what it expanded for; there is no separate
 * baseline.
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
		settleStep: expansionLocalStep,
		completedBy: 'v0.0.34'
	},
	{
		id: 'deployment-transitions',
		expand: ['0031_deployment_transitions.sql'],
		contract: [],
		independent: true
	},
	{
		id: 'local-step-sweep',
		expand: ['0032_local_step_sweep.sql'],
		contract: [],
		independent: true
	}
];

/**
 * The transition every earlier transition must be complete before this build
 * can deploy. A build sets it once its Workers can no longer serve the schema
 * an earlier transition's contract removes. This build sets none: it serves
 * every state the transitions above pass through.
 */
export const buildRequiresCompleteBefore: TransitionId | undefined = undefined;

/**
 * The local step every active tenant must reach now: the settle step of the
 * first incomplete transition that has one, or `currentLocalStep` when every
 * such transition is complete. Objects cannot report past a transition's
 * settle step before its contract lands, so counting tenants against
 * `currentLocalStep` before then would never reach zero.
 */
export function requiredLocalStepFrom(
	recorded: ReadonlyMap<TransitionId, TransitionState>
): LocalStep {
	for (const transition of schemaTransitions) {
		if (transition.settleStep === undefined) {
			continue;
		}

		if (!hasReachedTransitionState(recorded.get(transition.id), 'complete')) {
			return transition.settleStep;
		}
	}

	return currentLocalStep;
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

// The transitions a deploy has recorded, in the order they are walked, and the
// local step they require of every active tenant now. A deployment set up
// before any deploy of a build with transitions has recorded none.
export const deploymentTransitionsResponseSchema = z.strictObject({
	transitions: z.array(deploymentTransitionSchema),
	requiredLocalStep: localStepSchema
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

export const localStepWakeMaxTenants = 100;

// Waking a tenant is a request to its object, so a batch can partly fail. A
// failed tenant stays in the straggler list and the next batch retries it.
export const localStepWakeOutcomeSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		tenant: tenantIdSchema,
		kind: z.literal('recorded'),
		step: localStepSchema
	}),
	z.strictObject({
		tenant: tenantIdSchema,
		kind: z.literal('advanced'),
		projected: z.number().int().nonnegative()
	}),
	z.strictObject({ tenant: tenantIdSchema, kind: z.literal('unconfigured') }),
	z.strictObject({ tenant: tenantIdSchema, kind: z.literal('failed') })
]);
export type LocalStepWakeOutcome = z.infer<typeof localStepWakeOutcomeSchema>;

export const localStepWakeOutcomesSchema = z
	.array(localStepWakeOutcomeSchema)
	.max(localStepWakeMaxTenants);
export type LocalStepWakeOutcomes = z.input<typeof localStepWakeOutcomesSchema>;

/**
 * The delay between a sweep chain's batches while it makes progress, and the
 * first delay after a batch that advances no tenant. The deploy polls
 * `localStep.status` at this pace while it observes a chain.
 */
export const localStepSweepPaceSeconds = 10;

export const localStepSweepChainIdSchema = z
	.uuid()
	.brand<'LocalStepSweepChainId'>();
export type LocalStepSweepChainId = z.output<
	typeof localStepSweepChainIdSchema
>;

/**
 * The chain that last held the sweep lease and how far it got: its id, how
 * many messages it handed on, when its row last changed, and the per-tenant
 * outcomes of its last batch, so an observer can see which tenants failed
 * and why without waking them itself.
 */
const localStepSweepChainSchema = z.strictObject({
	chain: localStepSweepChainIdSchema,
	link: z.number().int().nonnegative(),
	updatedAt: isoTimestampSchema,
	outcomes: localStepWakeOutcomesSchema
});

export const localStepSweepStateSchema = z.enum(['running', 'stalled', 'idle']);
export type LocalStepSweepState = z.infer<typeof localStepSweepStateSchema>;

/**
 * How the server-side sweep chain stands. `running` while a chain holds the
 * lease and its last batch advanced a tenant; `stalled` while it holds the
 * lease and backs off after a batch that advanced nobody; `idle` when no chain
 * holds the lease, whether none was started, the last one ended, or its lease
 * expired because a message was lost. `nextAt` is when the chain's next batch
 * is due: one pace after the last while running, or the backoff while stalled.
 */
export const localStepSweepSchema = z.discriminatedUnion('state', [
	z.strictObject({
		state: z.literal('idle'),
		last: localStepSweepChainSchema.optional()
	}),
	z.strictObject({
		state: z.literal('running'),
		...localStepSweepChainSchema.shape,
		nextAt: isoTimestampSchema
	}),
	z.strictObject({
		state: z.literal('stalled'),
		...localStepSweepChainSchema.shape,
		nextAt: isoTimestampSchema
	})
]);
export type ParsedLocalStepSweep = z.output<typeof localStepSweepSchema>;
export type LocalStepSweep = z.input<typeof localStepSweepSchema>;

export const localStepStatusSchema = z.strictObject({
	// The final step this build asks of every active tenant.
	current: localStepSchema,
	// The step the counts below are measured against: the query's
	// `requiredStep`, or else the step the recorded transitions require now.
	required: localStepSchema,
	// Active tenants that have reported `required` or later.
	ready: z.number().int().nonnegative(),
	// Active tenants that have not, whether they reported an earlier step or
	// have not reported since the column was added.
	pending: z.number().int().nonnegative(),
	// Up to `localStepStragglerSampleSize` of the pending tenants, in slug order.
	stragglers: z.array(tenantIdSchema).max(localStepStragglerSampleSize),
	// The sweep chain that advances the pending tenants server-side.
	sweep: localStepSweepSchema
});
export type ParsedLocalStepStatus = z.output<typeof localStepStatusSchema>;
export type LocalStepStatus = z.input<typeof localStepStatusSchema>;

export const localStepWakeBodySchema = z.strictObject({
	limit: z.number().int().positive().max(localStepWakeMaxTenants)
});
export type ParsedLocalStepWakeBody = z.output<typeof localStepWakeBodySchema>;
export type LocalStepWakeBody = z.input<typeof localStepWakeBodySchema>;

export const localStepWakeResponseSchema = z.strictObject({
	current: localStepSchema,
	woken: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	outcomes: localStepWakeOutcomesSchema
});
export type ParsedLocalStepWakeResponse = z.output<
	typeof localStepWakeResponseSchema
>;
export type LocalStepWakeResponse = z.input<typeof localStepWakeResponseSchema>;
