import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

// A cache summary names a cache (the empty string is the default), its Nix
// priority, how many store paths it holds, and its grace state: whether the
// cache is permanently grace-managed, and the earliest live grace deadline
// when one exists. The grace fields are optional so a summary from a server
// that predates them still validates; the reverse skew, an older CLI's strict
// parse against a newer server, is out of scope per the compatibility policy
// (PLAN.md, "Compatibility").
export const cacheSummarySchema = z.strictObject({
	name: z.string(),
	priority: cachePrioritySchema,
	storePaths: countSchema,
	graceManaged: z.boolean().optional(),
	earliestGraceDeadline: isoTimestampSchema.optional()
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
