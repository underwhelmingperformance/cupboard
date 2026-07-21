import { z } from 'zod';

export const nixSha256HashPattern = /^sha256:[0-9a-df-np-sv-z]{52}$/;
export const sha256HexDigestPattern = /^[0-9a-f]{64}$/;
export const storePathHashPattern = /^[0-9a-df-np-sv-z]{32}$/;
export const storePathNamePattern = /^[0-9A-Za-z+._?=-]+$/;
export const storePathBasenamePattern =
	/^[0-9a-df-np-sv-z]{32}-[0-9A-Za-z+._?=-]+$/;
export const storePathPattern =
	/^\/nix\/store\/[0-9a-df-np-sv-z]{32}-[0-9A-Za-z+._?=-]+$/;

export const rootNameMaxLength = 256;
export const predicateTypeMaxLength = 512;
export const narInfoLineMaxLength = 1024;
// Nix caps a store-path name at 211 characters, so a basename (32-char hash, a
// dash, the name) is at most 244 and a full `/nix/store/<basename>` at most 255.
// The patterns already constrain the charset; these bound the length so a single
// upload body cannot carry a multi-megabyte name.
export const storePathNameMaxLength = 211;
export const storePathBasenameMaxLength = 33 + storePathNameMaxLength;
export const storePathMaxLength = 11 + storePathBasenameMaxLength;
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

// The default cache's name on the wire. Its stored name is the empty string,
// which cannot appear in a `/cache/{cacheName}/` path, so contract URLs spell
// it `_default`. The leading underscore fails `cacheNamePattern`, so the alias
// can never collide with a creatable cache, matching the `/_health` and
// `/_version` convention for non-content names.
export const WIRE_DEFAULT_CACHE = '_default';

/** A cache named in a contract URL: a real cache name or the default alias. */
export const cacheSelectorSchema = z.union([
	z.literal(WIRE_DEFAULT_CACHE),
	cacheNameSchema
]);
export type CacheSelector = z.output<typeof cacheSelectorSchema>;

/** The stored cache name a wire selector addresses. */
export function cacheFromSelector(selector: CacheSelector): string {
	return selector === WIRE_DEFAULT_CACHE ? DEFAULT_CACHE : selector;
}

/** The wire selector addressing a stored cache name. */
export function selectorForCache(cache: string): string {
	return cache === DEFAULT_CACHE ? WIRE_DEFAULT_CACHE : cache;
}

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
