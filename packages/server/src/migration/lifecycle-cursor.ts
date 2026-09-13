import { type CacheScope } from '@cupboard/nix-store/scalars';
import { type SQL, sql } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';

export function lifecycleKey(scope: CacheScope): string {
	return scope.kind === 'default' ? 'default' : `named:${scope.name}`;
}

/**
Uses the lifecycle identity index for a stable traversal of cache scopes.
*/
export function afterLifecycleKey(key: string): SQL | undefined {
	if (key === '') {
		return undefined;
	}
	if (key === 'default') {
		return sql`${d1Schema.cacheLifecycle.cacheKind} = 'named'`;
	}
	return sql`${d1Schema.cacheLifecycle.cacheKind} = 'named' and ${d1Schema.cacheLifecycle.cacheName} > ${key.slice('named:'.length)}`;
}
