import { tenantIdSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

/**
 * How far a tenant's Durable Object has advanced its own store: the migrations
 * it has applied plus any per-object data work a release needed afterwards.
 * Each release that needs such work numbers it as the next step.
 *
 * The step is a watermark, so an object never reports a lower one than it has
 * already reported. Its own brand keeps it from crossing with the tenant counts
 * beside it.
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
 * next step number and raises this constant. Step 1 gives every cache an
 * identity and fills the `cache_id` of the rows that still refer to a cache by
 * name alone. A migration cannot do that work, because both builds keep writing
 * such rows while the release is rolling out. Step 2 moves a private cache's
 * stored objects off the keys its old `private/`-prefixed name gave them, which
 * a migration cannot do either, because those objects are in R2. Step 3 moves
 * the stored objects of a cache above its first generation onto the keys that
 * carry that generation. Step 4 gives each cache the retention that the
 * tenant's prefix policies gave it. A migration cannot do that either, because
 * a tenant can hold more policies and caches than one Durable Object
 * invocation may read and write.
 *
 * `cupboard deploy` records this number with the phase, and the control plane
 * compares each tenant's recorded step against it.
 */
export const currentLocalStep: LocalStep = localStep(4);

/**
 * A deploy records one of these phase names. They are listed in the order a
 * release records them.
 *
 * The deployed build reads the recorded phase and behaves as that phase
 * requires. A release that changes what a tenant Durable Object stores adds the
 * phases it needs. A build that needs no such coordination runs in `current`.
 */
export const deploymentPhaseNameSchema = z.enum([
	'current',
	'expanded',
	'native-reads'
]);
export type DeploymentPhaseName = z.infer<typeof deploymentPhaseNameSchema>;

// A deploy of this build ends in this phase. A release that adds phases changes
// this to the last phase it introduces.
//
// `expanded` said that every cache row stores its identity beside the legacy
// key and that every object had reached the step which fills the rows the
// forward writes could not. The predecessor release settled there, so every
// tenant this build meets already holds those rows, and `native-reads` says
// the reads take a cache from its identity rather than from the legacy key.
export const settledDeploymentPhase: DeploymentPhaseName = 'native-reads';

// The `deployment_phase` table has one row, and this is its `id`. `cupboard
// deploy` writes that row and the Workers read it.
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

// A status response lists at most this many stragglers: enough to show an
// operator which tenants are behind, without returning one entry per tenant.
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

// Waking a tenant is a request to the object, so a batch can partly fail. The
// caller retries by asking for the next batch; nothing is lost when one wake
// fails, because the object reports its step whenever it next runs.
export const localStepWakeResponseSchema = z.strictObject({
	current: localStepSchema,
	woken: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative()
});
export type ParsedLocalStepWakeResponse = z.output<
	typeof localStepWakeResponseSchema
>;
export type LocalStepWakeResponse = z.input<typeof localStepWakeResponseSchema>;
