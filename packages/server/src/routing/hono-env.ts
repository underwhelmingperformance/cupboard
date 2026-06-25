import { type TenantId } from '@cupboard/nix-store/scalars';

import { type TenantEntry } from '../control/tenant-membership.ts';

/**
 * The Hono environment for the worker app: the admission middleware resolves
 * a tenant request's slug, tenant entry and tenant-relative path, and (for
 * reads) the cache the path addresses, before any route runs.
 */
export interface WorkerHonoEnv {
	Bindings: Env;
	Variables: {
		tenant: TenantId;
		tenantEntry: TenantEntry;
		tenantRest: string;
		cache: string;
	};
}
