import { type CacheAccessMode } from '@cupboard/nix-store/scalars';
import {
	privateStoredReuseView,
	type ReuseViewName,
	type ReuseViewSelector,
	reuseViewSelectorSchema,
	reuseViewSelectorsSchema,
	type StoredReuseView
} from '@cupboard/protocol/reuse-views';

import * as schema from '../db/schema.ts';
import { StoredReuseViewSelectorInvalidError } from '../errors.ts';

export function reuseViewSelectorRow(
	selector: ReuseViewSelector
): Pick<
	typeof schema.nativeReuseViewSelectors.$inferInsert,
	'kind' | 'cacheName' | 'prefix'
> {
	switch (selector.kind) {
		case 'default':
		case 'all-named':
		case 'all': {
			return { kind: selector.kind, cacheName: undefined, prefix: undefined };
		}
		case 'named': {
			return { kind: 'named', cacheName: selector.name, prefix: undefined };
		}
		case 'prefix': {
			return { kind: 'prefix', cacheName: undefined, prefix: selector.prefix };
		}
	}
}

/**
 * Reads a stored selector back, or returns `undefined` when the two columns do
 * not describe one. The migration that introduced these kinds rewrote every
 * existing row, so a caller treats `undefined` as a stored-data fault.
 */
export function reuseViewSelectorFromRow(
	row: Pick<
		typeof schema.nativeReuseViewSelectors.$inferSelect,
		'kind' | 'cacheName' | 'prefix'
	>
): ReuseViewSelector | undefined {
	switch (row.kind) {
		case 'default':
		case 'all-named':
		case 'all': {
			return row.cacheName === null && row.prefix === null
				? { kind: row.kind }
				: undefined;
		}
		case 'named': {
			return reuseViewSelectorSchema.safeParse({
				kind: 'named',
				name: row.cacheName
			}).data;
		}
		case 'prefix': {
			return reuseViewSelectorSchema.safeParse({
				kind: 'prefix',
				prefix: row.prefix
			}).data;
		}
	}
}

/**
 * Reads every stored selector of one view. A row the two columns do not
 * describe is a stored-data fault: skipping it would change the set of caches
 * the view reads from, so the read refuses instead.
 */
export function reuseViewSelectorsFromRows(
	view: string,
	rows: readonly Pick<
		typeof schema.nativeReuseViewSelectors.$inferSelect,
		'kind' | 'cacheName' | 'prefix'
	>[]
): ReuseViewSelector[] {
	const selectors = rows.map((row) => {
		const selector = reuseViewSelectorFromRow(row);

		if (selector === undefined) {
			throw new StoredReuseViewSelectorInvalidError(view);
		}

		return selector;
	});
	const parsed = reuseViewSelectorsSchema.safeParse(selectors);

	if (!parsed.success) {
		throw new StoredReuseViewSelectorInvalidError(view);
	}

	return parsed.data;
}

// The legacy selector grammar spells the default cache this way. The constant
// names a retired spelling that only the legacy mirror still writes.
const legacyDefaultCacheSelector = '_default';

/**
 * The stored key of a view with this local name and access.
 *
 * Storage still ties a view's identity to its namespace, so the key follows the
 * access rather than the name alone. The contraction that renames the rows to
 * local names comes later.
 */
export function legacyReuseViewKey(
	name: ReuseViewName,
	access: CacheAccessMode
): StoredReuseView {
	return access === 'private' ? privateStoredReuseView(name) : name;
}

/**
 * Both stored keys a local name can have.
 *
 * A request spells only the local name, so a lookup matches both spellings and
 * reads the access from the row it finds. At most one row answers: the backfill
 * asserts that no local name exists in both namespaces, and a write replaces
 * the rows held under both keys.
 */
export function legacyReuseViewKeys(
	name: ReuseViewName
): [StoredReuseView, StoredReuseView] {
	return [name, privateStoredReuseView(name)];
}

/**
 * The legacy row for one selector.
 *
 * The legacy grammar has no kind of its own for `all-named`: a private view's
 * empty prefix already meant every named cache of its namespace, so both kinds
 * mirror to the empty prefix and the view's access tells them apart on the way
 * back.
 */
export function legacyReuseViewSelectorRow(
	selector: ReuseViewSelector
): Pick<typeof schema.reuseViewSelectors.$inferInsert, 'kind' | 'pattern'> {
	switch (selector.kind) {
		case 'default': {
			return { kind: 'exact', pattern: legacyDefaultCacheSelector };
		}
		case 'named': {
			return { kind: 'exact', pattern: selector.name };
		}
		case 'prefix': {
			return { kind: 'prefix', pattern: selector.prefix };
		}
		case 'all-named':
		case 'all': {
			return { kind: 'prefix', pattern: '' };
		}
	}
}

/**
 * The legacy rows for a view's complete selector set.
 *
 * Two native selectors can share one legacy row, which the legacy primary key
 * over `(view, kind, pattern)` would reject, so the set collapses to distinct
 * rows first.
 */
export function legacyReuseViewSelectorRows(
	view: StoredReuseView,
	selectors: readonly ReuseViewSelector[]
): (typeof schema.reuseViewSelectors.$inferInsert)[] {
	const rows = new Map(
		selectors
			.map((selector) => legacyReuseViewSelectorRow(selector))
			.map((row) => [`${row.kind}\0${row.pattern}`, { view, ...row }])
	);

	return rows.values().toArray();
}
