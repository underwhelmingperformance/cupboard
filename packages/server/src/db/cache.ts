import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope,
	DEFAULT_CACHE,
	privateStoredCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { or, type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import { jsonRowLists } from '../do/json-list.ts';
import { CacheIdentityMissingError } from '../errors.ts';

/**
 * The surrogate key of a `cache_identity` row, held by the `cache_id` columns
 * of the cache-scoped tables.
 */
export const cacheIdSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('CacheId');
export type CacheId = z.infer<typeof cacheIdSchema>;

const cacheIdentityRowSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('default'),
		name: z.undefined().optional()
	}),
	z.strictObject({ kind: z.literal('named'), name: cacheNameSchema })
]);

/**
 * One cache: its surrogate key, the scope that identifies it, and whether a
 * reader must present a credential for it.
 */
export interface ResolvedCache {
	readonly id: CacheId;
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
}

type CacheIdentityColumns =
	| { readonly cacheKind: 'default'; readonly cacheName: SQL<null> }
	| { readonly cacheKind: 'named'; readonly cacheName: CacheName };

/**
 * The `cache_kind` and `cache_name` values for a scope. A default cache
 * stores a SQL null for the name.
 *
 * Every insert into a table with these columns sets them. The mirroring
 * triggers fill them only while they exist, and a later migration drops the
 * triggers.
 */
export function cacheIdentityColumns(scope: CacheScope): CacheIdentityColumns {
	if (scope.kind === 'default') {
		return { cacheKind: 'default', cacheName: sql<null>`null` };
	}

	return { cacheKind: 'named', cacheName: scope.name };
}

/**
 * Matches the rows for one scope: the default cache by its kind and its null
 * name, a named cache by its kind and its name.
 */
export function cacheIdentityCondition(
	kind: AnySQLiteColumn,
	name: AnySQLiteColumn,
	scope: CacheScope
): SQL {
	if (scope.kind === 'default') {
		return sql`${kind} = 'default' and ${name} is null`;
	}

	return sql`${kind} = 'named' and ${name} = ${scope.name}`;
}

// Increment the last code unit to form an exclusive upper bound. Cache names
// are ASCII, so this cannot split or overflow a code point.
function prefixUpperBound(prefix: string): string {
	const last = prefix.codePointAt(prefix.length - 1);

	if (last === undefined) {
		throw new RangeError('prefix must be non-empty');
	}

	return prefix.slice(0, -1) + String.fromCodePoint(last + 1);
}

/**
 * A selector as the bound list carries it.
 *
 * A list value is text or a number, so a selector that names no cache carries
 * an empty name and empty prefix bounds. The predicate reads the kind before
 * it compares either, and neither a cache name nor a prefix is ever empty.
 */
interface ListedCacheSelector {
	readonly kind: ReuseViewSelector['kind'];
	readonly name: string;
	readonly lower: string;
	readonly upper: string;
}

function listedCacheSelector(selector: ReuseViewSelector): ListedCacheSelector {
	if (selector.kind === 'named') {
		return { kind: 'named', name: selector.name, lower: '', upper: '' };
	}

	if (selector.kind === 'prefix') {
		return {
			kind: 'prefix',
			name: '',
			lower: selector.prefix,
			upper: prefixUpperBound(selector.prefix)
		};
	}

	return { kind: selector.kind, name: '', lower: '', upper: '' };
}

/**
 * Matches the caches a complete selector set selects. `all` matches every
 * cache and returns no condition; an empty set matches none.
 */
export function cacheSelectorsCondition(
	kind: AnySQLiteColumn,
	name: AnySQLiteColumn,
	selectors: readonly ReuseViewSelector[]
): SQL | undefined {
	if (selectors.length === 0) {
		return sql`false`;
	}

	if (selectors.some((selector) => selector.kind === 'all')) {
		return undefined;
	}

	// The selectors travel as one JSON parameter, so a view of any width costs
	// the statement the same parameters. Each row of the list states the kind it
	// is, and the predicate applies the comparison that kind calls for.
	return or(
		...jsonRowLists(
			selectors.map((selector) => listedCacheSelector(selector))
		).map((listed) =>
			listed.anyRow(
				sql`(${listed.column('kind')} = 'default' and ${kind} = 'default' and ${name} is null) or (${listed.column('kind')} = 'named' and ${kind} = 'named' and ${name} = ${listed.column('name')}) or (${listed.column('kind')} = 'prefix' and ${kind} = 'named' and ${name} >= ${listed.column('lower')} and ${name} < ${listed.column('upper')}) or (${listed.column('kind')} = 'all-named' and ${kind} = 'named')`
			)
		)
	);
}

/**
 * The scope stored in a row's identity columns.
 *
 * A row refuses to parse unless its name matches its kind: a default cache has
 * no name and a named cache has one. A row with no kind at all belongs to no
 * cache, which happens only if the backfill has not reached it; reading such a
 * row as the default cache would attribute it to the wrong cache, so this
 * refuses it instead.
 */
export function cacheScopeFromRow(row: {
	readonly kind?: 'default' | 'named' | null;
	readonly name?: string | null;
}): CacheScope {
	if (row.kind === null || row.kind === undefined) {
		throw new CacheIdentityMissingError({});
	}

	const identity = cacheIdentityRowSchema.parse({
		kind: row.kind,
		...(row.name !== null && row.name !== undefined && { name: row.name })
	});

	if (identity.kind === 'default') {
		return { kind: 'default' };
	}

	return { kind: 'named', name: identity.name };
}

/**
 * The legacy key for a scope and the access the key encodes (see
 * `identityForCache`): `private/<name>` when `access` is `private`. Rows
 * carry both representations until a later migration drops the legacy
 * column.
 */
export function legacyCacheKey(
	scope: CacheScope,
	access: CacheAccessMode
): StoredCache {
	if (scope.kind === 'default') {
		return DEFAULT_CACHE;
	}

	return access === 'private' ? privateStoredCache(scope.name) : scope.name;
}
