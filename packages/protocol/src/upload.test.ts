import {
	rootNameMaxLength,
	rootTtlMaxSeconds
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	commitBatchCapabilityToken,
	commitCapabilitiesValue,
	commitCapabilitiesValueWithCredit,
	commitCreditCapability,
	commitCreditCapabilityToken,
	commitSessionFrameSchema,
	commitSessionRequestSchema,
	retentionMarkerAttribute,
	retentionMarkerAttributeValue,
	statsResponseSchema,
	subscribeIdentityCapabilityToken,
	uploadCapabilitiesHeader,
	uploadCapabilitiesValue,
	uploadConfirmMaxPaths,
	uploadConfirmRequestSchema,
	uploadConfirmResponseSchema,
	uploadDecisionSchema,
	uploadGraceFactsCapability,
	uploadGraceFactSchema,
	uploadNegotiateMaxPaths,
	uploadNegotiateRequestSchema,
	uploadPreviewResponseSchema,
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
	it('defines the upload grace-facts acknowledgement', () => {
		expect({
			header: uploadCapabilitiesHeader,
			value: uploadCapabilitiesValue
		}).toStrictEqual({
			header: 'x-cupboard-upload-capabilities',
			value: uploadGraceFactsCapability
		});
	});

	it('accepts a well-formed request', () => {
		const value = { pushId, paths: [negotiationPath] };

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'a run root with no ttl',
			attachRoot: { name: 'github:owner/repo/pr-1' }
		},
		{
			name: 'a run root with a ttl',
			attachRoot: { name: 'ci', ttlSeconds: 86_400 }
		}
	])('accepts a request attaching $name', ({ attachRoot }) => {
		const value = { pushId, paths: [negotiationPath], attachRoot };

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an over-length root name',
			attachRoot: { name: 'r'.repeat(rootNameMaxLength + 1) },
			issues: [{ code: 'too_big', path: ['attachRoot', 'name'] }]
		},
		{
			name: 'a root name carrying a control character',
			attachRoot: { name: 'ci\nnightly' },
			issues: [{ code: 'custom', path: ['attachRoot', 'name'] }]
		},
		{
			name: 'a ttl above the root bound',
			attachRoot: { name: 'ci', ttlSeconds: rootTtlMaxSeconds + 1 },
			issues: [{ code: 'too_big', path: ['attachRoot', 'ttlSeconds'] }]
		},
		{
			name: 'a ttl below the root bound',
			attachRoot: { name: 'ci', ttlSeconds: 0 },
			issues: [{ code: 'too_small', path: ['attachRoot', 'ttlSeconds'] }]
		},
		{
			name: 'an unknown key',
			attachRoot: { name: 'ci', surprise: true },
			issues: [{ code: 'unrecognized_keys', path: ['attachRoot'] }]
		}
	])('rejects an attachRoot with $name', ({ attachRoot, issues }) => {
		const result = uploadNegotiateRequestSchema.safeParse({
			pushId,
			paths: [negotiationPath],
			attachRoot
		});

		expect(
			result.success
				? []
				: result.error.issues.map((issue) => ({
						code: issue.code,
						path: issue.path
					}))
		).toStrictEqual(issues);
	});

	// The cross-check reads the hash out of the path, and a store directory
	// varies in length, so a hash read at a fixed offset would compare the wrong
	// slice for every store but the default one. These paths carry a directory
	// of a different length in front of the same basename.
	it.each([
		{ name: 'a home directory store', directory: '/home/laney/nixstore' },
		{
			name: 'a deeply nested store',
			directory: '/var/lib/cupboard/nix/store'
		},
		{ name: 'a single-segment store', directory: '/nixstore' }
	])('cross-checks the hash of a path in $name', ({ directory }) => {
		const matching = {
			...negotiationPath,
			storePath: `${directory}/${storePathHash}-name`
		};
		const mismatched = { ...matching, storePathHash: '1'.repeat(32) };

		expect({
			matching: uploadNegotiateRequestSchema.safeParse({
				pushId,
				paths: [matching]
			}).success,
			mismatched: uploadNegotiateRequestSchema.safeParse({
				pushId,
				paths: [mismatched]
			}).success
		}).toStrictEqual({ matching: true, mismatched: false });
	});

	// A narinfo names its deriver by basename, the way it names references, so
	// the two fields carry different shapes: `ca` is a content-address
	// specification and not a path at all.
	it.each([
		{
			name: 'a deriver basename',
			field: 'deriver' as const,
			value: `${storePathHash}-name.drv`
		},
		{
			name: 'a ca specification',
			field: 'ca' as const,
			value: `fixed:r:sha256:${'1'.repeat(52)}`
		}
	])('accepts $name', ({ field, value: field_ }) => {
		const value = {
			pushId,
			paths: [{ ...negotiationPath, [field]: field_ }]
		};

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			name: 'an unknown top-level key',
			value: { paths: [], extra: 1 }
		},
		{
			name: 'a body-level retention marker',
			value: { paths: [], retention: { kind: 'none' } }
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
			name: 'a deriver named by store path instead of basename',
			value: {
				paths: [
					{
						...negotiationPath,
						deriver: `/nix/store/${'0'.repeat(32)}-app.drv`
					}
				]
			}
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

describe('uploadPreviewResponseSchema', () => {
	it.each([
		{
			name: 'skip with a stored deadline',
			value: {
				action: 'skip',
				storePathHash,
				narHash,
				grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
			}
		},
		{
			name: 'commit with a captured grace',
			value: {
				action: 'commit',
				storePathHash,
				narHash,
				grace: { graceSeconds: 86_400 }
			}
		},
		{
			name: 'upload with no matching policy',
			value: { action: 'upload', storePathHash, narHash, grace: {} }
		},
		{
			name: 'a decision with no grace field at all',
			value: { action: 'upload', storePathHash, narHash }
		}
	])('accepts $name', ({ value }) => {
		expect(
			uploadPreviewResponseSchema.parse({ uploads: [value] })
		).toStrictEqual({ uploads: [value] });
	});

	it.each([
		{
			name: 'an unknown action',
			value: { action: 'destroy', storePathHash, narHash }
		},
		{
			name: 'an upload decision carrying an uploadId',
			value: { action: 'upload', storePathHash, narHash, uploadId: 'u1' }
		}
	])('rejects $name', ({ value }) => {
		expect(
			uploadPreviewResponseSchema.safeParse({ uploads: [value] }).success
		).toBe(false);
	});
});

describe('uploadConfirmRequestSchema', () => {
	it('accepts a bounded list of store-path hashes', () => {
		const value = { storePathHashes: [storePathHash] };

		expect(uploadConfirmRequestSchema.parse(value)).toStrictEqual(value);
	});

	it('accepts an empty list', () => {
		const value = { storePathHashes: [] };

		expect(uploadConfirmRequestSchema.parse(value)).toStrictEqual(value);
	});

	it('accepts a list at the shared negotiate bound and rejects one above it', () => {
		const atBound = {
			storePathHashes: Array.from(
				{ length: uploadConfirmMaxPaths },
				() => storePathHash
			)
		};

		expect({
			atBound: uploadConfirmRequestSchema.safeParse(atBound).success,
			aboveBound: uploadConfirmRequestSchema.safeParse({
				storePathHashes: [...atBound.storePathHashes, storePathHash]
			}).success
		}).toStrictEqual({ atBound: true, aboveBound: false });
	});

	it.each([
		{
			name: 'a malformed store-path hash',
			value: { storePathHashes: ['not-a-hash'] }
		},
		{
			name: 'an unknown top-level key',
			value: { storePathHashes: [storePathHash], extra: 1 }
		}
	])('rejects $name', ({ value }) => {
		expect(uploadConfirmRequestSchema.safeParse(value).success).toBe(false);
	});
});

describe('uploadConfirmResponseSchema', () => {
	it.each([
		{
			name: 'a confirmed path with a stored deadline',
			value: {
				storePathHash,
				confirmed: true,
				grace: { retainUntil: '2026-01-02T00:00:00.000Z' }
			}
		},
		{
			name: 'a confirmed path with no matching policy',
			value: { storePathHash, confirmed: true, grace: {} }
		},
		{
			name: 'an unconfirmed path with no grace field',
			value: { storePathHash, confirmed: false }
		}
	])('accepts $name', ({ value }) => {
		expect(uploadConfirmResponseSchema.parse({ paths: [value] })).toStrictEqual(
			{ paths: [value] }
		);
	});

	it('rejects an unknown field on a confirmed path', () => {
		expect(
			uploadConfirmResponseSchema.safeParse({
				paths: [{ storePathHash, confirmed: true, extra: 1 }]
			}).success
		).toBe(false);
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
		{ op: 'subscribe', uploadIds: ['upload-1', 'upload-2'] },
		{ op: 'request-credit', entries: 42 }
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
		{ ev: 'error', uploadId: 'upload-1', status: 500, message: 'boom' },
		{ ev: 'credit', grant: 100 },
		{ ev: 'queued', ahead: 0 },
		{ ev: 'queued', ahead: 3 }
	])('accepts the $ev frame', (value) => {
		expect(commitSessionFrameSchema.parse(value)).toStrictEqual(value);
	});

	it('requires an uploadId on every frame', () => {
		expect(
			commitSessionFrameSchema.safeParse({ ev: 'verdict', status: 'servable' })
				.success
		).toBe(false);
	});

	// Credit counts entries. A declaration of no entries asks for nothing, and a
	// negative or fractional count is a broken client rather than a small demand.
	it.each([
		{ shape: 'no entries', request: { op: 'request-credit', entries: 0 } },
		{
			shape: 'a negative count',
			request: { op: 'request-credit', entries: -1 }
		},
		{
			shape: 'a fractional count',
			request: { op: 'request-credit', entries: 1.5 }
		}
	])('rejects a request-credit op declaring $shape', ({ request }) => {
		expect(commitSessionRequestSchema.safeParse(request).success).toBe(false);
	});

	// A grant of nothing is sent as `queued`, so a `credit` frame always carries
	// entries the session may spend.
	it.each([
		{
			shape: 'a credit frame granting nothing',
			frame: { ev: 'credit', grant: 0 }
		},
		{
			shape: 'a queued frame counting fewer than no sessions ahead',
			frame: { ev: 'queued', ahead: -1 }
		}
	])('rejects $shape', ({ frame }) => {
		expect(commitSessionFrameSchema.safeParse(frame).success).toBe(false);
	});

	// The opening grant is carried on the token, so a client reads its first
	// grant from the same header that carries the batch bound, with no further
	// round trip. A saturated tenant advertises `grant=0` and the session waits
	// for a `credit` frame.
	it('advertises the credit token with the opening grant', () => {
		expect({
			capability: commitCreditCapability,
			granted: commitCreditCapabilityToken(200),
			saturated: commitCreditCapabilityToken(0),
			header: commitCapabilitiesValueWithCredit(200)
		}).toStrictEqual({
			capability: 'commit-credit',
			granted: 'commit-credit;grant=200',
			saturated: 'commit-credit;grant=0',
			header: `commit-batch;max=100;${retentionMarkerAttribute}=${retentionMarkerAttributeValue},subscribe-identity;${retentionMarkerAttribute}=${retentionMarkerAttributeValue},commit-credit;grant=200`
		});
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
