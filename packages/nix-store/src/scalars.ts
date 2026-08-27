import { z } from 'zod';

export const nixSha256HashPattern = /^sha256:[0-9a-df-np-sv-z]{52}$/;
export const sha256HexDigestPattern = /^[0-9a-f]{64}$/;
export const storePathHashPattern = /^[0-9a-df-np-sv-z]{32}$/;
export const storePathNamePattern = /^[0-9A-Za-z+._?=-]+$/;
export const storePathBasenamePattern =
	/^[0-9a-df-np-sv-z]{32}-[0-9A-Za-z+._?=-]+$/;
// A store directory is an absolute path of one or more segments, over the same
// charset a store-path name uses. Each cache publishes the directory it serves;
// the pattern does not decide it. A `.` or `..` segment is refused so that one
// directory has one spelling, and so a comparison against the directory a cache
// serves cannot be evaded.
export const storeDirectoryPattern =
	/^(?:\/(?!\.{1,2}(?:\/|$))[0-9A-Za-z+._?=-]+)+$/;
// A store path is a store directory, a separator, then the basename. Like Nix,
// the pattern caps the name at 211 characters on its own; the store directory
// in front of it does not count towards that cap.
export const storePathPattern =
	/^(?:\/(?!\.{1,2}(?:\/|$))[0-9A-Za-z+._?=-]+)+\/[0-9a-df-np-sv-z]{32}-[0-9A-Za-z+._?=-]{1,211}$/;

export const rootNameMaxLength = 256;
export const predicateTypeMaxLength = 512;
export const narInfoLineMaxLength = 1024;
// Nix caps a store-path name at 211 characters, so a basename (32-char hash, a
// dash, the name) is at most 244 and at least 34. The patterns already constrain
// the charset; these bound the length so a single upload body cannot carry a
// multi-megabyte name. `storePathMaxLength` bounds the whole path and
// `storeDirectoryMaxLength` is what that leaves in front of the shortest
// basename, so a path this schema accepts always has a directory the store
// directory schema accepts too.
export const storePathNameMaxLength = 211;
export const storePathBasenameMaxLength = 33 + storePathNameMaxLength;
export const storePathBasenameMinLength = 34;
export const storePathMaxLength = 512;
export const storeDirectoryMaxLength =
	storePathMaxLength - 1 - storePathBasenameMinLength;
// One path's references are its direct closure neighbours; a few thousand is
// already extreme, so the cap rejects only an abusive body.
export const referencesMaxLength = 10_000;
export const rootTtlMinSeconds = 1;
export const rootTtlMaxSeconds = 315_360_000;

export function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;

		if (code === 0x7f || code < 0x20) {
			return true;
		}
	}

	return false;
}

export const nixSha256HashSchema = z
	.string()
	.regex(nixSha256HashPattern)
	.brand('NixSha256Hash');
export type NixSha256HashString = z.infer<typeof nixSha256HashSchema>;

export const sha256HexDigestSchema = z
	.string()
	.regex(sha256HexDigestPattern)
	.brand('Sha256HexDigest');
export type Sha256HexDigest = z.infer<typeof sha256HexDigestSchema>;

export const storePathHashSchema = z
	.string()
	.regex(storePathHashPattern)
	.brand('StorePathHash');
export type StorePathHash = z.infer<typeof storePathHashSchema>;

export const storeDirectorySchema = z
	.string()
	.max(storeDirectoryMaxLength)
	.regex(storeDirectoryPattern)
	.brand('StoreDirectory');
export type StoreDirectory = z.infer<typeof storeDirectorySchema>;

export const storePathSchema = z
	.string()
	.max(storePathMaxLength)
	.regex(storePathPattern)
	.brand('StorePath');
export type StorePathString = z.infer<typeof storePathSchema>;

export const storePathBasenameSchema = z
	.string()
	.max(storePathBasenameMaxLength)
	.regex(storePathBasenamePattern)
	.brand('StorePathBasename');
export type StorePathBasename = z.infer<typeof storePathBasenameSchema>;

export const rootNameSchema = z
	.string()
	.min(1)
	.max(rootNameMaxLength)
	.refine((value) => !hasControlCharacter(value))
	.brand('RootName');
export type RootName = z.infer<typeof rootNameSchema>;

export const ttlSecondsSchema = z
	.number()
	.int()
	.min(rootTtlMinSeconds)
	.max(rootTtlMaxSeconds)
	.brand('TtlSeconds');
export type TtlSeconds = z.infer<typeof ttlSecondsSchema>;

// A retention-grace window in seconds: it shares the root TTL's upper bound but
// admits zero, since a grace policy may configure a zero grace, whereas a root
// TTL cannot be zero. Its own brand keeps a grace window from crossing with a
// root TTL.
export const graceSecondsSchema = z
	.number()
	.int()
	.min(0)
	.max(rootTtlMaxSeconds)
	.brand('GraceSeconds');
