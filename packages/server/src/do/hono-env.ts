import type { Logger } from '@cupboard/logger';
import type { CacheAccessMode, StoredCache } from '@cupboard/nix-store/scalars';

import type { AccessClaims } from '../auth/auth.ts';

import type { RuntimeEnv } from './context.ts';

/**
 * Middleware installs `logger` before any route runs and installs `claims` on
 * authenticated routes.
 *
 * `cache` is the cache the request addresses: the default cache unless a
 * `/cache/:cacheName/` or `/private-cache/:cacheName/` prefix selects another
 * one. `cacheAccess` is that cache's access. The middleware that sets `cache`
 * sets it; a route reads it from the context, not from the stored name,
 * because the stored name stops carrying the access once reads move to the
 * identity table.
 */
export interface TenantHonoEnv {
	Bindings: RuntimeEnv;
	Variables: {
		logger: Logger;
		claims: AccessClaims;
		cache: StoredCache;
		cacheAccess: CacheAccessMode;
	};
}
