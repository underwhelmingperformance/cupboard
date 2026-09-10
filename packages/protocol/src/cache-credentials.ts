import {
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	type TenantReadCredential,
	tenantReadCredentialSchema
} from './tenants.ts';

export interface CacheCredential {
	readonly cache: CacheScope;
	readonly credential: TenantReadCredential;
}

export type CacheCredentials = readonly CacheCredential[];

/**
 * Cache-specific read credentials. Each entry uses an explicit cache scope, so
 * the default cache never needs a sentinel name.
 */
export const cacheCredentialsSchema = z
	.array(
		z.strictObject({
			cache: cacheScopeSchema,
			credential: tenantReadCredentialSchema
		})
	)
	.superRefine((entries, context) => {
		for (const [index, entry] of entries.entries()) {
			if (
				entries
					.slice(0, index)
					.some((other) => isSameCacheScope(other.cache, entry.cache))
			) {
				context.addIssue({
					code: 'custom',
					message: 'Each cache can have only one read credential',
					path: [index, 'cache']
				});
			}
		}
	})
	.readonly();
