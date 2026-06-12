import { cachesContract } from './caches.ts';

/**
 * The tenant admin API: every JSON procedure a tenant deployment answers,
 * declared once. Paths are relative to the tenant base (`/t/<slug>` behind
 * the worker; the Durable Object serves them at its root). The server
 * implements this contract and the CLI derives its client from it, so the
 * two cannot drift.
 */
export const tenantContract = {
	caches: cachesContract
};
