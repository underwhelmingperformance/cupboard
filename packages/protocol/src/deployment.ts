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
 * This build requires every tenant Durable Object to reach this step.
 *
 * A release that needs per-object work after its migrations gives that work the
 * next step number and raises this constant. Step 1 gives every registered
 * cache an identity and fills the `cache_id` of every row that still refers to
 * its cache by the stored name alone. A migration ran that fill once, when the
 * object first initialised; the step repeats it for rows written since. Step 2
 * moves a private cache's stored objects off the keys its old `private/`
 * name gave them, which a migration cannot do because those objects are in R2.
 *
 * `cupboard deploy` records this number with the phase, and the control plane
 * compares each tenant's recorded step against it.
 */
export const currentLocalStep: LocalStep = localStep(2);

/**
 * A deploy records one of these phase names. They are listed in the order a
 * release records them.
 *
 * The control Worker reports the recorded phase through `deployment.phase`. A
 * release that changes what a tenant Durable Object stores adds the phases it
 * needs and reads the recorded one to choose behaviour. A build that needs no
 * such coordination runs in `current`.
 *
 * `contracted` is the phase in which a deploy rewrites or removes what the
 * previous build still reads. A deploy records it only once the new build
 * serves every request and the contraction has run. From then on a rollback
 * cannot restore the previous build by redeploying it, so a write that build
 * cannot parse is safe. This build never records `contracted`; it reads the
 * phase so that a stored grant keeps the spelling the previous build parses
 * until a later deploy contracts.
 */
export const deploymentPhaseNameSchema = z.enum([
	'current',
	'expanded',
	'native-reads',
	'contracted'
]);
export type DeploymentPhaseName = z.infer<typeof deploymentPhaseNameSchema>;

// The phases in the order a release records them. `hasReachedPhase` compares
// positions in this list.
const phaseOrder: readonly DeploymentPhaseName[] =
	deploymentPhaseNameSchema.options;

/**
 * Whether the recorded phase has reached the one asked about.
 *
 * A deployment with no phase row has reached none of them: no deploy has
 * recorded one, so nothing has confirmed the state any phase describes.
 */
export function hasReachedPhase(
	recorded: DeploymentPhaseName | undefined,
	wanted: DeploymentPhaseName
): boolean {
	if (recorded === undefined) {
		return false;
	}

	return phaseOrder.indexOf(recorded) >= phaseOrder.indexOf(wanted);
}

// A deploy of this build ends in this phase. A release that adds phases
// changes this to the last phase it introduces.
//
// `native-reads` says the reads take a cache from its identity columns
// instead of the legacy name. The deploy records it only after every active
// tenant has recorded the current local step, whose reconciliation fills the
// `cache_id` of the rows an earlier build wrote by name alone, so a build
// that reads this phase finds an identity on every row.
export const settledDeploymentPhase: DeploymentPhaseName = 'native-reads';

// The `deployment_phase` table has one row, and this is its `id`. `cupboard
// deploy` writes that row.
export const deploymentPhaseRowId = 'current';

export const deploymentPhaseSchema = z.strictObject({
	name: deploymentPhaseNameSchema,
	// The local step every active tenant must reach before the release may
	// advance past this phase.
	requiredLocalStep: localStepSchema,
	updatedAt: isoTimestampSchema
});
export type ParsedDeploymentPhase = z.output<typeof deploymentPhaseSchema>;
export type DeploymentPhase = z.input<typeof deploymentPhaseSchema>;

// The phase is absent until a deploy records one. A deployment set up before
// phases existed has no phase row.
export const deploymentPhaseResponseSchema = z.strictObject({
	phase: deploymentPhaseSchema.optional()
});
export type ParsedDeploymentPhaseResponse = z.output<
	typeof deploymentPhaseResponseSchema
>;
export type DeploymentPhaseResponse = z.input<
	typeof deploymentPhaseResponseSchema
>;

// A status response lists at most this many stragglers: enough to name the
// tenants an operator would chase by hand, while bounding the response.
export const localStepStragglerSampleSize = 20;

export const localStepStatusSchema = z.strictObject({
	// The step this build asks of every active tenant.
	current: localStepSchema,
	// Active tenants that have reported `current` or later.
	ready: z.number().int().nonnegative(),
	// Active tenants that have not, whether they reported an earlier step or
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

// Waking a tenant is a request to its object, so a batch can partly fail. A
// failed tenant stays in the straggler list and the next batch retries it.
export const localStepWakeResponseSchema = z.strictObject({
	current: localStepSchema,
	woken: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative()
});
export type ParsedLocalStepWakeResponse = z.output<
	typeof localStepWakeResponseSchema
>;
export type LocalStepWakeResponse = z.input<typeof localStepWakeResponseSchema>;
