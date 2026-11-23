import {
	cacheNameSchema,
	type CacheScope,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { isHttpsOrLoopbackHttp, parseBaseUrl } from '@cupboard/nix-store/url';
import {
	type AccessKeySecret,
	accessKeySecretSchema
} from '@cupboard/protocol/access-keys';
import {
	type CacheAccessKeys,
	cacheAccessKeysSchema
} from '@cupboard/protocol/cache-access-keys';
import {
	type BasicCredential,
	readUserInputSchema
} from '@cupboard/shared/http';
import { hasControlCharacter } from '@cupboard/shared/text';

import {
	AccessKeyInvalidError,
	BooleanInputInvalidError,
	CacheAccessKeysInvalidError,
	CacheNameInvalidError,
	ChoiceInputInvalidError,
	PrivateSubstituterInvalidError,
	UnknownCacheAccessKeyError,
	UrlInputInsecureError,
	UrlInputInvalidError,
	type UrlInputName
} from './errors.ts';
import { parseLines, parseListInput } from './inputs.ts';

/**
Treat a blank workflow value as absent after trimming. Omitted and empty
flags therefore use the same fallback.
*/
export function provided(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
Parses one cache input. An absent or blank input selects the default cache.
*/
export function providedCache(value: string | undefined): CacheScope {
	const name = provided(value);

	if (name === undefined) {
		return { kind: 'default' };
	}

	const parsed = cacheNameSchema.safeParse(name);

	if (!parsed.success) {
		throw new CacheNameInvalidError(value ?? '');
	}

	return { kind: 'named', name: parsed.data };
}

export function providedCacheSelection(cache: string | undefined): CacheScope {
	return providedCache(cache);
}

/**
Parses cache names in input order. A blank input returns an empty list,
and the caller decides whether that means the default cache or no cache.
*/
export function providedCaches(
	value: string | undefined = ''
): readonly CacheScope[] {
	return parseListInput(value).map((name) => providedCache(name));
}

/**
Parses `cache-access-keys`. An absent or blank input returns an empty list.
Rejects an entry unless `cache` lists the same cache. Otherwise the key
document and the configured cache list disagree.
*/
export function providedCacheAccessKeys(
	value: string | undefined,
	caches: readonly CacheScope[]
): CacheAccessKeys {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return [];
	}

	let document: unknown;

	try {
		document = JSON.parse(trimmed);
	} catch (error) {
		throw new CacheAccessKeysInvalidError({ cause: error });
	}

	const parsed = cacheAccessKeysSchema.safeParse(document);

	if (!parsed.success) {
		throw new CacheAccessKeysInvalidError({ cause: parsed.error });
	}

	for (const entry of parsed.data) {
		if (caches.every((cache) => !isSameCacheScope(cache, entry.cache))) {
			throw new UnknownCacheAccessKeyError(
				entry.cache.kind === 'default' ? 'the default cache' : entry.cache.name
			);
		}
	}

	return parsed.data;
}

/**
Accept an HTTP(S) base URL containing only an origin and path. Reject a
query, fragment or embedded credential before making a request, and reject
plain HTTP to a host other than loopback. The error includes only the input
name because the rejected value may contain a secret. Return `undefined` for
an absent or blank input.
*/
export function providedUrl(
	name: UrlInputName,
	value: string | undefined
): URL | undefined {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return undefined;
	}

	let url: URL;

	try {
		url = parseBaseUrl(new URL(trimmed));
	} catch {
		throw new UrlInputInvalidError(name);
	}

	if (!isHttpsOrLoopbackHttp(url)) {
		throw new UrlInputInsecureError(name);
	}

	return url;
}

/**
Parses one authenticated substituter URL per line, and refuses plain HTTP to
a host other than loopback. Error messages omit the URL because it contains a
password.
*/
export function providedPrivateSubstituters(
	value: string | undefined = ''
): URL[] {
	return parseLines(value).map((entry, index) => {
		let url: URL;

		try {
			url = new URL(entry);

			if (
				(url.protocol !== 'http:' && url.protocol !== 'https:') ||
				url.username === '' ||
				url.password === '' ||
				url.search !== '' ||
				url.hash !== ''
			) {
				throw new PrivateSubstituterInvalidError(index + 1);
			}

			if (
				!readUserInputSchema.safeParse(decodeURIComponent(url.username))
					.success ||
				hasControlCharacter(decodeURIComponent(url.password))
			) {
				throw new PrivateSubstituterInvalidError(index + 1);
			}
		} catch {
			throw new PrivateSubstituterInvalidError(index + 1);
		}

		if (!isHttpsOrLoopbackHttp(url)) {
			throw new UrlInputInsecureError('private-substituters');
		}

		return url;
	});
}

/**
Parses an input that contains an access key. Returns `''` when the input is
absent or blank, and throws {@link AccessKeyInvalidError} when it contains
something else, such as an access token.
*/
export function providedAccessKey(
	name: string,
	value: string | undefined
): AccessKeySecret | '' {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return '';
	}

	const parsed = accessKeySecretSchema.safeParse(trimmed);

	if (!parsed.success) {
		throw new AccessKeyInvalidError(name);
	}

	return parsed.data;
}

// The server ignores the Basic user name of an access key, but netrc and Basic
// authentication need one, so the actions always send this one.
const accessKeyUser = readUserInputSchema.parse('cupboard');

/**
The HTTP Basic credential that presents an access key.
*/
export function basicCredentialForAccessKey(
	key: AccessKeySecret
): BasicCredential {
	return { user: accessKeyUser, password: key };
}

/**
The HTTP Basic credential that presents an access key, or undefined for `''`.
*/
export function accessKeyCredential(
	key: AccessKeySecret | ''
): BasicCredential | undefined {
	return key === '' ? undefined : basicCredentialForAccessKey(key);
}

/**
Accept only the exact literals `true` and `false` after trimming. A blank or
absent value uses the fallback; any other value fails the run with
{@link BooleanInputInvalidError}.
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
Accept one of `choices` after trimming. A blank or absent value uses the
fallback; any other value fails the run with a
{@link ChoiceInputInvalidError} that lists the accepted values.
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
