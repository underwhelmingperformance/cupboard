// Tenant admission for the read and dispatch hot path. A slug is resolved through
// the layered gate in `tenant-membership.ts`: an in-memory filter and a per-tenant
// KV marker reject unknown slugs without touching the Durable Object, so varying
// the slug cannot spin up unbounded unprovisioned objects (effectively public
// signup and a denial-of-service vector); only a filter-positive with a present
// marker, or a KV fault that forces fail-open, reaches the authoritative D1 row.
export { admitTenant, type TenantEntry } from '../control/tenant-membership.ts';
