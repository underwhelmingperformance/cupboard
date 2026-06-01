import { describe, expect, it } from 'vitest';

import {
	bootstrapResponseSchema,
	cacheListResponseSchema,
	cachePutBodySchema,
	cacheRemoveResponseSchema,
	cacheSummarySchema,
	checkDiscrepancySchema,
	checkReportSchema,
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema,
	retentionPolicyAddBodySchema,
	retentionPolicyListResponseSchema,
	retentionPolicyRemoveResponseSchema,
	rootSetBodySchema,
	signingKeySummarySchema,
	statsResponseSchema,
	uploadDecisionSchema,
	uploadNegotiateRequestSchema,
	usageResponseSchema
} from './messages.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;
const narHash = `sha256:${'1'.repeat(52)}`;

const negotiationPath = {
	storePathHash,
	storePath,
	narHash,
	narSize: 1234,
	references: [`${storePathHash}-name`]
};

describe('uploadNegotiateRequestSchema', () => {
	it('accepts a well-formed request', () => {
		expect(
			uploadNegotiateRequestSchema.safeParse({ paths: [negotiationPath] })
				.success
		).toBe(true);
	});

	it.each([
		{ name: 'an unknown top-level key', value: { paths: [], extra: 1 } },
		{
			name: 'an unknown key inside a path',
			value: { paths: [{ ...negotiationPath, surprise: true }] }
		},
		{
			name: 'a malformed nar hash',
			value: { paths: [{ ...negotiationPath, narHash: 'nope' }] }
		},
		{
			name: 'a non-integer nar size',
			value: { paths: [{ ...negotiationPath, narSize: 1.5 }] }
		},
		{
			name: 'a reference containing a slash',
			value: { paths: [{ ...negotiationPath, references: ['a/b'] }] }
		},
		{
			name: 'a store path hash that does not match the store path',
			value: {
				paths: [{ ...negotiationPath, storePathHash: '1'.repeat(32) }]
			}
		}
	])('rejects $name', ({ value }) => {
		expect(uploadNegotiateRequestSchema.safeParse(value).success).toBe(false);
	});
});

describe('uploadDecisionSchema', () => {
	it.each([
		{ name: 'skip', value: { action: 'skip', storePathHash, narHash } },
		{
			name: 'commit',
			value: { action: 'commit', storePathHash, narHash, uploadId: 'u1' }
		},
		{
			name: 'upload',
			value: {
				action: 'upload',
				storePathHash,
				narHash,
				uploadId: 'u1',
				r2Key: `nar/${narHash}.nar.zst`,
				expiresAt: '2026-01-01T00:00:00.000Z'
			}
		}
	])('parses a $name decision', ({ value }) => {
		expect(uploadDecisionSchema.safeParse(value).success).toBe(true);
	});

	it.each([
		{
			name: 'an unknown action',
			value: { action: 'destroy', storePathHash, narHash }
		},
		{
			name: 'a commit missing its upload id',
			value: { action: 'commit', storePathHash, narHash }
		}
	])('rejects $name', ({ value }) => {
		expect(uploadDecisionSchema.safeParse(value).success).toBe(false);
	});
});

describe('rootSetBodySchema', () => {
	it.each([
		{ name: 'targets only', value: { targets: [storePath] }, valid: true },
		{
			name: 'targets and ttl',
			value: { targets: [storePath], ttlSeconds: 3600 },
			valid: true
		},
		{ name: 'no targets', value: { targets: [] }, valid: false },
		{
			name: 'a nested target path',
			value: { targets: [`${storePath}/x`] },
			valid: false
		},
		{
			name: 'an out-of-range ttl',
			value: { targets: [storePath], ttlSeconds: 0 },
			valid: false
		}
	])('$name', ({ value, valid }) => {
		expect(rootSetBodySchema.safeParse(value).success).toBe(valid);
	});
});

describe('response schemas', () => {
	it('accepts a well-formed bootstrap and stats response', () => {
		expect({
			bootstrap: bootstrapResponseSchema.safeParse({
				url: 'https://cupboard.test',
				publicKey: 'cupboard:key',
				token: 'jwt'
			}).success,
			stats: statsResponseSchema.safeParse({
				storePaths: 1,
				narBlobs: 1,
				narFileSize: 1000,
				casObjects: 1,
				casFileSize: 234,
				pendingUploads: 0,
				totalFileSize: 1234
			}).success
		}).toStrictEqual({ bootstrap: true, stats: true });
	});

	it('rejects a stats response with a negative count', () => {
		expect(
			statsResponseSchema.safeParse({
				storePaths: -1,
				narBlobs: 0,
				narFileSize: 0,
				casObjects: 0,
				casFileSize: 0,
				pendingUploads: 0,
				totalFileSize: 0
			}).success
		).toBe(false);
	});

	it('accepts a well-formed tenant usage response', () => {
		expect(
			usageResponseSchema.safeParse({
				narBlobs: 1,
				narFileSize: 1000,
				casObjects: 1,
				casFileSize: 234,
				totalFileSize: 1234,
				quotaBytes: 2000,
				remainingQuotaBytes: 766
			}).success
		).toBe(true);
	});
});

