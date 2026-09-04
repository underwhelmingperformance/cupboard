import { type CacheName, type CacheScope } from '@cupboard/nix-store/scalars';
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
