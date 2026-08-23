import {
	DEFAULT_CACHE,
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import { type ReadUser, readUserInputSchema } from '@cupboard/shared/http';

import {
	BooleanInputInvalidError,
	CacheNameInvalidError,
	ReadUserInvalidError,
	UrlInputInvalidError,
	type UrlInputName
} from './errors.ts';
import { parseLines } from './inputs.ts';

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
 * Use the default cache for an absent or blank input. Reject an invalid cache
 * name with {@link CacheNameInvalidError} before constructing an endpoint.
 */
export function providedCache(value: string | undefined): StoredCache {
	const parsed = storedCacheSchema.safeParse(provided(value) ?? DEFAULT_CACHE);

	if (!parsed.success) {
		throw new CacheNameInvalidError(value ?? '');
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
