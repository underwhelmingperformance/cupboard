import {
	cacheAccessModeSchema,
	cacheNamePattern,
	cacheNamePrefixPattern,
	cacheNameSchema,
	type CachePriority
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

// Reuse-view names use the same lowercase and length constraints as cache names
// because both appear as path segments. A separate brand prevents a reuse-view
// name from being passed where code expects a cache name.
export const reuseViewNameSchema = z
	.string()
	.regex(cacheNamePattern)
	.brand('ReuseViewName');
export type ReuseViewName = z.output<typeof reuseViewNameSchema>;

const reuseViewPrefixMaxLength = 63;

/**
The caches a view may query.
*/
export const reuseViewSelectorSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('default') }),
	z.strictObject({ kind: z.literal('named'), name: cacheNameSchema }),
	z.strictObject({
		kind: z.literal('prefix'),
		prefix: z
			.string()
			.min(1)
			.max(reuseViewPrefixMaxLength)
			.regex(cacheNamePrefixPattern)
	}),
	z.strictObject({ kind: z.literal('all-named') }),
	z.strictObject({ kind: z.literal('all') })
]);
export type ReuseViewSelector = z.output<typeof reuseViewSelectorSchema>;

// A request can contain at most 32 selectors, which bounds request size and
// selector matching work.
export const reuseViewMaxSelectors = 32;

function hasDuplicateSelector(
	selectors: readonly ReuseViewSelector[]
): boolean {
	const seen = new Set(selectors.map((selector) => JSON.stringify(selector)));

	return seen.size !== selectors.length;
}

export const reuseViewSelectorsSchema = z
	.array(reuseViewSelectorSchema)
	.min(1)
	.max(reuseViewMaxSelectors)
	.refine((selectors) => !hasDuplicateSelector(selectors), {
		message: 'Selectors must not repeat the same cache or prefix'
	});

// A reuse view has its own branded Nix substituter priority, where lower numbers
// are preferred. The brand prevents a view priority from being passed where code
// expects a cache priority.
export const reuseViewPrioritySchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER)
	.brand('ReuseViewPriority');
export type ReuseViewPriority = z.output<typeof reuseViewPrioritySchema>;

// The default numeric priority is 50, ten greater than the cache-registry
// default of 40. Nix prefers lower numeric priorities, so a destination at the
// registry default remains preferred. The fixed value cannot follow a source
// priority because a view can select sources with different priorities.
export const reuseViewDefaultPriority = reuseViewPrioritySchema.parse(50);

export const reuseViewSetBodySchema = z.strictObject({
	access: cacheAccessModeSchema,
	selectors: reuseViewSelectorsSchema,
	priority: reuseViewPrioritySchema.optional()
});
export type ReuseViewSetBody = z.output<typeof reuseViewSetBodySchema>;

// A persistent counter assigns a strictly increasing revision whenever a
// reuse-view definition changes. A separate brand distinguishes this revision
// from narinfo generations and other counters.
export const reuseViewRevisionSchema = z
	.number()
	.int()
	.min(1)
	.brand('ReuseViewRevision');
export type ReuseViewRevision = z.output<typeof reuseViewRevisionSchema>;

export const reuseViewSummarySchema = z.strictObject({
	name: reuseViewNameSchema,
	access: cacheAccessModeSchema,
	revision: reuseViewRevisionSchema,
	priority: reuseViewPrioritySchema,
	selectors: z.array(reuseViewSelectorSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema
});
export type ReuseViewSummary = z.output<typeof reuseViewSummarySchema>;

export const reuseViewListResponseSchema = z.strictObject({
	views: z.array(reuseViewSummarySchema)
});
export type ReuseViewListResponse = z.output<
	typeof reuseViewListResponseSchema
>;

export const reuseViewRemoveResponseSchema = z.strictObject({
	name: reuseViewNameSchema,
	removed: z.boolean()
});
export type ReuseViewRemoveResponse = z.output<
	typeof reuseViewRemoveResponseSchema
>;

export type ReuseViewSelectorInput = z.input<typeof reuseViewSelectorSchema>;
export type ReuseViewSetBodyInput = z.input<typeof reuseViewSetBodySchema>;
export type ReuseViewSummaryInput = z.input<typeof reuseViewSummarySchema>;
export type ReuseViewListResponseInput = z.input<
	typeof reuseViewListResponseSchema
>;
export type ReuseViewRemoveResponseInput = z.input<
	typeof reuseViewRemoveResponseSchema
>;

// The amount added to a destination cache's numeric priority when assigning a
// priority to the reuse view. Nix therefore prefers the destination's lower
// value.
export const viewPriorityMargin = 10;

/**
 * Returns true when Nix will prefer the destination cache to the reuse view.
 * Nix prefers lower priorities, so the view's value must be strictly greater.
 */
export function isDestinationPreferred(
	destinationPriority: CachePriority,
	viewPriority: ReuseViewPriority
): boolean {
	return viewPriority > destinationPriority;
}
