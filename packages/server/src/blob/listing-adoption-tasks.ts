import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { narListingIdentitySchema } from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { listingAdoptionParentSchema } from './listing-adoption-parents.ts';
import { listingAdoptionCapturedWorkSchema } from './listing-adoption-work.ts';
import { listingAdoptionOutcomesSchema } from './nar-listing-adoption.ts';

export const listingAdoptionTaskIdSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionTaskId');
export type ListingAdoptionTaskId = z.output<
	typeof listingAdoptionTaskIdSchema
>;
export const listingAdoptionTaskEpochSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionTaskEpoch');
export type ListingAdoptionTaskEpoch = z.output<
	typeof listingAdoptionTaskEpochSchema
>;
export const listingAdoptionTargetSchema = z
	.strictObject({
		parent: listingAdoptionParentSchema,
		identity: narListingIdentitySchema
	})
	.refine((target) => target.parent.narHash === target.identity.narHash, {
		message: 'The listing and parent must refer to the same NAR'
	});
export const listingAdoptionTaskSourceSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('expand'),
		work: listingAdoptionCapturedWorkSchema
	}),
	z.strictObject({
		kind: z.literal('deliver'),
		target: listingAdoptionTargetSchema
	})
]);
export type ListingAdoptionTaskSource = z.output<
	typeof listingAdoptionTaskSourceSchema
>;
export const listingAdoptionTaskClaimSchema = z.strictObject({
	id: listingAdoptionTaskIdSchema,
	epoch: listingAdoptionTaskEpochSchema,
	owner: artifactTaskOwnerSchema,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	leaseExpiresAt: isoTimestampSchema
});
export type ListingAdoptionTaskClaim = z.output<
	typeof listingAdoptionTaskClaimSchema
>;
export type ListingAdoptionTaskClaimResult =
	| { readonly kind: 'claimed'; readonly claim: ListingAdoptionTaskClaim }
	| { readonly kind: 'idle' | 'unavailable' };
export type ListingAdoptionTaskAdvanceResult =
	| {
			readonly kind: 'advanced';
			readonly scanned: number;
			readonly enrolled: number;
			readonly isComplete: boolean;
	  }
	| { readonly kind: 'complete' | 'stale' | 'unavailable' };

export const listingAdoptionReservationSchema = z.strictObject({
	id: listingAdoptionTaskIdSchema,
	kind: z.enum(['expand', 'deliver'])
});
export type ListingAdoptionReservation = z.output<
	typeof listingAdoptionReservationSchema
>;
export type ListingAdoptionTarget = z.output<
	typeof listingAdoptionTargetSchema
>;
export interface ListingAdoptionDelivery {
	readonly claim: ListingAdoptionTaskClaim;
	readonly target: ListingAdoptionTarget;
	readonly previousOutcome?: ListingAdoptionDeliveryOutcome;
}
export type ListingAdoptionPreparedDeliveries =
	| {
			readonly kind: 'ready';
			readonly deliveries: readonly ListingAdoptionDelivery[];
			readonly obsolete: readonly ListingAdoptionTaskClaim[];
	  }
	| { readonly kind: 'unavailable' };

export const listingAdoptionDeliveryOutcomeSchema = z.union([
	listingAdoptionOutcomesSchema.element,
	z.strictObject({ kind: z.enum(['obsolete', 'rpc-failed']) })
]);
export type ListingAdoptionDeliveryOutcome = z.output<
	typeof listingAdoptionDeliveryOutcomeSchema
>;
export const listingAdoptionDeliveryResolutionSchema = z.discriminatedUnion(
	'kind',
	[
		z.strictObject({
			kind: z.literal('finished'),
			claim: listingAdoptionTaskClaimSchema,
			outcome: listingAdoptionDeliveryOutcomeSchema
		}),
		z.strictObject({
			kind: z.literal('deferred'),
			claim: listingAdoptionTaskClaimSchema,
			outcome: listingAdoptionDeliveryOutcomeSchema,
			delaySeconds: z.number().int().min(1).max(3600)
		})
	]
);
export type ListingAdoptionDeliveryResolution = z.output<
	typeof listingAdoptionDeliveryResolutionSchema
>;
