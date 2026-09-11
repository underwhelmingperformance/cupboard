import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

/**
 * The surrogate key of a `cache_identity` row. Rows in other tables refer to a
 * cache by this id rather than by its stored name.
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
 * The legacy key for a scope and its access.
 *
 * A row carries both representations until the contraction drops the legacy
 * column. Deriving the key here keeps it from disagreeing with the identity
 * written beside it.
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
