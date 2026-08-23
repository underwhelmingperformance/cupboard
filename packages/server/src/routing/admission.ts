// Unknown slugs must not create unbounded Durable Objects. The in-memory filter
// and per-tenant KV marker reject them before the authoritative D1 lookup; a KV
// fault fails open so an existing tenant remains reachable.
export { admitTenant, type TenantEntry } from '../control/tenant-membership.ts';
