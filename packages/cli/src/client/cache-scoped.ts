import { type CacheName, type CacheScope } from '@cupboard/nix-store/scalars';

/**
 * The two path variants the contract declares for one cache-scoped operation.
 * The derived client exposes them as sibling procedures; `callInCache` picks
 * between them so a caller states the cache once and never builds a path.
 */
export interface CacheScopedClient<Input, Output> {
	inDefaultCache(input: Input): Promise<Output>;
	inNamedCache(input: Input & { cacheName: CacheName }): Promise<Output>;
}

/**
 * Calls the path variant that addresses `cache`.
 */
export function callInCache<Input, Output>(
	procedures: CacheScopedClient<Input, Output>,
	cache: CacheScope,
	input: Input
): Promise<Output> {
	if (cache.kind === 'default') {
		return procedures.inDefaultCache(input);
	}

	return procedures.inNamedCache({ ...input, cacheName: cache.name });
}
