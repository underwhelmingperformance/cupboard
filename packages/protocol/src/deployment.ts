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
 * Step 5 rewrites stored grants after D1 records `contracted`.
 *
 * Objects report at most step 4 before contraction. They remain below this
 * watermark afterwards, so the control plane wakes them for the grant rewrite.
 */
export const currentLocalStep: LocalStep = localStep(5);

/**
The local data work that must finish before the deploy contracts D1.
*/
export const expansionLocalStep: LocalStep = localStep(4);

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
 * receives all traffic and the D1 contraction has run. A rollback cannot
 * restore the previous build by redeploying it, so new writes can use the
 * scope format. Tenants then finish their local grant conversion and report
 * step 5.
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

// The final D1 phase. Tenant grant conversion continues as local step 5.
export const settledDeploymentPhase: DeploymentPhaseName = 'contracted';

/**
 * D1 migrations applied after both Workers run this build and active tenants
 * finish the expansion work. Every contraction must follow every expansion in
 * journal order; an unlisted migration after this boundary is refused.
 */
export const contractionMigrations: readonly string[] = [
	'0028_cache_identity_contract.sql',
	'0029_cache_grant_contract.sql',
	'0030_cache_credential_lifecycle.sql'
];

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

export const localStepStragglerSampleSize = 20;

export const localStepStatusQuerySchema = z.strictObject({
	requiredStep: localStepSchema.optional()
});

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

export const localStepWakeResponseSchema = z.strictObject({
	current: localStepSchema,
	woken: z.number().int().nonnegative(),
	failed: z.number().int().nonnegative(),
	outcomes: z.array(localStepWakeOutcomeSchema).max(localStepWakeMaxTenants)
});
export type ParsedLocalStepWakeResponse = z.output<
	typeof localStepWakeResponseSchema
>;
export type LocalStepWakeResponse = z.input<typeof localStepWakeResponseSchema>;
