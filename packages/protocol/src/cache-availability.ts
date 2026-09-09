import { storePathHashSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// The server deduplicates the request before probing R2, so at most 900 distinct
// hashes produce at most 900 head requests. Every cap in this file and in
// `retention.ts` is checked against `subrequestsPerInvocation` by
// `packages/server/src/do/subrequest-budget.test.ts`.
export const cacheAvailabilityMaxPaths = 900;

// The reuse-view route accepts at most 50 requested hashes. After deduplication
// each hash can select one candidate beyond `reuseCandidateLimit`, and each
// candidate's NAR is probed, so one request makes at most 850 head requests.
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
