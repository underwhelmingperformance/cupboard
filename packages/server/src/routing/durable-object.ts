import { type TenantId } from '@cupboard/nix-store/scalars';

import type { CupboardServer } from '../do/server.ts';

// `CupboardServer` is defined in the separate `cupboard-tenant` script, so
// `wrangler types` cannot see the class across scripts and types this Worker's
// `CUPBOARD_DO` binding without its methods. The class type is reattached at this
// one boundary where the namespace is resolved, so callers get the Durable
// Object's RPC surface back.
interface TenantNamespaceEnv {
	readonly CUPBOARD_DO: DurableObjectNamespace;
}

function tenantNamespace(
	env: TenantNamespaceEnv
): DurableObjectNamespace<CupboardServer> {
	return env.CUPBOARD_DO as unknown as DurableObjectNamespace<CupboardServer>;
}

// The Durable Object backing one tenant: there is one per tenant, addressed by the
// tenant slug, so its signing/auth keys and metadata live in its own SQLite.
export function tenantServer(
	env: TenantNamespaceEnv,
	tenant: TenantId
): DurableObjectStub<CupboardServer> {
	const namespace = tenantNamespace(env);

	return namespace.get(namespace.idFromName(tenant));
}
