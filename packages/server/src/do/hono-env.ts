import type { Logger } from '@cupboard/logger';
import type { CacheScope } from '@cupboard/nix-store/scalars';

import type { Principal } from '../auth/principal.ts';

import type { RuntimeEnv } from './context.ts';

/**
Middleware installs `logger` before any route runs and installs `principal` on
authenticated routes.

The path names the cache but not its access. A route that needs the access
resolves the cache through the catalogue.
*/
export interface TenantHonoEnv {
	Bindings: RuntimeEnv;
	Variables: {
		logger: Logger;
		principal: Principal;
		cache: CacheScope;
	};
}
