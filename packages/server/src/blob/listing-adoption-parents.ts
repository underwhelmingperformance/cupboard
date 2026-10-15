import {
	cacheGenerationSchema,
	cacheScopeSchema,
	narInfoGenerationSchema,
	nixSha256HashSchema,
	storePathHashSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
import { z } from 'zod';

export const listingAdoptionParentIdSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionParentId');
export type ListingAdoptionParentId = z.output<
	typeof listingAdoptionParentIdSchema
>;

export const listingAdoptionParentRefreshSchema = z.strictObject({
	tenant: tenantIdSchema,
	cache: cacheScopeSchema,
	storePathHashes: z.array(storePathHashSchema).min(1).max(32)
});
export type ListingAdoptionParentRefresh = z.output<
	typeof listingAdoptionParentRefreshSchema
>;

export const listingAdoptionParentSchema = z.strictObject({
	id: listingAdoptionParentIdSchema,
	tenant: tenantIdSchema,
	cache: cacheScopeSchema,
	cacheGeneration: cacheGenerationSchema,
	storePathHash: storePathHashSchema,
	generation: narInfoGenerationSchema,
	narHash: nixSha256HashSchema,
	updatedAt: isoTimestampSchema
});
export type ListingAdoptionParent = z.output<
	typeof listingAdoptionParentSchema
>;
export type ListingAdoptionParentRefreshResult =
	| {
			readonly kind: 'ready';
			readonly parents: readonly ListingAdoptionParent[];
	  }
	| { readonly kind: 'unavailable' };
