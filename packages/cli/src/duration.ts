import {
	type GraceSeconds,
	graceSecondsSchema,
	rootTtlMaxSeconds,
	rootTtlMinSeconds,
	type TtlSeconds,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	InvalidDurationError,
	InvalidGraceError,
	InvalidTtlError,
	InvalidWaitTimeoutError
} from './errors.ts';

// How long a push waits for deferred blobs to become servable. It is a CLI-only
// duration with no retention bounds, so it has its own brand and cannot be
// used where a root TTL or a grace window is expected.
export const waitTimeoutSecondsSchema = z
	.number()
	.int()
	.min(1)
	.brand('WaitTimeoutSeconds');
export type WaitTimeoutSeconds = z.output<typeof waitTimeoutSecondsSchema>;

const unitSeconds = new Map<string, number>([
	['s', 1],
	['m', 60],
	['h', 3600],
	['d', 86_400],
	['w', 604_800]
]);

/**
Parses a human duration such as `7d` or `12h` into a whole number of seconds.
*/
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
export function parseTtl(input: string): TtlSeconds {
	const seconds = parseDurationSeconds(input);

	if (seconds < rootTtlMinSeconds || seconds > rootTtlMaxSeconds) {
		throw new InvalidTtlError(input, rootTtlMinSeconds, rootTtlMaxSeconds);
	}

	return ttlSecondsSchema.parse(seconds);
}

/**
 * Parses a retention-grace duration, sharing the root TTL's upper bound but
 * allowing zero: a grace policy may configure a zero grace, unlike a root TTL,
 * which cannot be zero.
 */
export function parseGrace(input: string): GraceSeconds {
	const seconds = parseDurationSeconds(input);

	if (seconds > rootTtlMaxSeconds) {
		throw new InvalidGraceError(input, rootTtlMaxSeconds);
	}

	return graceSecondsSchema.parse(seconds);
}

/**
 * Parses the `--wait-timeout` duration: how long a push waits for deferred blobs
 * to become servable. It shares the duration syntax but carries no retention
 * bounds, and rejects a zero wait, which would otherwise time the commit out on
 * the next tick; use `--no-wait` to skip waiting entirely.
 */
export function parseWaitTimeout(input: string): WaitTimeoutSeconds {
	const seconds = parseDurationSeconds(input);

	if (seconds < 1) {
		throw new InvalidWaitTimeoutError(input);
	}

	return waitTimeoutSecondsSchema.parse(seconds);
}
