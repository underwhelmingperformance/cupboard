import type { CupboardServer } from '../do.ts';

import { defaultTenant } from './tenant-routing.ts';

// `CupboardServer` is defined in the separate `cupboard-tenant` script, so
// `wrangler types` cannot see the class across scripts and types this Worker's
// `CUPBOARD_DO` binding without its methods. The class type is reattached at this
// one boundary where the namespace is resolved, so callers get the Durable
// Object's RPC surface back.
function tenantNamespace(env: Env): DurableObjectNamespace<CupboardServer> {
	return env.CUPBOARD_DO as unknown as DurableObjectNamespace<CupboardServer>;
}

// The Durable Object backing one tenant: there is one per tenant, addressed by the
// tenant slug, so its signing/auth keys and metadata live in its own SQLite.
export function tenantServer(
	env: Env,
	tenant: string
): DurableObjectStub<CupboardServer> {
	const namespace = tenantNamespace(env);

	return namespace.get(namespace.idFromName(tenant));
}

// The default tenant's Durable Object, for deployment-level callers that are not
// routing a tenant request — the cron's maintenance RPCs.
export function cupboardServer(env: Env): DurableObjectStub<CupboardServer> {
	return tenantServer(env, defaultTenant);
}
