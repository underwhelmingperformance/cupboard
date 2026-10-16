import {
	artifactJobVersionSchema,
	artifactTaskOwnerSchema
} from '@cupboard/protocol/artifact-jobs';
import {
	type IsoTimestamp,
	isoTimestampSchema
} from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const sharedListingDispatchIdSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('SharedListingDispatchId');
export type SharedListingDispatchId = z.output<
	typeof sharedListingDispatchIdSchema
>;
export const sharedListingDispatchClaimSchema = z.strictObject({
	id: sharedListingDispatchIdSchema,
	job: artifactJobVersionSchema,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	owner: artifactTaskOwnerSchema,
	leaseExpiresAt: isoTimestampSchema
});
export type SharedListingDispatchClaim = z.output<
	typeof sharedListingDispatchClaimSchema
>;
export type SharedListingDispatchClaimResult =
	| { readonly kind: 'claimed'; readonly claim: SharedListingDispatchClaim }
	| { readonly kind: 'busy'; readonly retryAt: IsoTimestamp }
	| { readonly kind: 'unavailable' };
