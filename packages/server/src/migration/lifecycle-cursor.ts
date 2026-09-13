import { type CacheScope } from '@cupboard/nix-store/scalars';
import { type SQL, sql } from 'drizzle-orm';

import * as d1Schema from './cache-access-schema.ts';

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
		return sql`${d1Schema.cacheLifecycles.cacheKind} = 'named'`;
	}
	return sql`${d1Schema.cacheLifecycles.cacheKind} = 'named' and ${d1Schema.cacheLifecycles.cacheName} > ${key.slice('named:'.length)}`;
}
