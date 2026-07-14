import { describe, expect, it } from 'vitest';

import {
	commitBatchCapabilityToken,
	commitCapabilitiesValue,
	commitSessionFrameSchema,
	commitSessionRequestSchema,
	retentionMarkerAttribute,
	retentionMarkerAttributeValue,
	statsResponseSchema,
	subscribeIdentityCapabilityToken,
	uploadDecisionSchema,
	uploadGraceFactSchema,
	uploadNegotiateMaxPaths,
	uploadNegotiateRequestSchema,
	usageResponseSchema
} from './upload.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;
const narHash = `sha256:${'1'.repeat(52)}`;
const pushId = 'push-1';

const negotiationPath = {
	storePathHash,
	storePath,
	narHash,
	narSize: 1234,
	references: [`${storePathHash}-name`]
};

describe('uploadNegotiateRequestSchema', () => {
	it('accepts a well-formed request', () => {
		const value = { pushId, paths: [negotiationPath] };

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{ name: 'a deriver', field: 'deriver' as const },
		{ name: 'a ca', field: 'ca' as const }
	])('accepts $name metadata line', ({ field }) => {
		const value = {
			pushId,
			paths: [{ ...negotiationPath, [field]: `${storePath}.drv` }]
		};

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an unknown top-level key',
			value: { paths: [], extra: 1 }
		},
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
		},
		{
			name: 'a deriver carrying a control character',
			value: { paths: [{ ...negotiationPath, deriver: 'a\nb' }] }
		},
		{
			name: 'a ca carrying a control character',
			value: { paths: [{ ...negotiationPath, ca: 'fixed:r:sha256:\t' }] }
		},
		{
			name: 'an over-length ca line',
			value: { paths: [{ ...negotiationPath, ca: 'a'.repeat(1025) }] }
		},
		{
			name: 'more paths than the cap allows',
			value: {
				paths: Array.from({ length: uploadNegotiateMaxPaths + 1 }, () => ({
					...negotiationPath
				}))
			}
		}
	])('rejects $name', ({ value }) => {
		expect(
			uploadNegotiateRequestSchema.safeParse({ pushId, ...value }).success
		).toBe(false);
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
		expect(uploadDecisionSchema.parse(value)).toStrictEqual(value);
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

describe('uploadGraceFactSchema', () => {
	it.each([
		{ name: 'no policy fact', value: {} },
		{
			name: 'a stored deadline',
			value: { retainUntil: '2026-01-02T00:00:00.000Z' }
		},
		{ name: 'a captured grace', value: { graceSeconds: 86_400 } },
		{ name: 'a captured zero grace', value: { graceSeconds: 0 } }
	])('accepts $name', ({ value }) => {
		expect(uploadGraceFactSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'a deadline and a captured grace together',
			value: { retainUntil: '2026-01-02T00:00:00.000Z', graceSeconds: 86_400 }
		},
		{
			name: 'a grace beyond the root TTL bound',
			value: { graceSeconds: 315_360_001 }
		},
		{ name: 'a negative grace', value: { graceSeconds: -1 } },
		{ name: 'an unknown field', value: { extra: true } }
	])('rejects $name', ({ value }) => {
		expect(uploadGraceFactSchema.safeParse(value).success).toBe(false);
	});
});

describe('response schemas', () => {
	it('accepts a well-formed stats response', () => {
		const value = {
			storePaths: 1,
			narBlobs: 1,
			narFileSize: 1000,
			casObjects: 1,
			casFileSize: 234,
			pendingUploads: 0,
			totalFileSize: 1234
		};

		expect(statsResponseSchema.parse(value)).toStrictEqual(value);
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
		const value = {
			narBlobs: 1,
			narFileSize: 1000,
			casObjects: 1,
			casFileSize: 234,
			totalFileSize: 1234,
			quotaBytes: 2000,
			remainingQuotaBytes: 766
		};

		expect(usageResponseSchema.parse(value)).toStrictEqual(value);
	});
});

describe('commit session schemas', () => {
	it.each([
		{ op: 'commit', uploadId: 'upload-1' },
		{ op: 'subscribe', uploadIds: ['upload-1', 'upload-2'] }
	])('accepts the $op request', (value) => {
		expect(commitSessionRequestSchema.parse(value)).toStrictEqual(value);
	});

	it('rejects an unknown request op', () => {
		expect(
			commitSessionRequestSchema.safeParse({ op: 'cancel', uploadId: 'x' })
				.success
		).toBe(false);
	});

	it.each([
		{
			ev: 'settled',
			uploadId: 'upload-1',
			response: { storePathHash, narHash, status: 'committed' }
		},
		{ ev: 'deferred', uploadId: 'upload-1', storePathHash, narHash },
		{ ev: 'verdict', uploadId: 'upload-1', status: 'servable' },
		{ ev: 'error', uploadId: 'upload-1', status: 500, message: 'boom' }
	])('accepts the $ev frame', (value) => {
		expect(commitSessionFrameSchema.parse(value)).toStrictEqual(value);
	});

	it('requires an uploadId on every frame', () => {
		expect(
			commitSessionFrameSchema.safeParse({ ev: 'verdict', status: 'servable' })
				.success
		).toBe(false);
	});

	it.each([
		{
			op: 'commit-batch',
			commits: [{ uploadId: 'upload-1', storePathHash, narHash }]
		},
		{
			op: 'commit-batch',
			commits: [
				{ uploadId: 'upload-1', storePathHash, narHash, retention: true }
			]
		},
		{
			op: 'subscribe-identity',
			entries: [{ uploadId: 'upload-1', storePathHash, narHash }]
		},
		{
			op: 'subscribe-identity',
			entries: [
				{ uploadId: 'upload-1', storePathHash, narHash, retention: true }
			]
		}
	])(
		'accepts the $op request with and without the retention marker',
		(value) => {
			expect(commitSessionRequestSchema.parse(value)).toStrictEqual(value);
		}
	);

	it('rejects a commit-batch entry with retention set to false', () => {
		expect(
			commitSessionRequestSchema.safeParse({
				op: 'commit-batch',
				commits: [
					{ uploadId: 'upload-1', storePathHash, narHash, retention: false }
				]
			}).success
		).toBe(false);
	});

	// The retention-marker attribute must be present on both tokens (they share
	// the entry schema), so a client can send the marker on whichever op it
	// uses without a separate capability check per op.
	it('advertises the retention-marker attribute on both tokens', () => {
		expect({
			commitBatchCapabilityToken,
			subscribeIdentityCapabilityToken,
			commitCapabilitiesValue
		}).toStrictEqual({
			commitBatchCapabilityToken: `commit-batch;max=100;${retentionMarkerAttribute}=${retentionMarkerAttributeValue}`,
			subscribeIdentityCapabilityToken: `subscribe-identity;${retentionMarkerAttribute}=${retentionMarkerAttributeValue}`,
			commitCapabilitiesValue: `commit-batch;max=100;${retentionMarkerAttribute}=${retentionMarkerAttributeValue},subscribe-identity;${retentionMarkerAttribute}=${retentionMarkerAttributeValue}`
		});
	});
});
