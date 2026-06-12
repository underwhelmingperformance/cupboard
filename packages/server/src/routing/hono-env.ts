import { type ManifestEntry } from '../control/tenant-manifest.ts';

/**
 * The Hono environment for the worker app: the admission middleware resolves
 * a tenant request's slug, manifest entry and tenant-relative path, and (for
 * reads) the cache the path addresses, before any route runs.
 */
export interface WorkerHonoEnv {
	Bindings: Env;
	Variables: {
		tenant: string;
		tenantEntry: ManifestEntry;
		tenantRest: string;
		cache: string;
	};
}
