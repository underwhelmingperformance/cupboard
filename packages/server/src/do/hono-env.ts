import type { Logger } from '@cupboard/logger';
import type { StoredCache } from '@cupboard/nix-store/scalars';

import type { AccessClaims } from '../auth/auth.ts';

import type { RuntimeEnv } from './context.ts';

/**
 * The Hono environment for the tenant Durable Object's app: `logger` is the
 * request-scoped logger seeded before any route runs, `claims` is set by the
 * auth middleware on authenticated routes, and `cache` is always the cache the
 * request addresses (the default cache unless a `/cache/:cacheName/` prefix
 * selects another).
 */
export interface TenantHonoEnv {
	Bindings: RuntimeEnv;
	Variables: {
		logger: Logger;
		claims?: AccessClaims;
		cache: StoredCache;
	};
}
