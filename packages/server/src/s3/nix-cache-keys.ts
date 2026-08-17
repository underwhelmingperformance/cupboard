import { fromNixBase32 } from '@cupboard/nix-store/hash';
import {
	DEFAULT_CACHE,
	nixSha256HashSchema,
	type NixSha256HashString,
	type StoredCache,
	storedCacheSchema,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';

import {
	narInfoObjectKey,
	narObjectKey,
	parseNarInfoName
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
const narSuffix = '.nar.zst';
const sha256Prefix = 'sha256:';
const narBase32Pattern = /^[0-9a-df-np-sv-z]{52}$/;

// The base32 pattern admits 52-character strings whose top bits overflow a
// 256-bit digest, so a regex match is not a valid hash; decoding settles it.
function isCanonicalBase32(base32: string): boolean {
	try {
		fromNixBase32(base32);
		return true;
	} catch {
		return false;
	}
}

// Parses the hash from a nar object name. Cupboard's own narinfo URLs name the
// object `sha256:<base32>.nar.zst`, but a standard Nix/S3 client (nixbuild)
// writes the bare base32 form `<base32>.nar.zst`; both resolve to the same hash.
function parseNarObjectName(name: string): NixSha256HashString | undefined {
	if (!name.endsWith(narSuffix)) {
		return undefined;
	}

	const hash = name.slice(0, -narSuffix.length);
	const base32 = hash.startsWith(sha256Prefix)
		? hash.slice(sha256Prefix.length)
		: hash;

	if (!narBase32Pattern.test(base32) || !isCanonicalBase32(base32)) {
		return undefined;
	}

	return nixSha256HashSchema.parse(`${sha256Prefix}${base32}`);
}

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
		const hash = parseNarObjectName(key.slice(narPrefix.length));
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
	tenant: TenantId,
	cache: StoredCache
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
	readonly cache: StoredCache;
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
	const cache = storedCacheSchema.safeParse(key.slice(0, slash));
	return object === undefined || !cache.success
		? undefined
		: { cache: cache.data, object };
}

/**
 * Splits a `ListObjectsV2` key prefix into the cache it targets and the
 * remaining object-key prefix within that cache. A leading `<cache>/` segment
 * selects a named cache (`nar/` stays with the default cache's NAR namespace).
 */
export function resolveListPrefix(prefix: string): {
	readonly cache: StoredCache;
	readonly objectPrefix: string;
} {
	const slash = prefix.indexOf('/');
	if (slash !== -1) {
		const head = prefix.slice(0, slash);
		if (head !== '' && head !== 'nar') {
			const cache = storedCacheSchema.safeParse(head);
			if (cache.success) {
				return { cache: cache.data, objectPrefix: prefix.slice(slash + 1) };
			}
		}
	}

	return { cache: DEFAULT_CACHE, objectPrefix: prefix };
}

/**
 * Prefixes an in-cache object key with its cache segment for the S3 key space.
 */
export function cacheScopedKey(cache: StoredCache, objectKey: string): string {
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
