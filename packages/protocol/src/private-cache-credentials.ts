import { type CacheName, cacheNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	type ParsedTenantReadCredential,
	tenantReadCredentialSchema
} from './tenants.ts';

/**
 * Read credentials for private caches, keyed by local cache name. A cache
 * without an entry uses the tenant credential.
 */
export type PrivateCacheCredentials = ReadonlyMap<
	CacheName,
	ParsedTenantReadCredential
>;

/**
 * A JSON object that maps each private cache's local name to its read
 * credential. The CLI and composite action read the same document, so one
 * workflow secret can provide both inputs.
 *
 * The parsed value is a `Map`, so `constructor` and other legal cache names are
 * ordinary keys rather than inherited object properties.
 */
export const privateCacheCredentialsSchema = z
	.record(cacheNameSchema, tenantReadCredentialSchema)
	.transform((document): PrivateCacheCredentials => {
		const credentials = new Map<CacheName, ParsedTenantReadCredential>();

		for (const [name, credential] of Object.entries(document)) {
			credentials.set(cacheNameSchema.parse(name), credential);
		}

		return credentials;
	});
