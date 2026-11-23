import {
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { type AccessKeySecret, accessKeySecretSchema } from './access-keys.ts';

export interface CacheAccessKey {
	readonly cache: CacheScope;
	readonly accessKey: AccessKeySecret;
}

export type CacheAccessKeys = readonly CacheAccessKey[];

/**
An access key for each of several caches. Each entry uses an explicit cache
scope, so the default cache never needs a sentinel name.
*/
export const cacheAccessKeysSchema = z
	.array(
		z.strictObject({
			cache: cacheScopeSchema,
			accessKey: accessKeySecretSchema
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
					message: 'Each cache can have only one access key',
					path: [index, 'cache']
				});
			}
		}
	})
	.readonly();
