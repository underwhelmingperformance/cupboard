import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type SQL, sql } from 'drizzle-orm';

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
 * The legacy key for a scope and the access the key encodes (see
 * `identityForCache`): `private/<name>` when `access` is `private`. Rows
 * carry both representations until a later migration drops the legacy
 * column.
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
