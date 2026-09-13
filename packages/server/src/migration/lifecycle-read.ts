import {
	cacheAccessModeSchema,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { cacheScopeFromRow } from '../db/cache.ts';
import { type ServerContext } from '../do/context.ts';
import { jsonValueLists } from '../do/json-list.ts';

import * as d1Schema from './cache-access-schema.ts';

/**
Reads the requested scopes through the lifecycle identity index.
*/
export async function readCacheLifecycles(
	context: ServerContext,
	tenant: TenantId,
	scopes: readonly CacheScope[]
): Promise<
	(typeof d1Schema.cacheLifecycles.$inferSelect & {
		cacheKind: CacheScope['kind'];
		access: 'public' | 'private';
	})[]
> {
	const rows: (typeof d1Schema.cacheLifecycles.$inferSelect)[] = [];
	if (scopes.some((scope) => scope.kind === 'default')) {
		const row = await context.d1
			.select()
			.from(d1Schema.cacheLifecycles)
			.where(
				and(
					eq(d1Schema.cacheLifecycles.tenant, tenant),
					eq(d1Schema.cacheLifecycles.cacheKind, 'default'),
					isNull(d1Schema.cacheLifecycles.cacheName)
				)
			)
			.get();
		if (row !== undefined) {
			rows.push(row);
		}
	}
	const names = scopes.flatMap((scope) =>
		scope.kind === 'named' ? [scope.name] : []
	);
	for (const listed of jsonValueLists(names)) {
		const named = await context.d1
			.select()
			.from(d1Schema.cacheLifecycles)
			.where(
				and(
					eq(d1Schema.cacheLifecycles.tenant, tenant),
					eq(d1Schema.cacheLifecycles.cacheKind, 'named'),
					inArray(d1Schema.cacheLifecycles.cacheName, listed)
				)
			)
			.all();
		rows.push(...named);
	}
	return rows.map((row) => ({
		...row,
		cacheKind: cacheScopeFromRow({
			kind: row.cacheKind ?? undefined,
			name: row.cacheName
		}).kind,
		access: cacheAccessModeSchema.parse(row.access)
	}));
}
