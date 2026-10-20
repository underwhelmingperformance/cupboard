import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { MinScanIntervalInvalidError } from '../errors.ts';

import {
	defaultMinScanIntervalSeconds,
	maxMinScanIntervalSeconds,
	minScanIntervalMs
} from './garbage-collection.ts';

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('minScanIntervalMs', () => {
	it.each([
		{
			name: 'returns the built-in interval for an empty setting',
			value: '',
			expected: defaultMinScanIntervalSeconds * 1000
		},
		{ name: 'returns a configured interval', value: '60', expected: 60_000 },
		{ name: 'accepts an interval of zero', value: '0', expected: 0 },
		{
			name: 'accepts the maximum interval',
			value: String(maxMinScanIntervalSeconds),
			expected: maxMinScanIntervalSeconds * 1000
		}
	])('$name', ({ value, expected }) => {
		expect(
			minScanIntervalMs({ CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS: value })
		).toBe(expected);
	});

	it.each([
		{ name: 'a non-number', value: 'hourly' },
		{ name: 'a negative interval', value: '-1' },
		{ name: 'a fractional interval', value: '1.5' },
		{ name: 'whitespace', value: ' ' },
		{ name: 'surrounding whitespace', value: ' 60 ' },
		{ name: 'an exponent', value: '1e3' },
		{ name: 'a hexadecimal number', value: '0x10' },
		{ name: 'a sign', value: '+60' },
		{
			name: 'an interval above the maximum',
			value: String(maxMinScanIntervalSeconds + 1)
		},
		{ name: 'an interval outside the date range', value: '10000000000000' }
	])('rejects $name', ({ value }) => {
		const error = thrownBy(() =>
			minScanIntervalMs({ CUPBOARD_GC_MIN_SCAN_INTERVAL_SECONDS: value })
		);

		expect(error).toBeInstanceOf(MinScanIntervalInvalidError);

		if (!(error instanceof MinScanIntervalInvalidError)) {
			throw error;
		}

		expect({ status: error.status, value: error.value }).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			value
		});
	});
});
