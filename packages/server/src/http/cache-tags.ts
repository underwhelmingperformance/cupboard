import {
	type NixSha256HashString,
	selectorForCache,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';

export function narInfoCacheTag(
	tenant: string,
	cache: StoredCache,
	storePathHash: StorePathHash
): string {
	return `narinfo:${tenant}:${selectorForCache(cache)}:${storePathHash}`;
}

/**
 * The tag shared by every cached NAR response for one tenant and NAR hash. A
 * NAR object is shared by content hash across the tenant's caches, while its
 * incarnations use different URLs. This tag lets one purge invalidate every
 * cached response authorised by the tenant's reference edges.
 */
export function narCacheTag(
	tenant: string,
	narHash: NixSha256HashString
): string {
	return `nar:${tenant}:${narHash}`;
}
