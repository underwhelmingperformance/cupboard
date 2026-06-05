import { rootTtlMaxSeconds, rootTtlMinSeconds } from '@cupboard/nix/scalars';
import { InvalidArgumentError } from 'commander';

const unitSeconds = new Map<string, number>([
	['s', 1],
	['m', 60],
	['h', 3600],
	['d', 86_400],
	['w', 604_800]
]);

/**
 * Parses a human duration such as `7d` or `12h` into a whole number of seconds,
 * rejecting anything outside the retention-root TTL bounds so the CLI fails with
 * the same limits the server enforces.
 */
export function parseTtl(input: string): number {
	const match = /^(\d+)([smhdw])$/.exec(input);
	const amount = match?.[1];
	const unit = match?.[2];
	const multiplier = unit === undefined ? undefined : unitSeconds.get(unit);

	if (amount === undefined || multiplier === undefined) {
		throw new InvalidArgumentError(
			'Expected a duration like "7d", "12h" or "30m" (units s, m, h, d, w).'
		);
	}

	const seconds = Number(amount) * multiplier;

	if (seconds < rootTtlMinSeconds || seconds > rootTtlMaxSeconds) {
		throw new InvalidArgumentError(
			`TTL must be between ${String(rootTtlMinSeconds)} and ${String(rootTtlMaxSeconds)} seconds.`
		);
	}

	return seconds;
}
