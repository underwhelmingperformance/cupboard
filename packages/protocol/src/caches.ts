import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

// The empty name identifies the default cache. The grace fields report whether
// grace management is permanent and the earliest live deadline, when one
// exists. These fields remain optional so responses from servers that predate
// them still validate. The compatibility policy does not support an older CLI
// strictly parsing fields added by a newer server (PLAN.md, "Compatibility").
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
