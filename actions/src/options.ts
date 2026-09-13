import {
	cacheNameSchema,
	type CacheScope,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import {
	type CacheCredentials,
	cacheCredentialsSchema
} from '@cupboard/protocol/cache-credentials';
import { type ReadUser, readUserInputSchema } from '@cupboard/shared/http';

import {
	BooleanInputInvalidError,
	CacheCredentialsInvalidError,
	CacheNameInvalidError,
	ChoiceInputInvalidError,
	ReadUserInvalidError,
	UnknownCacheCredentialError,
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
 * Parses one cache input. An absent or blank input selects the default cache.
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
 * Parses cache names in input order. A blank input returns an empty list,
 * and the caller decides whether that means the default cache or no cache.
 */
export function providedCaches(
	value: string | undefined
): readonly CacheScope[] {
	return parseListInput(value ?? '').map((name) => providedCache(name));
}

/**
 * Parses `cache-credentials`. An absent or blank input returns an empty list.
 * Rejects an entry unless `cache` lists the same cache. Otherwise the
 * credential document and the configured cache list disagree.
 */
export function providedCacheCredentials(
	value: string | undefined,
	caches: readonly CacheScope[]
): CacheCredentials {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return [];
	}

	let document: unknown;

	try {
		document = JSON.parse(trimmed);
	} catch (error) {
		throw new CacheCredentialsInvalidError({ cause: error });
	}

	const parsed = cacheCredentialsSchema.safeParse(document);

	if (!parsed.success) {
		throw new CacheCredentialsInvalidError({ cause: parsed.error });
	}

	for (const entry of parsed.data) {
		if (caches.every((cache) => !isSameCacheScope(cache, entry.cache))) {
			throw new UnknownCacheCredentialError(
				entry.cache.kind === 'default' ? 'the default cache' : entry.cache.name
			);
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
