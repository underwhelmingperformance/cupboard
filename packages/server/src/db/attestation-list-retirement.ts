import { type TenantId } from '@cupboard/nix-store/scalars';
import { and, eq, notExists, type SQL, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from './d1-schema.ts';

export function tenantListRevisionsAbsent(
	database: DrizzleD1Database<typeof schema>,
	tenant: TenantId
): SQL {
	const table = schema.attestationListRevision;
	const defaults = database
		.select({ one: sql`1` })
		.from(table)
		.where(and(eq(table.tenant, tenant), sql`${table.cacheKind} = 'default'`));
	const named = database
		.select({ one: sql`1` })
		.from(table)
		.where(and(eq(table.tenant, tenant), sql`${table.cacheKind} = 'named'`));
	return sql`${notExists(defaults)} and ${notExists(named)}`;
}
