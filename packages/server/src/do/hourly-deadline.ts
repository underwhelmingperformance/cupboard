import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';

const hourMs = 60 * 60 * 1000;

/**
Returns `start` plus `seconds`, rounded up to the next whole hour. Every
start in one hour-long interval of `start + seconds` gives the same deadline,
so a repeat in that interval writes nothing. Rounding up keeps every
deadline at least `seconds` after `start` and at most an hour later.
*/
export function hourlyDeadline(start: number, seconds: number): IsoTimestamp {
	return isoTimestamp(
		new Date(Math.ceil((start + seconds * 1000) / hourMs) * hourMs)
	);
}
