import { type CacheScope, type TenantId } from '@cupboard/nix-store/scalars';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import * as d1Schema from '../db/d1-schema.ts';
import { type ServerContext } from '../do/context.ts';
import { jsonValueLists } from '../do/json-list.ts';

/**
Reads the requested scopes through the lifecycle identity index.
*/
export async function readCacheLifecycles(
	context: ServerContext,
	tenant: TenantId,
	scopes: readonly CacheScope[]
): Promise<(typeof d1Schema.cacheLifecycle.$inferSelect)[]> {
	const rows: (typeof d1Schema.cacheLifecycle.$inferSelect)[] = [];
	if (scopes.some((scope) => scope.kind === 'default')) {
		const row = await context.d1
			.select()
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.cacheKind, 'default'),
					isNull(d1Schema.cacheLifecycle.cacheName)
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
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
					inArray(d1Schema.cacheLifecycle.cacheName, listed)
				)
			)
			.all();
		rows.push(...named);
	}
	return rows;
}
