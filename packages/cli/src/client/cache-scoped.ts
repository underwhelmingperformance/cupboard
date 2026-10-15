import { type CacheName, type CacheScope } from '@cupboard/nix-store/scalars';

import { type CallOptions } from './orpc.ts';

/**
 * The two procedures the contract declares for one cache-scoped operation.
 * A command declares its dependency with this type, leaving `cacheName` out
 * of `Input`, and calls `callInCache` with a `CacheScope`. `callInCache`
 * chooses the procedure and adds the name, so no command chooses one.
 */
export interface CacheScopedClient<Input extends object, Output> {
	inDefaultCache(input: Input, options?: CallOptions): Promise<Output>;
	inNamedCache(
		input: Input & { cacheName: CacheName },
		options?: CallOptions
	): Promise<Output>;
}

/**
 * Calls the procedure that addresses `cache`, with `options` when the caller
 * passes them.
 */
export function callInCache<Input extends object, Output>(
	procedures: CacheScopedClient<Input, Output>,
	cache: CacheScope,
	input: Input,
	...options: [] | [CallOptions]
): Promise<Output> {
	if (cache.kind === 'default') {
		return procedures.inDefaultCache(input, ...options);
	}

	return procedures.inNamedCache(
		{ ...input, cacheName: cache.name },
		...options
	);
}
