import { describe, expect, it } from 'vitest';

import {
	checkDiscrepancySchema,
	checkReportSchema,
	verifyReportSchema
} from './reports.ts';

const storePathHash = '0'.repeat(32);
const narHash = `sha256:${'1'.repeat(52)}`;

describe('check report schemas', () => {
	const discrepancy = {
		kind: 'missing-nar',
		cache: 'builds',
		storePathHash,
		narHash
	};

	it.each([
		{
			name: 'a missing-nar discrepancy',
			value: discrepancy,
			expected: discrepancy
		},
		{
			name: 'a missing-narinfo-object discrepancy',
			value: { ...discrepancy, kind: 'missing-narinfo-object' },
			expected: { ...discrepancy, kind: 'missing-narinfo-object' }
		},
		{
			name: 'a file-hash-mismatch discrepancy',
			value: { ...discrepancy, kind: 'file-hash-mismatch' },
			expected: { ...discrepancy, kind: 'file-hash-mismatch' }
		}
	])('accepts discrepancy: $name', ({ value, expected }) => {
		expect(checkDiscrepancySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'an unknown kind',
			value: { ...discrepancy, kind: 'surprise' }
		},
		{
			name: 'an unknown key',
			value: { ...discrepancy, surprise: true }
		}
	])('rejects discrepancy: $name', ({ value }) => {
		expect(checkDiscrepancySchema.safeParse(value).success).toBe(false);
	});

	it('accepts a complete report with discrepancies', () => {
		const value = {
			narInfosChecked: 12,
			narBlobsChecked: 10,
			complete: true,
			discrepancies: [discrepancy]
		};

		expect(checkReportSchema.parse(value)).toStrictEqual(value);
	});

	it('rejects a report with a negative count', () => {
		expect(
			checkReportSchema.safeParse({
				narInfosChecked: -1,
				narBlobsChecked: 0,
				complete: false,
				discrepancies: []
			}).success
		).toBe(false);
	});
});

describe('verifyReportSchema', () => {
	it.each([
		{
			name: 'an in-progress pass with a composite cursor',
			value: {
				scanned: 100,
				narInfoObjectsRestored: 2,
				danglingNarInfosRemoved: 1,
				cursor: 'a'.repeat(32),
				cursorCache: 'builds',
				wrapped: false
			},
			expected: {
				scanned: 100,
				narInfoObjectsRestored: 2,
				danglingNarInfosRemoved: 1,
				cursor: 'a'.repeat(32),
				cursorCache: 'builds',
				wrapped: false
			}
		},
		{
			name: 'a wrapped pass with an empty cursor',
			value: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			expected: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			}
		}
	])('accepts $name', ({ value, expected }) => {
		expect(verifyReportSchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'a negative count',
			value: {
				scanned: -1,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			}
		},
		{
			name: 'a missing cursor cache',
			value: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				wrapped: true
			}
		},
		{
			name: 'a non-string cursor',
			value: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: 1,
				cursorCache: '',
				wrapped: true
			}
		},
		{
			name: 'an unknown key',
			value: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true,
				surprise: true
			}
		}
	])('rejects $name', ({ value }) => {
		expect(verifyReportSchema.safeParse(value).success).toBe(false);
	});
});
