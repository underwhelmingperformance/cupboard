import {
	cacheNamePattern,
	cacheNamePrefixPattern,
	type CachePriority,
	PRIVATE_SELECTOR_PREFIX,
	PRIVATE_STORED_PREFIX,
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

// Derive both private forms from the local name so they share its validation.
// The cache-name grammar excludes slashes and an initial underscore, which
// makes the `private/` and `_private-` prefixes unambiguous.
function hasPrefixedLocalName(value: string, prefix: string): boolean {
	return (
		value.startsWith(prefix) &&
		reuseViewNameSchema.safeParse(value.slice(prefix.length)).success
	);
}

/**
 * A private reuse view's stored name: `private/` followed by its local name.
 * The prefix makes the namespace part of the view identity. Moving a view
 * between namespaces therefore creates a different identity.
 */
export const privateStoredReuseViewSchema = z
	.string()
	.refine((value) => hasPrefixedLocalName(value, PRIVATE_STORED_PREFIX))
	.brand('PrivateStoredReuseView');
export type PrivateStoredReuseView = z.output<
	typeof privateStoredReuseViewSchema
>;

/**
 * A private reuse view's contract name: `_private-` followed by its local
 * name. Contract paths and grants spell a view this way; the read routes under
 * `/private-reuse/` carry the local name instead.
 */
export const privateReuseViewNameSchema = z
	.string()
	.refine((value) => hasPrefixedLocalName(value, PRIVATE_SELECTOR_PREFIX))
	.brand('PrivateReuseViewName');
export type PrivateReuseViewName = z.output<typeof privateReuseViewNameSchema>;

/**
 * A reuse-view name in the contract: the local name for a public view or the
 * `_private-` name for a private view.
 */
export const reuseViewContractNameSchema = z.union([
	reuseViewNameSchema,
	privateReuseViewNameSchema
]);
export type ReuseViewContractName = z.output<
	typeof reuseViewContractNameSchema
>;

/**
 * A stored reuse-view name: the local name for a public view or the `private/`
 * name for a private view. Convert a contract name with
 * `reuseViewFromContractName`.
 */
export const storedReuseViewSchema = z.union([
	reuseViewNameSchema,
	privateStoredReuseViewSchema
]);
export type StoredReuseView = z.output<typeof storedReuseViewSchema>;

export function isPrivateReuseView(
	view: StoredReuseView
): view is PrivateStoredReuseView {
	return privateStoredReuseViewSchema.safeParse(view).success;
}

/**
 * Returns the stored name for a private view with the given local name.
 */
export function privateStoredReuseView(
	name: ParsedReuseViewName
): PrivateStoredReuseView {
	return privateStoredReuseViewSchema.parse(`${PRIVATE_STORED_PREFIX}${name}`);
}

function isPrivateReuseViewName(
	name: ReuseViewContractName
): name is PrivateReuseViewName {
	return privateReuseViewNameSchema.safeParse(name).success;
}

export function reuseViewFromContractName(
	name: ReuseViewContractName
): StoredReuseView {
	if (isPrivateReuseViewName(name)) {
		return privateStoredReuseViewSchema.parse(
			`${PRIVATE_STORED_PREFIX}${name.slice(PRIVATE_SELECTOR_PREFIX.length)}`
		);
	}

	return name;
}

export function contractNameForReuseView(
	view: StoredReuseView
): ReuseViewContractName {
	if (isPrivateReuseView(view)) {
		return privateReuseViewNameSchema.parse(
			`${PRIVATE_SELECTOR_PREFIX}${view.slice(PRIVATE_STORED_PREFIX.length)}`
		);
	}

	return view;
}

// A prefix selector's pattern has the same maximum length as a public cache's
// local name because a longer prefix could not match one. The pattern can be
// empty; the empty prefix matches every public cache.
const reuseViewSelectorPatternMaxLength = 63;

export const reuseViewSelectorKindSchema = z.enum(['exact', 'prefix']);

// The view's namespace determines the selector namespace. A public view selects
// public caches, and a private view selects private caches.
//
// An `exact` selector matches one cache, or the default cache as `_default`. A
// `prefix` selector matches named caches with local names that start with its
// pattern. The empty prefix matches every named cache and, in a public view,
// the default cache. The server accepts `_default` only for a public view.
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

// A summary reports the contract name. Private view names therefore use the
// `_private-` prefix.
export const reuseViewSummarySchema = z.strictObject({
	name: reuseViewContractNameSchema,
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
	name: reuseViewContractNameSchema,
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
