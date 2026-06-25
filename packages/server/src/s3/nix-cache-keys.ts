import type {
	NixSha256HashString,
	StorePathHash
} from '@cupboard/nix-store/scalars';

import {
	narInfoObjectKey,
	narObjectKey,
	parseNarInfoName,
	parseNarName
} from '../http/http.ts';

/**
 * The three kinds of object an S3 key in a Nix cache bucket can address. Any
 * other key is outside the cache contract.
 */
export type NixCacheObject =
	| { readonly kind: 'cache-info' }
	| { readonly kind: 'narinfo'; readonly storePathHash: StorePathHash }
	| { readonly kind: 'nar'; readonly narHash: NixSha256HashString };

const narPrefix = 'nar/';

/**
 * Classifies an S3 object key against the Nix cache key grammar
 * (`nix-cache-info`, `<storePathHash>.narinfo`, `nar/<narHash>.nar.zst`).
 * Returns `undefined` for any key outside the contract.
 */
export function classifyKey(key: string): NixCacheObject | undefined {
	if (key === 'nix-cache-info') {
		return { kind: 'cache-info' };
	}

	if (key.startsWith(narPrefix)) {
		const narHash = parseNarName(key.slice(narPrefix.length));
		return narHash === undefined ? undefined : { kind: 'nar', narHash };
	}

	if (!key.includes('/')) {
		const storePathHash = parseNarInfoName(key);
		if (storePathHash !== undefined) {
			return { kind: 'narinfo', storePathHash };
		}
	}

	return undefined;
}

/**
 * The internal R2 key a stored cache object lives at. A narinfo is
 * tenant-and-cache namespaced; a NAR is content-addressed and shared, so it
 * ignores tenant and cache. `cache-info` has no stored object (it is rendered).
 */
export function internalKeyFor(
	object: NixCacheObject,
	tenant: string,
	cache: string
): string {
	switch (object.kind) {
		case 'narinfo': {
			return narInfoObjectKey(tenant, object.storePathHash, cache);
		}
		case 'nar': {
			return narObjectKey(object.narHash);
		}
		case 'cache-info': {
			throw new Error('nix-cache-info has no stored R2 object');
		}
	}
}

/**
 * The S3 key a narinfo is served under: `<storePathHash>.narinfo`.
 */
export function narinfoS3Key(storePathHash: StorePathHash): string {
	return `${storePathHash}.narinfo`;
}

/**
 * The S3 key a NAR is served under: `nar/<narHash>.nar.zst`.
 */
export function narS3Key(narHash: NixSha256HashString): string {
	return narObjectKey(narHash);
}
