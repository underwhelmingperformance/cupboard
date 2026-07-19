import { InvalidInputError } from './errors.ts';
import { parseLines } from './inputs.ts';

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
