import {
	DEFAULT_CACHE,
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';

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
 * cache name refuses the input with {@link InvalidInputError}, naming the field
 * rather than letting the run fail later against a URL no cache answers.
 */
export function providedCache(value: string | undefined): StoredCache {
	const parsed = storedCacheSchema.safeParse(provided(value) ?? DEFAULT_CACHE);

	if (!parsed.success) {
		throw new InvalidInputError('cache', 'cache must be a valid cache name');
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
