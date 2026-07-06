import type { Logger } from '@cupboard/logger';

import type { AccessClaims } from '../auth/auth.ts';

import type { RuntimeEnv } from './context.ts';

/**
 * The Hono environment for the tenant Durable Object's app: `logger` is the
 * request-scoped logger seeded before any route runs, `claims` is set by the
 * auth middleware on authenticated routes, and `cache` always names the cache a
 * request addresses (the default cache unless a `/cache/:cacheName/` prefix
 * overrides it).
 */
export interface TenantHonoEnv {
	Bindings: RuntimeEnv;
	Variables: {
		logger: Logger;
		claims?: AccessClaims;
		cache: string;
	};
}
