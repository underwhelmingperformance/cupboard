import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The hashes one availability request carries.
//
// Both routes answer a question a caller asks about any number of paths: the
// CLI chunks at these values in `packages/cli/src/plan/destination-probe.ts`,
// and the publication planner in `actions/src/publish-plan.ts` chunks at
// `cacheAvailabilityMaxPaths`, so a plan over ten thousand paths is answered
// in pages and nothing is refused. These are the page sizes of that paging,
// not a bound on what a caller may ask for.
//
// What bounds a useful page is elapsed time, not the subrequest ceiling: 900
// narinfo heads is well inside it. The heads run six at a time, which is
// every simultaneous outgoing connection a request has, so 900 hashes take
// 150 sequential rounds of R2 latency. That latency has not been measured,
// and measuring it needs a deployed environment, because the local test pool
// enforces neither limit. Nothing else constrains the value.
export const cacheAvailabilityMaxPaths = 900;

// The same page size, because the two probes now cost the same.
//
// A cache probe heads one narinfo for each hash. A view probe heads one NAR for
// each distinct NAR among a hash's candidate caches, and copies that agree share
// one NAR, so an agreeing hash costs one head as well. Only a hash whose copies
// disagree costs more, and such a hash is answered as missing in any case.
//
// Derive this from the cache page size rather than restating the number, so
// that whatever measurement replaces one replaces both.
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
