import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';

import {
	type TenantEntry,
	type TenantReadVerifier
} from '../control/tenant-membership.ts';
import { type ReadScope } from '../read/read.ts';

/**
 * The Hono environment for the worker app: the admission middleware resolves
 * a tenant request's slug, tenant entry and tenant-relative path before any
 * route runs. Admission resolves the cache identity and access before any
 * content route can authenticate or use Workers Cache. `logger` is the
 * request-scoped logger, seeded before admission and narrowed with the tenant.
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
		// The addressed cache's own read verifier, when it has one. Admission loads
		// it alongside the tenant row.
		cacheVerifier?: TenantReadVerifier;
		// Whether the addressed cache is absent or deleted. Content routes return
		// 404 in either case.
		isCacheDeleted: boolean;
	};
}
