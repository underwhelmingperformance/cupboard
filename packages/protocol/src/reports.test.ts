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
		{ name: 'a missing-nar discrepancy', value: discrepancy, valid: true },
		{
			name: 'a missing-narinfo-object discrepancy',
			value: { ...discrepancy, kind: 'missing-narinfo-object' },
			valid: true
		},
		{
			name: 'a file-hash-mismatch discrepancy',
			value: { ...discrepancy, kind: 'file-hash-mismatch' },
			valid: true
		},
		{
			name: 'an unknown kind',
			value: { ...discrepancy, kind: 'surprise' },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...discrepancy, surprise: true },
			valid: false
		}
	])('discrepancy: $name', ({ value, valid }) => {
		expect(checkDiscrepancySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts a complete report with discrepancies', () => {
		expect(
			checkReportSchema.safeParse({
				narInfosChecked: 12,
				narBlobsChecked: 10,
				complete: true,
				discrepancies: [discrepancy]
			}).success
		).toBe(true);
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
			valid: true
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
			valid: true
		},
		{
			name: 'a negative count',
			value: {
				scanned: -1,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				cursorCache: '',
				wrapped: true
			},
			valid: false
		},
		{
			name: 'a missing cursor cache',
			value: {
				scanned: 0,
				narInfoObjectsRestored: 0,
				danglingNarInfosRemoved: 0,
				cursor: '',
				wrapped: true
			},
			valid: false
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
			},
			valid: false
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
			},
			valid: false
		}
	])('$name', ({ value, valid }) => {
		expect(verifyReportSchema.safeParse(value).success).toBe(valid);
	});
});
