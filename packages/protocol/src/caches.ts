import {
	cacheAccessModeSchema,
	cacheNamePrefixPattern,
	cachePrioritySchema,
	cacheScopeSchema,
	graceSecondsSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { cacheRootRetentionSchema } from './retention.ts';
import { isoTimestampSchema } from './scalars.ts';

export const cacheGraceSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('none') }),
	z.strictObject({
		kind: z.literal('duration'),
		graceSeconds: graceSecondsSchema
	})
]);
export type CacheGrace = z.output<typeof cacheGraceSchema>;

export const rootRetentionOverrideSchema = z.strictObject({
	rootPrefix: rootNameSchema,
	retention: cacheRootRetentionSchema
});
export type RootRetentionOverride = z.output<
	typeof rootRetentionOverrideSchema
>;

// `graceManaged` records whether grace management is permanent, and
// `earliestGraceDeadline` reports the earliest live deadline, when one exists.
// They remain optional so responses from servers that predate them still
// validate. The compatibility policy does not support an older CLI strictly
// parsing fields added by a newer server (PLAN.md, "Compatibility").
export const cacheSummarySchema = z.strictObject({
	scope: cacheScopeSchema,
	access: cacheAccessModeSchema,
	priority: cachePrioritySchema,
	storePaths: countSchema,
	defaultRootRetention: cacheRootRetentionSchema,
	grace: cacheGraceSchema,
	rootRetentionOverrides: z.array(rootRetentionOverrideSchema),
	graceManaged: z.boolean().optional(),
	retireWhenEmpty: z.boolean().optional(),
	retirementEligibleAfter: isoTimestampSchema.optional(),
	earliestGraceDeadline: isoTimestampSchema.optional()
});
export type CacheSummary = z.output<typeof cacheSummarySchema>;

export const maxRootRetentionOverrides = 4096;

export const cacheListEntrySchema = z.strictObject({
	...cacheSummarySchema.shape,
	rootRetentionOverrides:
		cacheSummarySchema.shape.rootRetentionOverrides.optional()
});
export type CacheListEntry = z.output<typeof cacheListEntrySchema>;

export const cacheListPageSize = 200;

export const cacheListInputSchema = z
	.strictObject({
		cursor: z.string().min(1).max(63).regex(cacheNamePrefixPattern).optional(),
		limit: z.number().int().min(1).max(cacheListPageSize).optional(),
		namePrefix: z.string().max(63).regex(cacheNamePrefixPattern).optional()
	})
	.superRefine((input, context) => {
		if (input.cursor === undefined) {
			return;
		}

		const isValid =
			input.namePrefix === undefined
				? /^[1-9]\d*$/.test(input.cursor) &&
					Number.isSafeInteger(Number(input.cursor))
				: input.cursor.startsWith(input.namePrefix);
		if (!isValid) {
			context.addIssue({
				code: 'custom',
				path: ['cursor'],
				message: 'Cursor does not match the listing query.'
			});
		}
	})
	.default({});
export type CacheListInput = z.output<typeof cacheListInputSchema>;

export const cacheListResponseSchema = z.strictObject({
	caches: z.array(cacheListEntrySchema),
	cursor: z.string().min(1).optional()
});
export type CacheListResponse = z.output<typeof cacheListResponseSchema>;

export const cachePutBodySchema = z.strictObject({
	access: cacheAccessModeSchema,
	priority: cachePrioritySchema,
	defaultRootRetention: cacheRootRetentionSchema.default({ kind: 'permanent' }),
	grace: cacheGraceSchema.default({ kind: 'none' })
});
export type CachePutBody = z.output<typeof cachePutBodySchema>;

export const cacheRetirementBodySchema = z.strictObject({
	retireWhenEmpty: z.boolean()
});
export type CacheRetirementBody = z.output<typeof cacheRetirementBodySchema>;

export const cacheUpdateBodySchema = z.discriminatedUnion('kind', [
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
		retention: cacheRootRetentionSchema
	}),
	z.strictObject({
		kind: z.literal('set-root-ttl-override'),
		rootPrefix: rootNameSchema,
		retention: cacheRootRetentionSchema
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
]);
export type CacheUpdateBody = z.output<typeof cacheUpdateBodySchema>;

export const cacheRemoveResponseSchema = z.strictObject({
	scope: cacheScopeSchema,
	removed: z.boolean(),
	storePathsRemoved: countSchema
});
export type CacheRemoveResponse = z.output<typeof cacheRemoveResponseSchema>;

export type CacheSummaryInput = z.input<typeof cacheSummarySchema>;
export type CacheListInputInput = z.input<typeof cacheListInputSchema>;
export type CacheListResponseInput = z.input<typeof cacheListResponseSchema>;
export type CachePutBodyInput = z.input<typeof cachePutBodySchema>;
export type CacheUpdateBodyInput = z.input<typeof cacheUpdateBodySchema>;
export type CacheRemoveResponseInput = z.input<
	typeof cacheRemoveResponseSchema
>;
