import {
	selectorForCache,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';

/**
The Workers Cache tag for one tenant's materialised narinfo.
*/
export function narInfoCacheTag(
	tenant: string,
	cache: StoredCache,
	storePathHash: StorePathHash
): string {
	return `narinfo:${tenant}:${selectorForCache(cache)}:${storePathHash}`;
}
