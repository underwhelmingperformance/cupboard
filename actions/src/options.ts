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
	ChoiceInputInvalidError,
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
 * Parses a public cache input. An absent or blank input selects the default
 * cache. This input rejects the private stored form `private/<name>` because
 * callers select private caches through `private-cache`.
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
 * Resolves the single cache targeted by an action. `cache` selects the public
 * namespace, while `private-cache` selects the private namespace. The run fails
 * if both inputs are set. If both are empty, it selects the tenant's default
 * cache.
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
 * Returns the cupboard arguments for one cache. The default cache requires no
 * cache-selection argument.
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
 * Parses public cache names in input order. A blank input returns an empty list,
 * and the caller decides whether that means the default cache or no cache.
 */
export function providedCaches(
	value: string | undefined
): readonly PublicStoredCache[] {
	return parseListInput(value ?? '').map((name) => providedCache(name));
}

/**
 * Parses the local names of private caches in input order. Credential documents
 * and URLs use local names; `privateStoredCache` converts them to stored names.
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
 * Parses `private-cache-credentials`, a JSON object that maps each private
 * cache's local name to its read credential. An absent or blank input returns
 * an empty map. A caller can use the shared `read-user` and `read-password` for
 * a cache with no entry.
 *
 * Rejects an entry unless `private-cache` lists the same cache. Otherwise the
 * credential document and the configured cache list disagree.
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

/**
 * Accept one of `choices` after trimming. A blank or absent value uses the
 * fallback; any other value fails the run with a
 * {@link ChoiceInputInvalidError} that lists the accepted values.
 */
export function providedChoice<Choice extends string>(
	name: string,
	value: string | undefined,
	choices: readonly Choice[],
	fallback: Choice
): Choice {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return fallback;
	}

	const chosen = choices.find((choice) => choice === trimmed);

	if (chosen === undefined) {
		throw new ChoiceInputInvalidError(name, trimmed, choices);
	}

	return chosen;
}

export function collectLines(
	value: string,
	previous: readonly string[]
): string[] {
	return [...previous, ...parseLines(value)];
}
