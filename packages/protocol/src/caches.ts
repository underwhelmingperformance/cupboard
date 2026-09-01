import {
	cacheAccessModeSchema,
	cachePrioritySchema,
	cacheScopeSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

// The grace fields report whether grace management is permanent and the earliest
// live deadline, when one exists. These fields remain optional so responses from
// servers that predate them still validate. The compatibility policy does not
// support an older CLI strictly parsing fields added by a newer server (PLAN.md,
// "Compatibility").
export const cacheSummarySchema = z.strictObject({
	scope: cacheScopeSchema,
	access: cacheAccessModeSchema,
	priority: cachePrioritySchema,
	storePaths: countSchema,
	graceManaged: z.boolean().optional(),
	earliestGraceDeadline: isoTimestampSchema.optional()
});
export type CacheSummary = z.output<typeof cacheSummarySchema>;

export const cacheListResponseSchema = z.strictObject({
	caches: z.array(cacheSummarySchema)
});
export type CacheListResponse = z.output<typeof cacheListResponseSchema>;

export const cachePutBodySchema = z.strictObject({
	access: cacheAccessModeSchema,
	priority: cachePrioritySchema
});
export type CachePutBody = z.output<typeof cachePutBodySchema>;

export const cacheUpdateBodySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('access'),
		access: cacheAccessModeSchema
	}),
	z.strictObject({
		kind: z.literal('priority'),
		priority: cachePrioritySchema
	})
]);
export type CacheUpdateBody = z.output<typeof cacheUpdateBodySchema>;

export const cacheRemoveResponseSchema = z.strictObject({
	scope: cacheScopeSchema,
	removed: z.boolean(),
	storePathsRemoved: countSchema
});
export type CacheRemoveResponse = z.output<typeof cacheRemoveResponseSchema>;

export type CacheSummaryInput = z.input<typeof cacheSummarySchema>;
export type CacheListResponseInput = z.input<typeof cacheListResponseSchema>;
export type CachePutBodyInput = z.input<typeof cachePutBodySchema>;
export type CacheUpdateBodyInput = z.input<typeof cacheUpdateBodySchema>;
export type CacheRemoveResponseInput = z.input<
	typeof cacheRemoveResponseSchema
>;
