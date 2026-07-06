import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';

import { type TenantEntry } from '../control/tenant-membership.ts';

/**
 * The Hono environment for the worker app: the admission middleware resolves
 * a tenant request's slug, tenant entry and tenant-relative path, and (for
 * reads) the cache the path addresses, before any route runs. `logger` is the
 * request-scoped logger, seeded before admission and narrowed with the tenant.
 */
export interface WorkerHonoEnv {
	Bindings: Env;
	Variables: {
		logger: Logger;
		tenant: TenantId;
		tenantEntry: TenantEntry;
		tenantRest: string;
		cache: string;
	};
}
