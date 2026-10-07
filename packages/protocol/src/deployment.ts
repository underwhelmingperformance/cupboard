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
 * Objects report at most step 4 before that transition completes. Afterwards
 * they stay below this watermark until the control plane wakes them for the
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
	'deployment-transitions',
	'attestation-path-index',
	'local-step-attempts',
	'publication-identity',
	'blob-reference-read-authority',
	'tenant-retry-clock',
	'tenant-schema-progress',
	'control-refresh-sessions'
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

/**
The recorded state of each transition that has a row.
*/
export type TransitionStates<Id extends string = TransitionId> = ReadonlyMap<
	Id,
	TransitionState
>;

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
	 * migrations. The deploy wakes the tenants and waits until each has
	 * recorded it. An object can record only the steps that its `recordLocalStep`
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
	 * Earlier transitions whose contract migrations must complete before this
	 * transition expands. Every earlier transition must still have expanded.
	 * Without this list or `independent`, every earlier transition must complete.
	 */
	readonly expandAfter?: readonly Id[];
	/**
	 * The highest local step that objects can record once this transition is
	 * complete. For `cache-identity`, objects record at most
	 * `expansionLocalStep` until then. The required local step never falls below
	 * this step while the transition is complete.
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
	},
	{
		// Migration 0028 rebuilds `attestation_ref` and drops this index if it
		// runs first, so the index is a contract migration.
		id: 'attestation-path-index',
		expand: [],
		contract: ['0032_attestation_ref_path_index.sql'],
		independent: true
	},
	{
		id: 'local-step-attempts',
		expand: ['0033_tenant_local_step_attempts.sql'],
		contract: [],
		independent: true
	},
	{
		id: 'publication-identity',
		expand: ['0034_publication_identity.sql'],
		contract: [],
		independent: true
	},
	{
		id: 'blob-reference-read-authority',
		expand: ['0035_blob_reference_read_authority.sql'],
		contract: ['0036_path_read_authority_contract.sql'],
		expandAfter: ['cache-identity']
	},
	{
		id: 'tenant-retry-clock',
		expand: ['0037_tenant_retry_clock.sql'],
		contract: [],
		independent: true
	},
	{
		id: 'tenant-schema-progress',
		expand: ['0038_tenant_schema_progress.sql'],
		contract: [],
		independent: true
	},
	{
		id: 'control-refresh-sessions',
		expand: ['0039_control_refresh_sessions.sql'],
		contract: [],
		independent: true
	}
];

/**
The ids of `schemaTransitions`, in order. A test keeps `transitionIdSchema` equal.
*/
export const transitionIds: readonly TransitionId[] = schemaTransitions.map(
	(transition) => transition.id
);

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
 * step does not stop the control Worker's cron trigger from waking the
 * tenants that are still below `currentLocalStep`.
 */
export function requiredLocalStepFrom(recorded: TransitionStates): LocalStep {
	return requiredLocalStepAmong(schemaTransitions, recorded);
}

