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
 * next step number and raises this constant. Step 1 gave every cache an
 * identity and filled the `cache_id` of the rows that named a cache by string
 * alone. Migration `0051_cache_identity_contract_assertions` fills those
 * `cache_id` values, so step 1 runs nothing; the number stays because a
 * recorded step is a watermark. Step 2 moves a private cache's
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
	'native-reads',
	'contracted'
]);
export type DeploymentPhaseName = z.infer<typeof deploymentPhaseNameSchema>;

// A deploy of this build ends in this phase. A release that adds phases changes
// this to the last phase it introduces.
//
// `expanded` required every cache row to store its identity beside the `cache`
// column, and every object to have reached the step that filled the rows those
// writes could not fill. `native-reads` required reads to take a cache from its
// identity rather than from the `cache` column. `contracted` says this build
// names a cache by its identity alone: it neither reads nor writes the `cache`
// column, whether or not the migration that drops it has run.
export const settledDeploymentPhase: DeploymentPhaseName = 'contracted';

/**
 * How long a request that started on the preceding release may still be
 * running.
 *
 * A Queue consumer has a fifteen-minute wall-time allowance, which is the
 * longest-running invocation this Worker has, so an invocation that began
 * before the cutover can still be writing for that long afterwards. The extra
 * minute covers clock differences between the deploying machine and the
 * platform.
 *
 * A migration that removes something the preceding release still writes cannot
 * run until this long after the cutover.
 * {@link migrationsAppliedAfterCutover} names the migrations of this build that
 * must wait, and a deploy defers them rather than waiting.
 */
export const predecessorInvocationLifetimeMs = 16 * 60 * 1000;

/**
 * The D1 migrations of this build that must not run until the preceding release
 * has stopped serving.
 *
 * `cupboard deploy` applies every other migration before it uploads the
 * Workers, because the preceding release must keep working against the schema
 * they leave. A migration waits here when running it earlier would break that
 * release, for example by removing a column that release still writes, or when
 * that release would go on producing the rows the migration removes.
 *
 * Migrations apply in journal order, so the migrations named here must be the
 * last entries in the journal. A later migration that is not listed here would
 * be applied before these, against a schema they have not yet changed. A deploy
 * refuses an unlisted migration that sorts at or after these, so adding one
 * means deciding which side of the cutover it belongs on.
 *
 * A deploy does not wait for that release to stop. It leaves these migrations
 * for the next deploy, which finds {@link predecessorInvocationLifetimeMs} long
 * past. That interval also covers what the cutover cannot say: it is the moment
 * Cloudflare accepted a deployment sending every request to this build, not the
 * moment every colo began serving it. The state between the two sets is a resting state: the columns they
 * remove are nullable by then and this build touches neither, so a deployment
 * that never runs again differs only by carrying dead columns.
 */
export const migrationsAppliedAfterCutover: readonly string[] = [
	'0029_cache_identity_contract.sql'
];

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
