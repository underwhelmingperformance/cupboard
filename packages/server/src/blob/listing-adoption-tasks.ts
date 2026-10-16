import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { narListingIdentitySchema } from '@cupboard/protocol/artifacts';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

import { listingAdoptionParentSchema } from './listing-adoption-parents.ts';
import { listingAdoptionCapturedWorkSchema } from './listing-adoption-work.ts';

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
