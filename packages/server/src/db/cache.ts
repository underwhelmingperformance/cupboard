import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

type CacheIdentityColumns =
	| { readonly cacheKind: 'default'; readonly cacheName: SQL<null> }
	| { readonly cacheKind: 'named'; readonly cacheName: CacheName };

/**
 * The `cache_kind` and `cache_name` values for a scope.
 *
 * A default cache stores a SQL null for the name. The mirroring trigger fills
 * these columns for a row this build does not write natively, so a native write
 * sets them itself rather than leaving them for the trigger.
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

/**
 * The scope stored in a row's identity columns, or undefined when those
 * columns are still null because the backfill has not reached the row.
 */
export function storedCacheScope(
	kind: 'default' | 'named' | null,
	name: string | null
): CacheScope | undefined {
	if (kind === null) {
		return undefined;
	}

	if (kind === 'default') {
		return { kind: 'default' };
	}

	return { kind: 'named', name: cacheNameSchema.parse(name) };
}

/**
 * The legacy key for a scope and its access.
 *
 * A row carries both spellings until the contraction drops the legacy column.
 * Deriving the key here keeps it from disagreeing with the identity written
 * beside it.
 */
export function legacyCacheKey(
	scope: CacheScope,
	access: CacheAccessMode
): string {
	if (scope.kind === 'default') {
		return '';
	}

	return access === 'private' ? `private/${scope.name}` : scope.name;
}
