import {
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { z } from 'zod';

// A read password is 32 random bytes, rendered as 43 base64url characters.
const readCredentialSchema = z.strictObject({
	user: readUserInputSchema,
	password: z
		.string()
		.length(43)
		.regex(/^[A-Za-z0-9_-]+$/u)
});

export interface CacheCredential {
	readonly cache: CacheScope;
	readonly credential: z.output<typeof readCredentialSchema>;
}

export type CacheCredentials = readonly CacheCredential[];

/**
Cache-specific read credentials. Each entry uses an explicit cache scope, so
the default cache never needs a sentinel name.
*/
export const cacheCredentialsSchema = z
	.array(
		z.strictObject({
			cache: cacheScopeSchema,
			credential: readCredentialSchema
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
