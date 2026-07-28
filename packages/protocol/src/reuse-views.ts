import {
	cacheNamePattern,
	cacheNamePrefixPattern,
	type CachePriority,
	cacheSelectorSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// A reuse view's name shares a cache name's shape (lowercase, bounded), since
// it is served beneath its own path segment the same way a cache name is, but
// it is not a cache name itself: the brand keeps the two from being confused
// at a call site that takes one or the other.
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
				"an exact selector's pattern must be a valid cache name or '_default'"
		}
	)
	.refine(
		(selector) =>
			selector.kind !== 'prefix' ||
			cacheNamePrefixPattern.test(selector.pattern),
		{
			message:
				"a prefix selector's pattern must be a prefix of a valid cache name"
		}
	);
export type ParsedReuseViewSelector = z.output<typeof reuseViewSelectorSchema>;

// Bounds a view's source list the same way a push's closure and a confirm's
// path list are bounded: well above any real definition, so the cap rejects
// only an abusive body.
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
		message: 'selectors must not repeat the same kind and pattern'
	});

// A Nix substituter priority, the same shape as a cache's own
// `cachePrioritySchema`: a non-negative integer where lower is preferred. A
// view's priority is its own domain, so it carries its own brand and cannot
// stand in for a cache's priority.
export const reuseViewPrioritySchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER)
	.brand('ReuseViewPriority');
export type ReuseViewPriority = z.output<typeof reuseViewPrioritySchema>;

// Ten past the cache registry's own default priority of 40. The anchor is
// fixed rather than derived from that default, since a view spans caches
// whose individual priorities may differ; a view's priority only has to sit
// behind the caches it draws from, not track any one of them.
export const reuseViewDefaultPriority = reuseViewPrioritySchema.parse(50);

export const reuseViewSetBodySchema = z.strictObject({
	selectors: reuseViewSelectorsSchema,
	priority: reuseViewPrioritySchema.optional()
});
export type ParsedReuseViewSetBody = z.output<typeof reuseViewSetBodySchema>;

// A reuse view's definition revision, issued by its own persistent counter and
// bumped on every definition change. Its own brand keeps it from crossing with a
// narinfo generation or any other integer fence.
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
	createdAt: z.string(),
	updatedAt: z.string()
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
