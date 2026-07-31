import { describe, expect, it } from 'vitest';

import {
	buildSummarySchema,
	checkDiscrepancySchema,
	checkReportSchema,
	pushSummarySchema,
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

describe('pushSummarySchema', () => {
	const storePath = `/nix/store/${storePathHash}-app`;

	it.each([
		{
			name: 'a fully populated summary with every outcome and fact shape',
			value: {
				uploadedPaths: 1,
				reusedBlobs: 1,
				skipped: 1,
				uploadedBytes: 1234,
				failures: [
					{
						storePathHash,
						storePath,
						stage: 'verify',
						reason: 'timed out'
					}
				],
				paths: [
					{
						storePathHash,
						storePath,
						outcome: 'already-present',
						grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
					},
					{ storePathHash, outcome: 'committed', grace: {} },
					{
						storePathHash,
						outcome: 'pending',
						grace: { graceSeconds: 86_400 }
					}
				]
			}
		},
		{
			name: 'an empty summary with no facts at all',
			value: {
				uploadedPaths: 0,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 0,
				failures: [],
				paths: []
			}
		}
	])('accepts $name', ({ value }) => {
		expect(pushSummarySchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an unknown top-level key',
			value: {
				uploadedPaths: 0,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 0,
				failures: [],
				paths: [],
				surprise: true
			}
		},
		{
			name: 'an unknown path outcome',
			value: {
				uploadedPaths: 0,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 0,
				failures: [],
				paths: [{ storePathHash, outcome: 'building' }]
			}
		},
		{
			name: 'a negative count',
			value: {
				uploadedPaths: -1,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 0,
				failures: [],
				paths: []
			}
		},
		{
			name: 'a failure with an unknown stage',
			value: {
				uploadedPaths: 0,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 0,
				failures: [
					{ storePathHash, storePath, stage: 'download', reason: 'oops' }
				],
				paths: []
			}
		}
	])('rejects $name', ({ value }) => {
		expect(pushSummarySchema.safeParse(value).success).toBe(false);
	});
});

describe('buildSummarySchema', () => {
	const storePath = `/nix/store/${storePathHash}-app`;
	const summary = {
		store: 'ssh-ng://builder.example',
		targetPaths: 2,
		intermediatePaths: 5,
		queueDepth: 3,
		uploadedPaths: 4,
		skipped: 3,
		childExitStatus: 1,
		unconfirmedPaths: [storePath]
	};

	it.each([
		{
			name: 'a failed run with an unconfirmed path',
			value: summary
		},
		{
			name: 'a clean run with nothing unconfirmed',
			value: { ...summary, childExitStatus: 0, unconfirmedPaths: [] }
		}
	])('accepts $name', ({ value }) => {
		expect(buildSummarySchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an unknown key carrying a presigned URL',
			value: {
				...summary,
				presignedUrl: 'https://r2.example/nar?signature=abc'
			}
		},
		{
			name: 'an unknown key carrying a credential',
			value: { ...summary, accessToken: 'write-1' }
		},
		{
			name: 'an empty store',
			value: { ...summary, store: '' }
		},
		{
			name: 'a negative count',
			value: { ...summary, queueDepth: -1 }
		},
		{
			name: 'a negative child exit status',
			value: { ...summary, childExitStatus: -1 }
		},
		{
			name: 'an unconfirmed path outside the store',
			value: { ...summary, unconfirmedPaths: ['app'] }
		}
	])('rejects $name', ({ value }) => {
		expect(buildSummarySchema.safeParse(value).success).toBe(false);
	});
});
