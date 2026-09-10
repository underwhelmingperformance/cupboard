import {
	cacheAccessModeSchema,
	cachePrioritySchema,
	cacheScopeSchema,
	graceSecondsSchema,
	rootNameSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

// The operational grace fields report whether grace management is permanent and
// the earliest live deadline, when one exists. They remain optional so responses
// from servers that predate them still validate. The compatibility policy does
// not support an older CLI strictly parsing fields added by a newer server
// (PLAN.md, "Compatibility").
export const defaultRootTtlSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('permanent') }),
	z.strictObject({
		kind: z.literal('duration'),
		ttlSeconds: ttlSecondsSchema
	})
]);
export type DefaultRootTtl = z.output<typeof defaultRootTtlSchema>;

export const cacheGraceSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('none') }),
	z.strictObject({
		kind: z.literal('duration'),
		graceSeconds: graceSecondsSchema
	})
]);
export type CacheGrace = z.output<typeof cacheGraceSchema>;

export const rootTtlOverrideSchema = z.strictObject({
	rootPrefix: rootNameSchema,
	ttlSeconds: ttlSecondsSchema
});
export type RootTtlOverride = z.output<typeof rootTtlOverrideSchema>;

export const cacheSummarySchema = z.strictObject({
	scope: cacheScopeSchema,
	access: cacheAccessModeSchema,
	priority: cachePrioritySchema,
	storePaths: countSchema,
	defaultRootTtl: defaultRootTtlSchema,
	grace: cacheGraceSchema,
	rootTtlOverrides: z.array(rootTtlOverrideSchema),
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
	priority: cachePrioritySchema,
	defaultRootTtl: defaultRootTtlSchema.default({ kind: 'permanent' }),
	grace: cacheGraceSchema.default({ kind: 'none' })
});
export type CachePutBody = z.output<typeof cachePutBodySchema>;

const cacheUpdateBodyOptions = [
	z.strictObject({
		kind: z.literal('access'),
		access: cacheAccessModeSchema
	}),
	z.strictObject({
		kind: z.literal('priority'),
		priority: cachePrioritySchema
	}),
	z.strictObject({
		kind: z.literal('set-default-root-ttl'),
		ttlSeconds: ttlSecondsSchema
	}),
	z.strictObject({
		kind: z.literal('clear-default-root-ttl')
	}),
	z.strictObject({
		kind: z.literal('set-root-ttl-override'),
		rootPrefix: rootNameSchema,
		ttlSeconds: ttlSecondsSchema
	}),
	z.strictObject({
		kind: z.literal('clear-root-ttl-override'),
		rootPrefix: rootNameSchema
	}),
	z.strictObject({
		kind: z.literal('set-grace'),
		graceSeconds: graceSecondsSchema
	}),
	z.strictObject({ kind: z.literal('clear-grace') })
] as const;

export const cacheUpdateBodySchema = z.discriminatedUnion(
	'kind',
	cacheUpdateBodyOptions
);
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