export type GraceSeconds = z.infer<typeof graceSecondsSchema>;

export const predicateTypeSchema = z
	.string()
	.min(1)
	.max(predicateTypeMaxLength)
	.refine((value) => !hasControlCharacter(value))
	.brand('PredicateType');
export type PredicateType = z.infer<typeof predicateTypeSchema>;

// The bootstrap signing key keeps the fixed id `active`; rotated keys are
// issued with a random UUID.
export const signingKeyIdSchema = z
	.union([z.literal('active'), z.uuid()])
	.brand('SigningKeyId');
export type SigningKeyId = z.infer<typeof signingKeyIdSchema>;

export const signingKeyGenerationSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER)
	.brand('SigningKeyGeneration');
export type SigningKeyGeneration = z.infer<typeof signingKeyGenerationSchema>;

// A JWKS key id (`kid`) labelling a token-signing key: the auth plane's per-tenant
// keys and the control plane's keys alike, since both are verified through the same
// `AuthPublicKey`/`verifyAccessJwt` path. Rotated keys carry a random UUID; a
// pre-rotation auth row backfills one, so the brand does not narrow the format.
export const authKeyIdSchema = z.string().brand('AuthKeyId');
export type AuthKeyId = z.infer<typeof authKeyIdSchema>;

// A Nix signing key's name: the label a rendered public key or a narinfo
// signature is prefixed with, and the name a client lists in
// `trusted-public-keys`. The colon separates the name from the base64 half, so
// a name that contained a colon could not be recovered from a rendered key.
export const nixKeyNameSchema = z
	.string()
	.min(1)
	.refine((value) => !value.includes(':'))
	.brand('NixKeyName');
export type NixKeyName = z.infer<typeof nixKeyNameSchema>;

// The Nix narinfo fingerprint a signature is computed over (`narFingerprint`
// renders it). Its own brand keeps it from being handed to a signer as an
// interchangeable plain string.
export const nixFingerprintSchema = z.string().brand('NixFingerprint');
export type NixFingerprint = z.infer<typeof nixFingerprintSchema>;

export const positiveIntSchema = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);

export const cacheNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// The default (unnamed) cache served at the bare root. Named caches carry a
// non-empty name matching `cacheNamePattern`; the empty string is reserved for
// the default and is deliberately not a valid cache name.
export const DEFAULT_CACHE = '';

export const cacheNameSchema = z
	.string()
	.regex(cacheNamePattern)
	.brand('CacheName');
export type CacheName = z.infer<typeof cacheNameSchema>;

// The characters and first-character restriction cacheNamePattern imposes on
// a full cache name, without its length bound: a prefix may be shorter than
// any real name, down to empty (which matches every cache), but every
// character it does supply must belong to the same alphabet in the same
// position, or no legal cache name could ever start with it.
export const cacheNamePrefixPattern = /^([a-z0-9][a-z0-9._-]*)?$/;

// The default cache's selector. Its stored name is the empty string, which
// cannot appear in a `/cache/{cacheName}/` path, so contract URLs spell it
// `_default`. The leading underscore fails `cacheNamePattern`, so the selector
// can never collide with a creatable cache, matching the `/_health` and
// `/_version` convention for non-content names.
export const DEFAULT_CACHE_SELECTOR = '_default';

// Private stored names begin with this prefix. The local name of a public
// cache cannot contain a slash, so no public stored name begins with this
// prefix.
export const PRIVATE_STORED_PREFIX = 'private/';

// Private selectors begin with this prefix. A named public cache's selector
// cannot start with an underscore, so it cannot use this prefix.
export const PRIVATE_SELECTOR_PREFIX = '_private-';

