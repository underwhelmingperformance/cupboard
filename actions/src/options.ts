import {
	type CacheName,
	cacheNameSchema,
	DEFAULT_CACHE,
	isPrivateCache,
	privateCacheLocalName,
	privateStoredCache,
	type PublicStoredCache,
	publicStoredCacheSchema,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import {
	type PrivateCacheCredentials,
	privateCacheCredentialsSchema
} from '@cupboard/protocol/private-cache-credentials';
import { type ReadUser, readUserInputSchema } from '@cupboard/shared/http';

import {
	BooleanInputInvalidError,
	CacheNameInvalidError,
	CacheSelectionConflictError,
	PrivateCacheCredentialsInvalidError,
	ReadUserInvalidError,
	UnknownPrivateCacheCredentialError,
	UrlInputInvalidError,
	type UrlInputName
} from './errors.ts';
import { parseLines, parseListInput } from './inputs.ts';

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
		) {
			return true;
		}
	}

	return false;
}

/**
 * Reject a leading hyphen so Nix cannot parse a positional input as an option.
 * These values later enter Nix through newline-delimited stdin, so reject
 * control characters that could create another installable.
 */
export function isNixPositionalArgument(value: string): boolean {
	return !value.startsWith('-') && !hasControlCharacter(value);
}

/**
 * Treat a blank workflow value as absent after trimming. Omitted and empty
 * flags therefore use the same fallback.
 */
export function provided(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * The public cache an input names, or the default cache when the input is
 * absent or blank. Reject an invalid cache name with
 * {@link CacheNameInvalidError} before constructing an endpoint. A private
 * cache is named by the `private-cache` input instead, so the private stored
 * form `private/<name>` is not a legal value here.
 */
export function providedCache(value: string | undefined): PublicStoredCache {
	const parsed = publicStoredCacheSchema.safeParse(
		provided(value) ?? DEFAULT_CACHE
	);

	if (!parsed.success) {
		throw new CacheNameInvalidError(value ?? '');
	}

	return parsed.data;
}

/**
 * The single cache an action targets. The `cache` and `private-cache` inputs
 * name the same slot in different namespaces, so naming both fails the run.
 * Naming neither targets the tenant's default cache.
 */
export function providedCacheSelection(
	cache: string | undefined,
	privateCache: string | undefined
): StoredCache {
	const privateName = provided(privateCache);

	if (privateName === undefined) {
		return providedCache(cache);
	}

	if (provided(cache) !== undefined) {
		throw new CacheSelectionConflictError();
	}

	const parsed = cacheNameSchema.safeParse(privateName);

	if (!parsed.success) {
		throw new CacheNameInvalidError(privateName);
	}

	return privateStoredCache(parsed.data);
}

/**
 * The cupboard arguments that address one cache. The default cache is
 * addressed by naming no cache at all.
 */
export function cacheArguments(cache: StoredCache): readonly string[] {
	if (cache === DEFAULT_CACHE) {
		return [];
	}

	return isPrivateCache(cache)
		? ['--private-cache', privateCacheLocalName(cache)]
		: ['--cache', cache];
}

/**
 * The public caches an input names, in the order it names them. A blank input
 * names none, which leaves the caller to decide what an empty selection means.
 */
export function providedCaches(
	value: string | undefined
): readonly PublicStoredCache[] {
	return parseListInput(value ?? '').map((name) => providedCache(name));
}

/**
 * The local names of the private caches an input names, in the order it names
 * them. A private cache is addressed by local name in its credential input and
 * in its URL, and `privateStoredCache` turns one into a stored name.
 */
export function providedPrivateCacheNames(
	value: string | undefined
): readonly CacheName[] {
	return parseListInput(value ?? '').map((name) => {
		const parsed = cacheNameSchema.safeParse(name);

		if (!parsed.success) {
			throw new CacheNameInvalidError(name);
		}

		return parsed.data;
	});
}

/**
 * Parse the `private-cache-credentials` input, a JSON object mapping each
 * private cache's local name to the credential used for reads from that cache.
 * An absent or blank input names no credential, and reads from a cache with no
 * entry use the shared `read-user` and `read-password`.
 *
 * A credential for a cache the `private-cache` input does not name is refused,
 * because the credential document and the private caches the run configures
 * disagree.
 */
export function providedPrivateCacheCredentials(
	value: string | undefined,
	privateCacheNames: readonly CacheName[]
): PrivateCacheCredentials {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return new Map();
	}

	let document: unknown;

	try {
		document = JSON.parse(trimmed);
	} catch (error) {
		throw new PrivateCacheCredentialsInvalidError({ cause: error });
	}

	const parsed = privateCacheCredentialsSchema.safeParse(document);

	if (!parsed.success) {
		throw new PrivateCacheCredentialsInvalidError({ cause: parsed.error });
	}

	const listed = new Set<string>(privateCacheNames);

	for (const name of parsed.data.keys()) {
		if (!listed.has(name)) {
			throw new UnknownPrivateCacheCredentialError(name);
		}
	}

	return parsed.data;
}

/**
 * Accept an HTTP(S) base URL containing only an origin and path. Reject a
 * query, fragment or embedded credential before making a request. The error
 * includes only the input name because the rejected value may contain a secret.
 * Return `undefined` for an absent or blank input.
 */
export function providedUrl(
	name: UrlInputName,
	value: string | undefined
): URL | undefined {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return undefined;
	}

	try {
		return parseBaseUrl(new URL(trimmed));
	} catch {
		throw new UrlInputInvalidError(name);
	}
}

/**
 * Preserve a read user verbatim because surrounding whitespace is part of the
 * credential. Basic authentication separates user and password at the first
 * colon, so reject a user containing a colon instead of creating a credential
 * that no cache can match. Return `''` when the input is absent.
 */
export function providedReadUser(value = ''): ReadUser | '' {
	if (value === '') {
		return '';
	}

	const parsed = readUserInputSchema.safeParse(value);

	if (!parsed.success) {
		throw new ReadUserInvalidError(value);
	}

	return parsed.data;
}

/**
 * Accept only the exact literals `true` and `false` after trimming. A blank or
 * absent value uses the fallback; any other value fails the run with
 * {@link BooleanInputInvalidError}.
 */
export function isEnabled(
	name: string,
	value: string | undefined,
	isEnabledByDefault: boolean
): boolean {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return isEnabledByDefault;
	}

	if (trimmed === 'true') {
		return true;
	}

	if (trimmed === 'false') {
		return false;
	}

	throw new BooleanInputInvalidError(name, trimmed);
}

export function collectLines(
	value: string,
	previous: readonly string[]
): string[] {
	return [...previous, ...parseLines(value)];
}
