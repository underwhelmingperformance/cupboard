import {
	DEFAULT_CACHE,
	type NamedCacheSelector,
	namedSelectorForCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';

/**
 * The two procedures the contract declares for one cache-scoped operation.
 * A command declares its dependency with this type, leaving `cacheName` out
 * of `Input`, and calls `callInCache` with a `StoredCache`. `callInCache`
 * chooses the procedure and adds the selector, so no command chooses one.
 */
export interface CacheScopedClient<Input extends object, Output> {
	inDefaultCache(input: Input): Promise<Output>;
	inNamedCache(
		input: Input & { cacheName: NamedCacheSelector }
	): Promise<Output>;
}

/**
 * Calls the procedure that addresses `cache`.
 */
export function callInCache<Input extends object, Output>(
	procedures: CacheScopedClient<Input, Output>,
	cache: StoredCache,
	input: Input
): Promise<Output> {
	if (cache === DEFAULT_CACHE) {
		return procedures.inDefaultCache(input);
	}

	return procedures.inNamedCache({
		...input,
		cacheName: namedSelectorForCache(cache)
	});
}