describe('signing key schemas', () => {
	const summary = {
		id: 'active',
		publicKey: 'cupboard-1:cHVi',
		stage: 'signing',
		createdAt: '2026-01-01T00:00:00.000Z'
	};
	const rotatedSummary = {
		id: '123e4567-e89b-12d3-a456-426614174000',
		publicKey: 'cupboard-2:cHVi',
		stage: 'signing',
		createdAt: '2026-02-01T00:00:00.000Z'
	};

	it.each([
		{ name: 'a well-formed summary', value: summary, valid: true },
		{
			name: 'a publication-stage summary',
			value: { ...summary, stage: 'publication' },
			valid: true
		},
		{
			name: 'an unknown stage',
			value: { ...summary, stage: 'retired' },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...summary, surprise: true },
			valid: false
		},
		{
			name: 'a missing public key',
			value: { id: 'active', stage: 'signing', createdAt: summary.createdAt },
			valid: false
		}
	])('summary: $name', ({ value, valid }) => {
		expect(signingKeySummarySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts the list, rotate and retire responses', () => {
		expect({
			list: keyListResponseSchema.safeParse({ keys: [summary, rotatedSummary] })
				.success,
			rotate: keyRotateResponseSchema.safeParse({
				rotated: rotatedSummary,
				keys: [summary, rotatedSummary]
			}).success,
			retire: keyRetireResponseSchema.safeParse({
				id: 'active',
				stage: 'publication'
			}).success
		}).toStrictEqual({ list: true, rotate: true, retire: true });
	});

	it('rejects a retire response with an unknown stage', () => {
		expect(
			keyRetireResponseSchema.safeParse({ id: 'active', stage: 'gone' }).success
		).toBe(false);
	});
});

describe('cache schemas', () => {
	const summary = { name: 'builds', priority: 30, storePaths: 5 };

	it.each([
		{ name: 'a named cache summary', value: summary, valid: true },
		{
			name: 'the default cache summary',
			value: { name: '', priority: 40, storePaths: 0 },
			valid: true
		},
		{
			name: 'a negative priority',
			value: { ...summary, priority: -1 },
			valid: false
		},
		{
			name: 'a negative store path count',
			value: { ...summary, storePaths: -1 },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...summary, surprise: true },
			valid: false
		}
	])('summary: $name', ({ value, valid }) => {
		expect(cacheSummarySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts the list, put-body and remove responses', () => {
		expect({
			list: cacheListResponseSchema.safeParse({ caches: [summary] }).success,
			put: cachePutBodySchema.safeParse({ priority: 30 }).success,
			remove: cacheRemoveResponseSchema.safeParse({
				name: 'builds',
				removed: true,
				storePathsRemoved: 5
			}).success
		}).toStrictEqual({ list: true, put: true, remove: true });
	});

	it('rejects a put body without a priority', () => {
		expect(cachePutBodySchema.safeParse({}).success).toBe(false);
	});
});

describe('retention policy schemas', () => {
	it.each([
		{
			name: 'a cache-scoped policy',
			value: { scope: 'cache', pattern: 'builds', ttlSeconds: 1_209_600 },
			valid: true
		},
		{
			name: 'a cache-scoped policy targeting the default cache',
			value: { scope: 'cache', pattern: '', ttlSeconds: 1_209_600 },
			valid: true
		},
		{
			name: 'a prefix-scoped policy',
			value: {
				scope: 'root-name-prefix',
				pattern: 'pr-',
				ttlSeconds: 1_209_600
			},
			valid: true
		},
		{
			name: 'a cache scope with an invalid cache name',
			value: { scope: 'cache', pattern: 'Bad!', ttlSeconds: 1_209_600 },
			valid: false
		},
		{
			name: 'an unknown scope',
			value: { scope: 'tag', pattern: 'x', ttlSeconds: 1_209_600 },
			valid: false
		},
		{
			name: 'an out-of-range ttl',
			value: { scope: 'root-name-prefix', pattern: 'pr-', ttlSeconds: 0 },
			valid: false
		}
	])('add body: $name', ({ value, valid }) => {
		expect(retentionPolicyAddBodySchema.safeParse(value).success).toBe(valid);
	});

	it('accepts the list and remove responses', () => {
		expect({
			list: retentionPolicyListResponseSchema.safeParse({
				policies: [
					{
						id: 'p1',
						scope: 'root-name-prefix',
						pattern: 'pr-',
						ttlSeconds: 1_209_600
					}
				]
			}).success,
			remove: retentionPolicyRemoveResponseSchema.safeParse({
				id: 'p1',
				removed: true
			}).success
		}).toStrictEqual({ list: true, remove: true });
	});
});

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
