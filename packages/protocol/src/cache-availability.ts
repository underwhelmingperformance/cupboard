import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The server deduplicates the request before probing R2. At most 900 distinct
// hashes therefore produce at most 900 head requests, leaving headroom beneath
// the Worker's internal-subrequest ceiling.
export const cacheAvailabilityMaxPaths = 900;

// The reuse-view route accepts at most 50 requested hashes. After
// deduplication, each hash can select up to 16 candidate NARs, so one request
// can require at most 800 R2 head requests.
export const reuseViewAvailabilityMaxPaths = 50;

export const cacheAvailabilityRequestSchema = z.strictObject({
	storePathHashes: z.array(storePathHashSchema).max(cacheAvailabilityMaxPaths)
});
export type CacheAvailabilityRequestInput = z.input<
	typeof cacheAvailabilityRequestSchema
>;
export type CacheAvailabilityRequest = z.output<
	typeof cacheAvailabilityRequestSchema
>;

export const reuseViewAvailabilityRequestSchema = z.strictObject({
	storePathHashes: z
		.array(storePathHashSchema)
		.max(reuseViewAvailabilityMaxPaths)
});
export type ReuseViewAvailabilityRequestInput = z.input<
	typeof reuseViewAvailabilityRequestSchema
>;
export type ReuseViewAvailabilityRequest = z.output<
	typeof reuseViewAvailabilityRequestSchema
>;

export const cacheAvailabilityResponseSchema = z.strictObject({
	missingStorePathHashes: z
		.array(storePathHashSchema)
		.max(cacheAvailabilityMaxPaths)
});
export type CacheAvailabilityResponseInput = z.input<
	typeof cacheAvailabilityResponseSchema
>;
export type CacheAvailabilityResponse = z.output<
	typeof cacheAvailabilityResponseSchema
>;
