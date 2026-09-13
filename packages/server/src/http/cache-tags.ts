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

/**
 * The tag a NAR response carried before the tag named the cache. Responses
 * stored under it live for the NAR TTL, one year, so a purge queues this tag
 * beside the per-cache one until that long after the first deploy of the
 * per-cache tag; then it can go.
 */
export function legacyNarCacheTag(
	tenant: string,
	narHash: NixSha256HashString
): string {
	return `nar:${tenant}:${narHash}`;
}
