import { cachePrioritySchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

// A cache summary names a cache (the empty string is the default), its Nix
// priority and how many store paths it holds.
export const cacheSummarySchema = z.strictObject({
	name: z.string(),
	priority: cachePrioritySchema,
	storePaths: countSchema
});
export type ParsedCacheSummary = z.output<typeof cacheSummarySchema>;

export const cacheListResponseSchema = z.strictObject({
	caches: z.array(cacheSummarySchema)
});
export type ParsedCacheListResponse = z.output<typeof cacheListResponseSchema>;

export const cachePutBodySchema = z.strictObject({
	priority: cachePrioritySchema
});
export type ParsedCachePutBody = z.output<typeof cachePutBodySchema>;

export const cacheRemoveResponseSchema = z.strictObject({
	name: z.string(),
	removed: z.boolean(),
	storePathsRemoved: countSchema
});
export type ParsedCacheRemoveResponse = z.output<
	typeof cacheRemoveResponseSchema
>;

export type CacheSummary = z.input<typeof cacheSummarySchema>;
export type CacheListResponse = z.input<typeof cacheListResponseSchema>;
export type CachePutBody = z.input<typeof cachePutBodySchema>;
export type CacheRemoveResponse = z.input<typeof cacheRemoveResponseSchema>;
