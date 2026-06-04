import type { CupboardServer } from './do.ts';
import { defaultTenant } from './tenant-routing.ts';

// The Durable Object backing one tenant: there is one per tenant, addressed by the
// tenant slug, so its signing/auth keys and metadata live in its own SQLite.
export function tenantServer(
	env: Env,
	tenant: string
): DurableObjectStub<CupboardServer> {
	return env.CUPBOARD_DO.get(env.CUPBOARD_DO.idFromName(tenant));
}

// The default tenant's Durable Object, for deployment-level callers that are not
// routing a tenant request — the cron's maintenance RPCs.
export function cupboardServer(env: Env): DurableObjectStub<CupboardServer> {
	return tenantServer(env, defaultTenant);
}
