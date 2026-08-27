import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';

import { type TenantEntry } from '../control/tenant-membership.ts';
import { type ReadScope } from '../read/read.ts';

/**
 * The Hono environment for the worker app: the admission middleware resolves
 * a tenant request's slug, tenant entry and tenant-relative path before any
 * route runs, and the mount a read matches decides which cache in which
 * namespace it addresses. `logger` is the request-scoped logger, seeded before
 * admission and narrowed with the tenant.
 */
export interface WorkerHonoEnv {
	Bindings: Env;
	Variables: {
		logger: Logger;
		tenant: TenantId;
		tenantEntry: TenantEntry;
		// Whether `tenantEntry` was read fresh from D1 this request; a write trusts
		// its status only then, and otherwise reconfirms against D1.
		tenantEntryFresh: boolean;
		tenantRest: string;
		readScope: ReadScope;
	};
}
