import {
	cacheNamePattern,
	cacheNamePrefixPattern,
	type CachePriority,
	cacheSelectorSchema
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

// A prefix selector's pattern is bounded by a cache name's own maximum
// length, since a longer prefix could never match one; the empty prefix
// matches every cache, current and future.
const reuseViewSelectorPatternMaxLength = 63;

export const reuseViewSelectorKindSchema = z.enum(['exact', 'prefix']);

// An `exact` selector names one cache by its wire name, including `_default`;
// a `prefix` selector matches every named cache whose name starts with its
// pattern, so it may be shorter, including empty (which also covers default).
export const reuseViewSelectorSchema = z
	.strictObject({
		kind: reuseViewSelectorKindSchema,
		pattern: z.string().max(reuseViewSelectorPatternMaxLength)
	})
	.refine(
		(selector) =>
			selector.kind !== 'exact' ||
			cacheSelectorSchema.safeParse(selector.pattern).success,
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

// A reuse view accepts at most 32 source selectors. This is above expected
// definitions and bounds abusive request bodies.
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

// The default is 50, ten lower in preference than the cache-registry default of
// 40. A fixed value is appropriate because source caches can have different
// priorities. The view needs to follow its sources but does not track any one
// source priority.
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

// The shapes a builder assembles: a schema's input is unbranded, so the CLI
// constructs a request body and the server a response body from these forms
// directly. The `Parsed…` outputs above are what a successful parse yields, and
// code that consumes a validated value takes that branded form.
export type ReuseViewSelector = z.input<typeof reuseViewSelectorSchema>;
export type ReuseViewSetBody = z.input<typeof reuseViewSetBodySchema>;
export type ReuseViewSummary = z.input<typeof reuseViewSummarySchema>;
export type ReuseViewListResponse = z.input<typeof reuseViewListResponseSchema>;
export type ReuseViewRemoveResponse = z.input<
	typeof reuseViewRemoveResponseSchema
>;

// The gap by which a reuse view's priority is set below its destination cache,
// so Nix prefers the destination while still consulting the view.
export const viewPriorityMargin = 10;

/**
 * Whether a destination cache stays preferred over a reuse view: true when the
 * view's priority is strictly greater, since Nix prefers the lower priority.
 */
export function isDestinationPreferred(
	destinationPriority: CachePriority,
	viewPriority: ReuseViewPriority
): boolean {
	return viewPriority > destinationPriority;
}
