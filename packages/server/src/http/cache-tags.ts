import {
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
