import { type TenantId } from '@cupboard/nix-store/scalars';
import { and, eq, gt, notExists, type SQL, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as schema from './d1-schema.ts';

export function tenantNamespaceCleanupAllowed(
	database: DrizzleD1Database<typeof schema>,
	tenant: TenantId
): SQL {
	const guard = schema.tenantNamespaceCleanupGuard;
	const activeWindow = and(
		eq(guard.tenant, tenant),
		gt(guard.notBefore, sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
	);
	const pending = database
		.select({ one: sql`1` })
		.from(guard)
		.where(activeWindow);
	return notExists(pending);
}
