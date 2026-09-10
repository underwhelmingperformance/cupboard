import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { type ReuseViewSelector } from '@cupboard/protocol/reuse-views';
import { and, eq, gte, lt, or, type SQL, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

export const cacheIdSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('CacheId');
export type CacheId = z.infer<typeof cacheIdSchema>;

const cacheIdentityRowSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('default'), name: z.null() }),
	z.strictObject({ kind: z.literal('named'), name: cacheNameSchema })
]);

export interface ResolvedCache {
	readonly id: CacheId;
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
}

type CacheIdentityColumns =
	| { readonly cacheKind: 'default'; readonly cacheName: SQL<null> }
	| { readonly cacheKind: 'named'; readonly cacheName: CacheName };

export function cacheIdentityColumns(scope: CacheScope): CacheIdentityColumns {
	if (scope.kind === 'default') {
		return { cacheKind: 'default', cacheName: sql<null>`null` };
	}

	return { cacheKind: 'named', cacheName: scope.name };
}

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
 * Builds the cache-identity predicate for one reuse-view selector.
 */
export function cacheSelectorCondition(
	kind: AnySQLiteColumn,
	name: AnySQLiteColumn,
	selector: ReuseViewSelector
): SQL | undefined {
	switch (selector.kind) {
		case 'default': {
			return sql`${kind} = 'default' and ${name} is null`;
		}
		case 'named': {
			return sql`${kind} = 'named' and ${name} = ${selector.name}`;
		}
		case 'prefix': {
			return and(
				eq(kind, 'named'),
				gte(name, selector.prefix),
				lt(name, prefixUpperBound(selector.prefix))
			);
		}
		case 'all-named': {
			return eq(kind, 'named');
		}
		case 'all': {
			return undefined;
		}
	}
}

/**
 * Builds the cache-identity predicate for a complete reuse-view selector set.
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

	return or(
		...selectors.map((selector) => cacheSelectorCondition(kind, name, selector))
	);
}

export function cacheScopeFromRow(row: unknown): CacheScope {
	const identity = cacheIdentityRowSchema.parse(row);

	if (identity.kind === 'default') {
		return { kind: 'default' };
	}

	return { kind: 'named', name: identity.name };
}
