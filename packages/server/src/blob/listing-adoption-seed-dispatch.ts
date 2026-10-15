import { artifactTaskOwnerSchema } from '@cupboard/protocol/artifact-jobs';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const listingAdoptionSeedScopes = [
	'facts',
	'default-parents',
	'named-parents'
] as const;
export const listingAdoptionSeedScopeSchema = z.enum(listingAdoptionSeedScopes);
export type ListingAdoptionSeedScope = z.output<
	typeof listingAdoptionSeedScopeSchema
>;
export const listingAdoptionSeedDispatchEpochSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionSeedDispatchEpoch');
export type ListingAdoptionSeedDispatchEpoch = z.output<
	typeof listingAdoptionSeedDispatchEpochSchema
>;

const claimFields = {
	epoch: listingAdoptionSeedDispatchEpochSchema,
	owner: artifactTaskOwnerSchema,
	generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	leaseExpiresAt: isoTimestampSchema
};
export const listingAdoptionSeedClaimSchema = z.discriminatedUnion('scope', [
	z.strictObject({ scope: z.literal('facts'), ...claimFields }),
	z.strictObject({ scope: z.literal('default-parents'), ...claimFields }),
	z.strictObject({ scope: z.literal('named-parents'), ...claimFields })
]);
export type ListingAdoptionSeedClaim = z.output<
	typeof listingAdoptionSeedClaimSchema
>;
export type ListingAdoptionSeedClaimResult =
	| { readonly kind: 'claimed'; readonly claim: ListingAdoptionSeedClaim }
	| { readonly kind: 'idle' | 'unavailable' };
