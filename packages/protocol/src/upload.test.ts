import { describe, expect, it } from 'vitest';

import {
	statsResponseSchema,
	uploadDecisionSchema,
	uploadNegotiateRequestSchema,
	usageResponseSchema
} from './upload.ts';

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

describe('response schemas', () => {
	it('accepts a well-formed stats response', () => {
		expect(
			statsResponseSchema.safeParse({
				storePaths: 1,
				narBlobs: 1,
				narFileSize: 1000,
				casObjects: 1,
				casFileSize: 234,
				pendingUploads: 0,
				totalFileSize: 1234
			}).success
		).toBe(true);
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