export const privateStoredCachePattern = /^private\/[a-z0-9][a-z0-9._-]{0,62}$/;
export const privateCacheSelectorPattern =
	/^_private-[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * A private cache's stored name: `private/` followed by its local name. The
 * stored name records privacy as part of the cache identity, so changing
 * privacy requires a different identity.
 */
export const privateStoredCacheSchema = z
	.string()
	.regex(privateStoredCachePattern)
	.brand('PrivateStoredCache');
export type PrivateStoredCache = z.output<typeof privateStoredCacheSchema>;

/**
A private cache's selector: `_private-` followed by its local name.
*/
export const privateCacheSelectorSchema = z
	.string()
	.regex(privateCacheSelectorPattern)
	.brand('PrivateCacheSelector');
export type PrivateCacheSelector = z.output<typeof privateCacheSelectorSchema>;

/**
 * A public selector: `_default` for the default cache or the local name of a
 * named public cache. Use this where a request must never address a private
 * cache, such as the public read paths.
 */
export const publicCacheSelectorSchema = z.union([
	z.literal(DEFAULT_CACHE_SELECTOR),
	cacheNameSchema
]);
export type PublicCacheSelector = z.output<typeof publicCacheSelectorSchema>;

export const cacheSelectorSchema = z.union([
	publicCacheSelectorSchema,
	privateCacheSelectorSchema
]);
export type CacheSelector = z.output<typeof cacheSelectorSchema>;

/**
 * The stored name of a cache: `CacheName` for a named public cache,
 * `DEFAULT_CACHE` for the default cache, or `PrivateStoredCache` for a private
 * cache. Convert a selector with `cacheFromSelector`. Parse a raw database
 * value before using it as `StoredCache`.
 */
export const storedCacheSchema = z.union([
	z.literal(DEFAULT_CACHE),
	cacheNameSchema,
	privateStoredCacheSchema
]);
export type StoredCache = z.output<typeof storedCacheSchema>;

export function isPrivateCache(
	cache: StoredCache
): cache is PrivateStoredCache {
	return privateStoredCacheSchema.safeParse(cache).success;
}

function isPrivateCacheSelector(
	selector: CacheSelector
): selector is PrivateCacheSelector {
	return privateCacheSelectorSchema.safeParse(selector).success;
}

/**
The stored name of the private cache whose local name is `name`.
*/
export function privateStoredCache(name: CacheName): PrivateStoredCache {
	return privateStoredCacheSchema.parse(`${PRIVATE_STORED_PREFIX}${name}`);
}

/**
The local name of a private cache, without the `private/` prefix.
*/
export function privateCacheLocalName(cache: PrivateStoredCache): CacheName {
	return cacheNameSchema.parse(cache.slice(PRIVATE_STORED_PREFIX.length));
}

export function cacheFromSelector(selector: CacheSelector): StoredCache {
	if (selector === DEFAULT_CACHE_SELECTOR) {
		return DEFAULT_CACHE;
	}

	if (isPrivateCacheSelector(selector)) {
		return privateStoredCacheSchema.parse(
			`${PRIVATE_STORED_PREFIX}${selector.slice(PRIVATE_SELECTOR_PREFIX.length)}`
		);
	}

	return selector;
}

export function selectorForCache(cache: StoredCache): CacheSelector {
	if (cache === DEFAULT_CACHE) {
		return DEFAULT_CACHE_SELECTOR;
	}

	if (isPrivateCache(cache)) {
		return privateCacheSelectorSchema.parse(
			`${PRIVATE_SELECTOR_PREFIX}${privateCacheLocalName(cache)}`
		);
	}

	return cache;
}

// Raw bounds for the private stored-name range. Queries use these bounds to
// exclude private caches. `'0'` is the code unit after `'/'`, so the half-open
// range `[PRIVATE_STORED_RANGE_START, PRIVATE_STORED_RANGE_END)` contains every
// private stored name and no public stored name. A public cache whose local
// name is `private` sorts below the start bound.
export const PRIVATE_STORED_RANGE_START = PRIVATE_STORED_PREFIX;
export const PRIVATE_STORED_RANGE_END = 'private0';

// A tenant slug: the outer addressing boundary, one isolated namespace per tenant
// at `/t/<tenant>/`. It shares the cache-name shape but is its own branded type;
// named caches nest within a tenant at `/t/<tenant>/cache/<name>/`.
export const tenantIdSchema = z
	.string()
	.regex(cacheNamePattern)
	.brand('TenantId');
export type TenantId = z.infer<typeof tenantIdSchema>;

// A Nix substituter priority: a non-negative integer where lower is preferred.
export const cachePrioritySchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER)
	.brand('CachePriority');
export type CachePriority = z.infer<typeof cachePrioritySchema>;

// A narinfo version, sourced from `generation_seq` on each (re)commit and
// captured by the D1 reference edge, so a stale deletion compares against it and
// can never remove a newer recommitted edge. Its own brand keeps it from
// crossing with sizes, counts, or a reuse-view revision.
export const narInfoGenerationSchema = z
	.number()
	.int()
	.min(0)
	.max(Number.MAX_SAFE_INTEGER)
	.brand('NarInfoGeneration');
export type NarInfoGeneration = z.infer<typeof narInfoGenerationSchema>;

export const compressionSchema = z.literal('zstd');

export const referencesSchema = z
	.array(storePathBasenameSchema)
	.max(referencesMaxLength);

// A single free-form narinfo metadata line (`Deriver`, `CA`): bounded and free
// of control characters, so a value that parses here always renders back to a
// well-formed narinfo line. The render path rejects control characters, so an
// upload that accepted them would write a charged edge that can never render.
export const narInfoLineSchema = z
	.string()
	.max(narInfoLineMaxLength)
	.refine((value) => !hasControlCharacter(value));