/**
{@link requiredLocalStepFrom} for the given transitions.
*/
export function requiredLocalStepAmong<Id extends string>(
	transitions: readonly SchemaTransition<Id>[],
	recorded: TransitionStates<Id>
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

/**
An expansion prerequisite that is not an earlier transition in the plan.
*/
export class SchemaTransitionDependencyError extends Error {
	constructor(
		readonly transition: string,
		readonly dependency: string
	) {
		super(
			`Schema transition '${transition}' requires completion of '${dependency}', which must be an earlier transition in the plan`
		);
		this.name = 'SchemaTransitionDependencyError';
	}
}

export interface DeferredTransition<Id extends string = TransitionId> {
	readonly transition: SchemaTransition<Id>;
	/**
	The first earlier prerequisite that is not complete.
	*/
	readonly waitsFor: SchemaTransition<Id>;
}

/**
 * Returns the first transition whose expand migrations the deploy could apply
 * only after the upload, or undefined when every incomplete transition can
 * expand before it. Before the upload, the deploy goes through the transitions
 * in order and expands each one when every earlier transition is complete.
 * An independent transition needs only every earlier transition expanded.
 * A transition with `expandAfter` also requires those listed predecessors
 * complete, so unrelated earlier contract migrations can wait until after the
 * upload. Without either declaration, an incomplete predecessor blocks it.
 *
 * The deploy stops with an error for such a deployment, because the new
 * Workers would otherwise run without that transition's expand migrations.
 * The plan, the deploy and `check:migrations` all use this function, so they
 * agree on which transition is blocked.
 */
export function deferredTransition<Id extends string>(
	transitions: readonly SchemaTransition<Id>[],
	recorded: TransitionStates<Id>
): DeferredTransition<Id> | undefined {
	const states = new Map(recorded);
	const hasReached = (
		transition: SchemaTransition<Id>,
		state: TransitionState
	): boolean => hasReachedTransitionState(states.get(transition.id), state);

	for (const [index, transition] of transitions.entries()) {
		const earlier = transitions.slice(0, index);
		const dependencies = transition.expandAfter?.map((id) => {
			const dependency = earlier.find((candidate) => candidate.id === id);
			if (dependency === undefined) {
				throw new SchemaTransitionDependencyError(transition.id, id);
			}
			return dependency;
		});

		if (hasReached(transition, 'complete')) {
			continue;
		}

		const requiredComplete =
			dependencies ?? (transition.independent === true ? [] : earlier);
		const waitsFor = earlier.find(
			(candidate) =>
				!hasReached(
					candidate,
					requiredComplete.includes(candidate) ? 'complete' : 'expanded'
				)
		);
		if (waitsFor !== undefined) {
			return { transition, waitsFor };
		}

		states.set(
			transition.id,
			isCompleteOnExpand(transition) ? 'complete' : 'expanded'
		);
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

// A row in `deployment_transition`, with its fields as stored. Another release
// can write the row, so neither its id nor its state has to be one that this
// build defines. A rollback past the release that added a transition leaves
// such a row.
export const storedTransitionRowSchema = z.strictObject({
	id: z.string(),
	state: z.string(),
	updatedAt: z.string(),
	// Set once the deploy has started the transition's contract migrations.
	contractedAt: z.string().optional()
});
export type StoredTransitionRow = z.infer<typeof storedTransitionRowSchema>;

// The recorded transitions that this build defines, in the order that the
// deploy applies them, and the rows that it does not define. Both lists are
// empty until a build with schema transitions has been deployed. The response
// does not include the required local step; `localStep.status` reports it.
export const deploymentTransitionsResponseSchema = z.strictObject({
	transitions: z.array(deploymentTransitionSchema),
	unrecognised: z.array(storedTransitionRowSchema)
});
export type ParsedDeploymentTransitionsResponse = z.output<
	typeof deploymentTransitionsResponseSchema
>;
export type DeploymentTransitionsResponse = z.input<
	typeof deploymentTransitionsResponseSchema
>;

/**
 * How long a tenant's local-step work may go without progress before it
 * counts as stalled. Each page of the work is bounded, and a page that saves a
 * cursor or moves an item makes progress. A tenant object that has made no
 * progress for this long stops retrying until the next wake.
 */
export const localStepStallWindowMs = 10 * 60 * 1000;

/**
 * The longest error summary that a tenant row records for a failed attempt at
 * its local-step work.
 */
export const localStepErrorMaxLength = 500;

/**
 * The most tenants that `localStep.status` lists in each sample.
 */
export const localStepSampleSize = 20;

const tenantCountSchema = z.number().int().nonnegative();

export const tenantSchemaMigrationSchema = z.strictObject({
	migration: z.string(),
	stage: z.string(),
	cursor: z.number().int().nonnegative()
});
export type TenantSchemaMigration = z.infer<typeof tenantSchemaMigrationSchema>;

// A stalled pending tenant. `progressedAt` is absent when the object has never
// made progress. `error` is the error of the last attempt, or the reason that
// the object gave up, and is absent when the last attempt made no progress
// without failing.
export const localStepStalledTenantSchema = z.strictObject({
	tenant: tenantIdSchema,
	attemptedAt: isoTimestampSchema.optional(),
	progressedAt: isoTimestampSchema.optional(),
	error: z.string().max(localStepErrorMaxLength).optional(),
	migration: tenantSchemaMigrationSchema.optional()
});
export type ParsedLocalStepStalledTenant = z.output<
	typeof localStepStalledTenantSchema
>;

// An unwoken pending tenant. `attemptedAt` is the last attempt at the
// outstanding work, and is absent when no attempt has been made since the
// tenant last recorded a step, or ever.
export const localStepUnwokenTenantSchema = z.strictObject({
	tenant: tenantIdSchema,
	attemptedAt: isoTimestampSchema.optional()
});
export type ParsedLocalStepUnwokenTenant = z.output<
	typeof localStepUnwokenTenantSchema
>;

/**
 * Readiness of active and suspended tenants for the required data step and
 * the deployed tenant schema. Every pending tenant is in one class, measured
 * against the `localStepStallWindowMs` before the request. A tenant is unwoken when
 * no attempt at the outstanding work has been made within the window and the
 * last attempt did not fail. Otherwise the object has attempted the work, and
 * the tenant is:
 *
 * - `working` when its last progress is inside the window, even if its last
 *   attempt failed, or when it has never made progress and has not failed;
 * - `stalled` when its last progress is outside the window, or when it has
 *   never made progress and its last attempt failed.
 */
export const localStepStatusSchema = z.strictObject({
	// This build's final local step (`currentLocalStep`).
	current: localStepSchema,
	// The required step for tenant data work.
	required: localStepSchema,
	// Active or suspended tenants with the required data step and tenant schema.
	ready: tenantCountSchema,
	// Active or suspended tenants with outstanding schema or data work.
	pending: tenantCountSchema,
	working: tenantCountSchema,
	stalled: tenantCountSchema,
	unwoken: tenantCountSchema,
	// Up to `localStepSampleSize` of the stalled and of the unwoken tenants, in
	// slug order.
	stalledSample: z.array(localStepStalledTenantSchema).max(localStepSampleSize),
	unwokenSample: z.array(localStepUnwokenTenantSchema).max(localStepSampleSize),
	workingSample: z
		.array(localStepStalledTenantSchema)
		.max(localStepSampleSize)
		.optional()
});
export type ParsedLocalStepStatus = z.output<typeof localStepStatusSchema>;
export type LocalStepStatus = z.input<typeof localStepStatusSchema>;

// `localStep.wake` enqueues a wake for every pending tenant that is stalled or
// unwoken. `enqueued` counts those tenants, and `pending` counts every pending
// tenant.
export const localStepWakeResponseSchema = z.strictObject({
	required: localStepSchema,
	enqueued: tenantCountSchema,
	pending: tenantCountSchema
});
export type ParsedLocalStepWakeResponse = z.output<
	typeof localStepWakeResponseSchema
>;
export type LocalStepWakeResponse = z.input<typeof localStepWakeResponseSchema>;
