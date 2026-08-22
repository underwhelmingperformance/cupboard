import { describe, expect, it } from 'vitest';

import {
	isoFromUnixSeconds,
	verifiedTimestampCount
} from './sigstore-evidence.ts';

describe('verifiedTimestampCount', () => {
	it('does not count a proof-only Rekor entry as a verified timestamp', () => {
		expect(
			verifiedTimestampCount([
				{ $case: 'transparency-log', tlogEntry: {} },
				{
					$case: 'transparency-log',
					tlogEntry: { inclusionPromise: {} }
				},
				{ $case: 'timestamp-authority' }
			])
		).toBe(2);
	});
});

describe('isoFromUnixSeconds', () => {
	it.each([
		['a valid time', '1719757327', '2024-06-30T14:22:07.000Z'],
		['zero', '0', undefined],
		['an out-of-range time', '1e20', undefined],
		['non-numeric text', 'later', undefined]
	])('formats %s without throwing', (_name, seconds, expected) => {
		expect(isoFromUnixSeconds(seconds)).toBe(expected);
	});
});
