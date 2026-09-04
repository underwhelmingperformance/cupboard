import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';

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
 * The scope stored in a row's identity columns, or undefined when the row has
 * no `kind` because the backfill has not reached it.
 *
 * A row with a `kind` refuses to parse unless its name matches: a default
 * cache has no name and a named cache has one.
 *
 * A caller reading a database row converts each SQL null to undefined, so no
 * null reaches this layer.
 */
export function cacheScopeFromRow(row: {
	readonly kind?: 'default' | 'named';
	readonly name?: string;
}): CacheScope | undefined {
	if (row.kind === undefined) {
		return undefined;
	}

	const identity = cacheIdentityRowSchema.parse(row);

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
): string {
	if (scope.kind === 'default') {
		return '';
	}

	return access === 'private' ? `private/${scope.name}` : scope.name;
}
