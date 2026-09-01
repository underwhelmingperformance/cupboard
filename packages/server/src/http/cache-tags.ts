import {
	type CacheScope,
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';

export function narInfoCacheTag(
	tenant: string,
	cache: CacheScope,
	storePathHash: StorePathHash
): string {
	const cacheIdentity =
		cache.kind === 'default' ? 'default' : `named:${cache.name}`;

	return `narinfo:${tenant}:${cacheIdentity}:${storePathHash}`;
}

/**
 * The tag for one cache's public response for a NAR hash. The object is shared
 * across caches, but each route requires an exact reference from the cache it
 * addresses. Retiring that cache's final reference can therefore purge its
 * response without invalidating another cache's route.
 */
export function narCacheTag(
	tenant: string,
	cache: CacheScope,
	narHash: NixSha256HashString
): string {
	const cacheIdentity =
		cache.kind === 'default' ? 'default' : `named:${cache.name}`;

	return `nar:${tenant}:${cacheIdentity}:${narHash}`;
}
