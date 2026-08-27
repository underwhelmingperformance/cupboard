import {
	cacheNamePattern,
	cacheNamePrefixPattern,
	type CachePriority,
	publicCacheSelectorSchema
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
export type ParsedReuseViewName = z.output<typeof reuseViewNameSchema>;

// A prefix selector's pattern has the same maximum length as a public cache's
// local name because a longer prefix could not match one. The pattern can be
// empty; the empty prefix matches every public cache.
const reuseViewSelectorPatternMaxLength = 63;

export const reuseViewSelectorKindSchema = z.enum(['exact', 'prefix']);

// The pattern of an `exact` selector is a public selector, including
// `_default`. A `prefix` selector matches named public caches whose stored
// names start with its pattern. The empty prefix also matches the default
// cache. Reuse-view selectors never match private caches.
export const reuseViewSelectorSchema = z
	.strictObject({
		kind: reuseViewSelectorKindSchema,
		pattern: z.string().max(reuseViewSelectorPatternMaxLength)
	})
	.refine(
		(selector) =>
			selector.kind !== 'exact' ||
			publicCacheSelectorSchema.safeParse(selector.pattern).success,
		{
			message:
				"An exact selector pattern must be a valid cache name or '_default'"
		}
	)
	.refine(
		(selector) =>
			selector.kind !== 'prefix' ||
			cacheNamePrefixPattern.test(selector.pattern),
		{
			message: 'A prefix selector pattern must be a valid cache-name prefix'
		}
	);
export type ParsedReuseViewSelector = z.output<typeof reuseViewSelectorSchema>;

// A request can contain at most 32 selectors, which bounds request size and
// selector matching work.
export const reuseViewMaxSelectors = 32;

function hasDuplicateSelector(
	selectors: readonly { readonly kind: string; readonly pattern: string }[]
): boolean {
	const seen = new Set(
		selectors.map((selector) => `${selector.kind}\0${selector.pattern}`)
	);

	return seen.size !== selectors.length;
}

export const reuseViewSelectorsSchema = z
	.array(reuseViewSelectorSchema)
	.min(1)
	.max(reuseViewMaxSelectors)
	.refine((selectors) => !hasDuplicateSelector(selectors), {
		message: 'Selectors must not contain duplicate kind and pattern pairs'
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
	selectors: reuseViewSelectorsSchema,
	priority: reuseViewPrioritySchema.optional()
});
export type ParsedReuseViewSetBody = z.output<typeof reuseViewSetBodySchema>;

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
	revision: reuseViewRevisionSchema,
	priority: reuseViewPrioritySchema,
	selectors: z.array(reuseViewSelectorSchema),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema
});
export type ParsedReuseViewSummary = z.output<typeof reuseViewSummarySchema>;

export const reuseViewListResponseSchema = z.strictObject({
	views: z.array(reuseViewSummarySchema)
});
export type ParsedReuseViewListResponse = z.output<
	typeof reuseViewListResponseSchema
>;

export const reuseViewRemoveResponseSchema = z.strictObject({
	name: reuseViewNameSchema,
	removed: z.boolean()
});
export type ParsedReuseViewRemoveResponse = z.output<
	typeof reuseViewRemoveResponseSchema
>;

export type ReuseViewSelector = z.input<typeof reuseViewSelectorSchema>;
export type ReuseViewSetBody = z.input<typeof reuseViewSetBodySchema>;
export type ReuseViewSummary = z.input<typeof reuseViewSummarySchema>;
export type ReuseViewListResponse = z.input<typeof reuseViewListResponseSchema>;
export type ReuseViewRemoveResponse = z.input<
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
