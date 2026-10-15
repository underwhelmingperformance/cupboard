import { z } from 'zod';

export const listingAdoptionSeedEpochSchema = z
	.string()
	.regex(/^[\da-f]{32}$/)
	.brand('ListingAdoptionSeedEpoch');
export type ListingAdoptionSeedEpoch = z.output<
	typeof listingAdoptionSeedEpochSchema
>;
