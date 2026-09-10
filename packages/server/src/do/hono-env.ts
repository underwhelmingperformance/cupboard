import type { Logger } from '@cupboard/logger';
import type { CacheScope } from '@cupboard/nix-store/scalars';

import type { AccessClaims } from '../auth/auth.ts';

import type { RuntimeEnv } from './context.ts';

/**
 * Middleware installs `logger` before any route runs and installs `claims` on
 * authenticated routes. `cache` is the cache addressed by the request: the
 * default cache unless a `/cache/:cacheName/` prefix selects another one.
 *
 * The path names the cache but not its access. A route that needs the access
 * resolves the cache through the catalogue.
 */
export interface TenantHonoEnv {
	Bindings: RuntimeEnv;
	Variables: {
		logger: Logger;
		claims: AccessClaims;
		cache: CacheScope;
	};
}
