import {
	DEFAULT_CACHE,
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { parseBaseUrl } from '@cupboard/nix-store/url';
import { type ReadUser, readUserInputSchema } from '@cupboard/shared/http';

import { InvalidInputError } from './errors.ts';
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

/** Whether a value is safe to pass to Nix as a positional argument. */
export function isNixPositionalArgument(value: string): boolean {
	return !value.startsWith('-') && !hasControlCharacter(value);
}

/**
 * A trimmed, non-empty option value, or `undefined` when the flag was absent or
 * blank. An empty string reaches a handler as "not provided", so the same
 * fallbacks apply whether the workflow omitted a flag or passed it empty.
 */
export function provided(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * The cache a `cache` input addresses: the named cache after trimming, or the
 * default cache when the input is absent or blank. A value that is not a legal
 * cache name causes an {@link InvalidInputError} for that field, before the run
 * constructs an endpoint for it.
 */
export function providedCache(value: string | undefined): StoredCache {
	const parsed = storedCacheSchema.safeParse(provided(value) ?? DEFAULT_CACHE);

	if (!parsed.success) {
		throw new InvalidInputError('cache', 'cache must be a valid cache name');
	}

	return parsed.data;
}

/**
 * The base URL specified by a URL-valued input, or `undefined` when the input is
 * absent or blank. Every endpoint derives from this URL's origin and path. A
 * query, fragment, or embedded credential therefore causes an
 * {@link InvalidInputError} before any request is made. The diagnostic includes
 * only the field name because the value may contain a credential.
 */
export function providedUrl(
	name: string,
	value: string | undefined
): URL | undefined {
	const trimmed = provided(value);

	if (trimmed === undefined) {
		return undefined;
	}

	try {
		return parseBaseUrl(new URL(trimmed));
	} catch {
		throw new InvalidInputError(
			name,
			`${name} must be an http(s) URL without credentials, a query, or a fragment`
		);
	}
}

/**
 * The read user a `read-user` input supplies, or `''` when the input is absent.
 * The value is taken verbatim: surrounding whitespace is part of a credential.
 * A Basic credential is `user:password` split on its first colon, so a name
 * carrying one refuses the input with {@link InvalidInputError} rather than
 * configuring a runner with a credential no cache can match.
 */
export function providedReadUser(value = ''): ReadUser | '' {
	if (value === '') {
		return '';
	}

	const parsed = readUserInputSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidInputError(
			'read-user',
			'read-user must not contain a colon'
		);
	}

	return parsed.data;
}

/**
 * A boolean option's value: `true` or `false` after trimming, with a blank or
 * absent value taking the fallback. Any other value refuses the input with
 * {@link InvalidInputError}, so a mistyped workflow value fails the run.
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

	throw new InvalidInputError(name, `${name} must be true or false`);
}

/**
 * Accumulate a repeatable list option, splitting each occurrence on newlines so
 * a single newline-delimited value and repeated flags both contribute entries.
 */
export function collectLines(
	value: string,
	previous: readonly string[]
): string[] {
	return [...previous, ...parseLines(value)];
}
