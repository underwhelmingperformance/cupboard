import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// Each requested hash costs one R2 head request, so this bound leaves headroom
// beneath the Worker's internal-subrequest ceiling.
export const cacheAvailabilityMaxPaths = 900;

// One hash in a reuse-view request can select up to 16 candidate NARs. The
// server verifies their D1 facts as a set, and this lower bound keeps the
// worst-case R2 work below the same ceiling.
export const reuseViewAvailabilityMaxPaths = 50;

export const cacheAvailabilityRequestSchema = z.strictObject({
	storePathHashes: z.array(storePathHashSchema).max(cacheAvailabilityMaxPaths)
});
export type CacheAvailabilityRequest = z.input<
	typeof cacheAvailabilityRequestSchema
>;
export type ParsedCacheAvailabilityRequest = z.output<
	typeof cacheAvailabilityRequestSchema
>;

export const reuseViewAvailabilityRequestSchema = z.strictObject({
	storePathHashes: z
		.array(storePathHashSchema)
		.max(reuseViewAvailabilityMaxPaths)
});
export type ReuseViewAvailabilityRequest = z.input<
	typeof reuseViewAvailabilityRequestSchema
>;
export type ParsedReuseViewAvailabilityRequest = z.output<
	typeof reuseViewAvailabilityRequestSchema
>;

export const cacheAvailabilityResponseSchema = z.strictObject({
	missingStorePathHashes: z
		.array(storePathHashSchema)
		.max(cacheAvailabilityMaxPaths)
});
export type CacheAvailabilityResponse = z.input<
	typeof cacheAvailabilityResponseSchema
>;
export type ParsedCacheAvailabilityResponse = z.output<
	typeof cacheAvailabilityResponseSchema
>;
