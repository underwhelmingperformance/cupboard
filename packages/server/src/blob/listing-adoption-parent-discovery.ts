import {
	cacheNameSchema,
	type CacheScope,
	type StorePathHash,
	storePathHashSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { z } from 'zod';

export const listingAdoptionDefaultParentKeySchema = z.strictObject({
	tenant: tenantIdSchema,
	storePathHash: storePathHashSchema
});
export const listingAdoptionNamedParentKeySchema =
	listingAdoptionDefaultParentKeySchema.extend({ cacheName: cacheNameSchema });

export const listingAdoptionParentWindowSchema = z
	.discriminatedUnion('kind', [
		z.strictObject({
			kind: z.literal('default'),
			through: listingAdoptionDefaultParentKeySchema,
			after: listingAdoptionDefaultParentKeySchema.optional()
		}),
		z.strictObject({
			kind: z.literal('named'),
			through: listingAdoptionNamedParentKeySchema,
			after: listingAdoptionNamedParentKeySchema.optional()
		})
	])
	.refine(
		(window) => {
			if (window.after === undefined) {
				return true;
			}
			const tenant = byCodeUnit(window.after.tenant, window.through.tenant);
			if (tenant !== 0) {
				return tenant < 0;
			}
			if (window.kind === 'named') {
				const cache = byCodeUnit(
					window.after.cacheName,
					window.through.cacheName
				);
				if (cache !== 0) {
					return cache < 0;
				}
			}
			return (
				byCodeUnit(window.after.storePathHash, window.through.storePathHash) <=
				0
			);
		},
		{
			error:
				'The parent discovery cursor must not exceed its fixed upper boundary'
		}
	);
export type ListingAdoptionParentWindow = z.output<
	typeof listingAdoptionParentWindowSchema
>;

export interface ListingAdoptionParentIdentity {
	readonly tenant: TenantId;
	readonly cache: CacheScope;
	readonly storePathHash: StorePathHash;
}

export interface ListingAdoptionParentPage {
	readonly parents: readonly ListingAdoptionParentIdentity[];
	readonly window: ListingAdoptionParentWindow;
	readonly isComplete: boolean;
}
