import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The hashes one availability request carries.
//
// This is a page size, not a bound on what a caller may ask. The CLI chunks
// at it in `packages/cli/src/plan/destination-probe.ts` and the Action's
// publication planner in `actions/src/publish-plan.ts`. The tenant Worker
// answers a page through its Durable Object in chunks sized to one
// invocation's subrequest allowance (`chunked-availability.ts` in the server),
// so the page is not bounded by that allowance. What bounds it is elapsed
// time: the object heads one narinfo object per hash, six at a time, so a
// page costs 150 sequential rounds of R2 latency, which has not been measured.
export const cacheAvailabilityMaxPaths = 900;

// A view probe heads one NAR for each distinct NAR among a hash's candidate
// caches, so a hash whose copies agree costs one head, the same as a cache
// probe. A hash whose copies disagree costs up to `reuseDistinctNarLimit`
// heads and is answered as missing; the Worker's chunks are sized to that
// worst case. Derived from the cache page size so that one measurement
// changes both.
export const reuseViewAvailabilityMaxPaths = cacheAvailabilityMaxPaths;

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
