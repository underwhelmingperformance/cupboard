import { type CacheName, type CacheScope } from '@cupboard/nix-store/scalars';

/**
 * The two procedures the contract declares for one cache-scoped operation.
 * A command declares its dependency with this type, leaving `cacheName` out
 * of `Input`, and calls `callInCache` with a `CacheScope`. `callInCache`
 * chooses the procedure and adds the name, so no command chooses one.
 */
export interface CacheScopedClient<Input extends object, Output> {
	inDefaultCache(input: Input): Promise<Output>;
	inNamedCache(input: Input & { cacheName: CacheName }): Promise<Output>;
}

/**
 * Calls the procedure that addresses `cache`.
 */
export function callInCache<Input extends object, Output>(
	procedures: CacheScopedClient<Input, Output>,
	cache: CacheScope,
	input: Input
): Promise<Output> {
	if (cache.kind === 'default') {
		return procedures.inDefaultCache(input);
	}

	return procedures.inNamedCache({ ...input, cacheName: cache.name });
}
