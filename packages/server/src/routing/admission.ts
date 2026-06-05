import {
	type ManifestEntry,
	readTenantManifest
} from '../control/tenant-manifest.ts';

// Resolves a tenant slug against the published admission manifest, reading only KV
// (never D1 or a Durable Object) so it runs on the read and dispatch hot path.
// Returns the manifest entry for a provisioned slug, or undefined for one absent
// from the manifest, so the caller can reject an unprovisioned slug before
// instantiating its Durable Object: varying the slug otherwise spins up unbounded
// unprovisioned objects, effectively public signup and a denial-of-service vector.
export async function admitTenant(
	kv: KVNamespace,
	tenant: string
): Promise<ManifestEntry | undefined> {
	const manifest = await readTenantManifest(kv);

	return manifest?.tenants[tenant];
}
