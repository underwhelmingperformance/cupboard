import { rootTtlMaxSeconds, rootTtlMinSeconds } from '@cupboard/nix/scalars';

import {
	InvalidDurationError,
	InvalidTtlError,
	InvalidWaitTimeoutError
} from './errors.ts';

const unitSeconds = new Map<string, number>([
	['s', 1],
	['m', 60],
	['h', 3600],
	['d', 86_400],
	['w', 604_800]
]);

/** Parses a human duration such as `7d` or `12h` into a whole number of seconds. */
function parseDurationSeconds(input: string): number {
	const match = /^(\d+)([smhdw])$/.exec(input);
	const amount = match?.[1];
	const unit = match?.[2];
	const multiplier = unit === undefined ? undefined : unitSeconds.get(unit);

	if (amount === undefined || multiplier === undefined) {
		throw new InvalidDurationError(input);
	}

	return Number(amount) * multiplier;
}

/**
 * Parses a retention-root TTL, rejecting anything outside the root TTL bounds so
 * the CLI fails with the same limits the server enforces.
 */
export function parseTtl(input: string): number {
	const seconds = parseDurationSeconds(input);

	if (seconds < rootTtlMinSeconds || seconds > rootTtlMaxSeconds) {
		throw new InvalidTtlError(input, rootTtlMinSeconds, rootTtlMaxSeconds);
	}

	return seconds;
}

/**
 * Parses the `--wait-timeout` duration: how long a push waits for deferred blobs
 * to become servable. It shares the duration syntax but carries no retention
 * bounds, and rejects a zero wait, which would otherwise time the commit out on
 * the next tick; use `--no-wait` to skip waiting entirely.
 */
export function parseWaitTimeout(input: string): number {
	const seconds = parseDurationSeconds(input);

	if (seconds < 1) {
		throw new InvalidWaitTimeoutError(input);
	}

	return seconds;
}
