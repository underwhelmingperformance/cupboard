import {
	DEFAULT_CACHE,
	type NixSha256HashString,
	type StorePathHash
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
	// The hash embedded in a `nar/<hash>.nar.zst` key is the canonical NAR hash on
	// a read but the compressed file hash on an ingest write, so it is named
	// neutrally and resolved to the stored object by the backend.
	| { readonly kind: 'nar'; readonly hash: NixSha256HashString };

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
		const hash = parseNarName(key.slice(narPrefix.length));
		return hash === undefined ? undefined : { kind: 'nar', hash };
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
			return narObjectKey(object.hash);
		}
		case 'cache-info': {
			throw new Error('nix-cache-info has no stored R2 object');
		}
	}
}

/**
 * An S3 key resolved to the cache it addresses and the object within it. A cache
 * is addressed as a leading key segment (`<cache>/<object>`); the default cache
 * has no segment.
 */
export interface CacheTarget {
	readonly cache: string;
	readonly object: NixCacheObject;
}

/**
 * Resolves an S3 object key to its cache and object, honouring the optional
 * leading `<cache>/` segment. Returns `undefined` for keys outside the grammar.
 */
export function resolveCacheTarget(key: string): CacheTarget | undefined {
	const direct = classifyKey(key);
	if (direct !== undefined) {
		return { cache: DEFAULT_CACHE, object: direct };
	}

	const slash = key.indexOf('/');
	if (slash === -1) {
		return undefined;
	}

	const object = classifyKey(key.slice(slash + 1));
	return object === undefined
		? undefined
		: { cache: key.slice(0, slash), object };
}

/**
 * Splits a `ListObjectsV2` key prefix into the cache it targets and the
 * remaining object-key prefix within that cache. A leading `<cache>/` segment
 * selects a named cache (`nar/` stays with the default cache's NAR namespace).
 */
export function resolveListPrefix(prefix: string): {
	readonly cache: string;
	readonly objectPrefix: string;
} {
	const slash = prefix.indexOf('/');
	if (slash !== -1) {
		const head = prefix.slice(0, slash);
		if (head !== '' && head !== 'nar') {
			return { cache: head, objectPrefix: prefix.slice(slash + 1) };
		}
	}

	return { cache: DEFAULT_CACHE, objectPrefix: prefix };
}

/**
 * Prefixes an in-cache object key with its cache segment for the S3 key space.
 */
export function cacheScopedKey(cache: string, objectKey: string): string {
	return cache === DEFAULT_CACHE ? objectKey : `${cache}/${objectKey}`;
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
