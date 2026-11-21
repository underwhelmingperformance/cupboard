import { contentAddressedStorePath } from '@cupboard/nix-store/content-address';
import {
	rootNameMaxLength,
	rootTtlMaxSeconds,
	storePathNameMaxLength
} from '@cupboard/nix-store/scalars';
import { storePathHashOf } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import {
	buildInputsMaxJsonBytes,
	buildInputsMaxLength,
	pathEdgesMaxJsonBytes
} from './build-inputs.ts';
import {
	blobDeclarationAttribute,
	blobDeclarationAttributeValue,
	commitBatchCapabilityToken,
	commitCapabilitiesValue,
	commitCapabilitiesValueWithCredit,
	commitCreditCapability,
	commitCreditCapabilityToken,
	commitSessionFrameSchema,
	commitSessionRequestSchema,
	referencePublicationManifestSchema,
	retentionMarkerAttribute,
	retentionMarkerAttributeValue,
	statsResponseSchema,
	storedUploadPathMetadataSchema,
	storedUploadPathNegotiationSchema,
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
	uploadPreviewRequestSchema,
	uploadPreviewResponseSchema,
	usageResponseSchema
} from './upload.ts';

const storePathHash = '0'.repeat(32);
const storePath = `/nix/store/${storePathHash}-name`;
const narHash = `sha256:${'1'.repeat(52)}`;
const pushId = 'push-1';
const base32 = '1'.repeat(52);

const negotiationPath = {
	storePathHash,
	storePath,
	narHash,
	narSize: 1234,
	references: [`${storePathHash}-name`]
};
const blobMetadata = {
	fileHash: `sha256:${'2'.repeat(52)}`,
	fileSize: 456,
	compression: 'zstd'
};

// A store path basename with the longest name that a basename can have.
function longestBasename(index: number): string {
	return `${String(index).padStart(32, '0')}-${'a'.repeat(storePathNameMaxLength)}`;
}

// Path metadata without references. `ca` produces its store path.
function contentAddressedPath(ca: string) {
	const path = contentAddressedStorePath({
		storeDirectory: '/nix/store',
		name: 'name',
		contentAddress: ca,
		references: [],
		hasSelfReference: false
	});

	if (path === undefined) {
		throw new Error(`Nix computes no store path for ${ca}`);
	}

	return {
		...negotiationPath,
		storePathHash: storePathHashOf(path),
		storePath: path,
		references: [],
		ca
	};
}

function issueLocations(result: z.ZodSafeParseResult<unknown>) {
	return result.success
		? undefined
		: result.error.issues.map((issue) => ({
				code: issue.code,
				path: issue.path
			}));
}

describe('referencePublicationManifestSchema', () => {
	it('preserves a list of targets and intermediates without a total path cap', () => {
		const paths = Array.from({ length: 256 }, (_, index) => ({
			storePath: `/nix/store/${String(index).padStart(32, '0')}-path`,
			kind: index === 0 ? 'target' : 'intermediate',
			source: 'https://cupboard.example.workers.dev/t/acme',
			narinfo: 'captured narinfo text'
		}));
		const manifest = { version: 1, paths };
		expect(referencePublicationManifestSchema.parse(manifest)).toStrictEqual(
			manifest
		);
	});
});

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

	// The upload API has always accepted a repeat and any order. cupboard's own
	// clients sort the references, and a reference push repeats one that the
	// source narinfo repeats. The request lists each reference once, in code-unit
	// order.
	it('lists the references of a path once, in order', () => {
		const first = `${storePathHash}-name`;
		const second = `${'1'.repeat(32)}-other`;
		const value = {
			pushId,
			paths: [{ ...negotiationPath, references: [second, first, second] }]
		};

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual({
			pushId,
			paths: [{ ...negotiationPath, references: [first, second] }]
		});
	});

	it('lists the build inputs of a path once, in order, with their version', () => {
		const first = `${'1'.repeat(32)}-gcc`;
		const second = `${'2'.repeat(32)}-source`;
		const value = {
			pushId,
			paths: [
				{
					...negotiationPath,
					buildInputs: [second, first, second],
					buildInputsVersion: 1
				}
			]
		};

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual({
			pushId,
			paths: [
				{
					...negotiationPath,
					buildInputs: [first, second],
					buildInputsVersion: 1
				}
			]
		});
	});

	it.each([
		{
			name: 'build inputs without a version',
			fields: { buildInputs: [`${'1'.repeat(32)}-gcc`] },
			issues: [{ code: 'custom', path: ['paths', 0] }]
		},
		{
			name: 'a version without build inputs',
			fields: { buildInputsVersion: 1 },
			issues: [{ code: 'custom', path: ['paths', 0] }]
		},
		{
			name: 'a version of zero',
			fields: { buildInputs: [], buildInputsVersion: 0 },
			issues: [{ code: 'too_small', path: ['paths', 0, 'buildInputsVersion'] }]
		},
		{
			name: 'a build input named by store path instead of basename',
			fields: {
				buildInputs: [`/nix/store/${'1'.repeat(32)}-gcc`],
				buildInputsVersion: 1
			},
			issues: [{ code: 'invalid_format', path: ['paths', 0, 'buildInputs', 0] }]
		},
		{
			name: 'more build inputs than one path can have',
			fields: {
				buildInputs: Array.from(
					{ length: buildInputsMaxLength + 1 },
					(_, index) => `${String(index).padStart(32, '0')}-input`
				),
				buildInputsVersion: 1
			},
			issues: [{ code: 'too_big', path: ['paths', 0, 'buildInputs'] }]
		},
		{
			name: 'build inputs whose JSON is larger than one path can store',
			fields: {
				buildInputs: Array.from(
					{ length: Math.ceil(buildInputsMaxJsonBytes / 247) + 1 },
					(_, index) => longestBasename(index)
				),
				buildInputsVersion: 1
			},
			issues: [{ code: 'custom', path: ['paths', 0, 'buildInputs'] }]
		},
		{
			name: 'references and build inputs whose JSON is larger than one row can store',
			fields: {
				references: Array.from(
					{ length: Math.ceil(pathEdgesMaxJsonBytes / 247 / 2) + 1 },
					(_, index) => longestBasename(index)
				),
				buildInputs: Array.from(
					{ length: Math.ceil(pathEdgesMaxJsonBytes / 247 / 2) + 1 },
					(_, index) => longestBasename(index)
				),
				buildInputsVersion: 1
			},
			issues: [{ code: 'custom', path: ['paths', 0] }]
		}
	])('refuses $name', ({ fields, issues }) => {
		const result = uploadNegotiateRequestSchema.safeParse({
			pushId,
			paths: [{ ...negotiationPath, ...fields }]
		});

		expect(issueLocations(result)).toStrictEqual(issues);
	});

	// A pending upload row stores the metadata that negotiation or admission
	// accepted, and the commit reads the build inputs back from it.
	it.each([
		{
			name: 'path metadata',
			schema: storedUploadPathNegotiationSchema,
			stored: negotiationPath
		},
		{
			name: 'path and blob metadata',
			schema: storedUploadPathMetadataSchema,
			stored: { ...negotiationPath, ...blobMetadata }
		}
	])('reads stored $name with build inputs', ({ schema, stored }) => {
		const row = {
			...stored,
			buildInputs: [`${'1'.repeat(32)}-gcc`],
			buildInputsVersion: 2
		};

		expect(schema.parse(row)).toStrictEqual(row);
	});

	it.each([
		{
			name: 'a run root which inherits retention',
			attachRoot: { name: 'github:owner/repo/pr-1' }
		},
		{
			name: 'a run root with a duration',
			attachRoot: {
				name: 'ci',
				retention: { kind: 'duration', seconds: 86_400 }
			}
		}
	])('accepts a request attaching $name', ({ attachRoot }) => {
		const value = { pushId, paths: [negotiationPath], attachRoot };

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual({
			...value,
			attachRoot: {
				...value.attachRoot,
				retention:
					'retention' in value.attachRoot
						? value.attachRoot.retention
						: { kind: 'inherit' }
			}
		});
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
			attachRoot: {
				name: 'ci',
				retention: { kind: 'duration', seconds: rootTtlMaxSeconds + 1 }
			},
			issues: [
				{ code: 'too_big', path: ['attachRoot', 'retention', 'seconds'] }
			]
		},
		{
			name: 'a ttl below the root bound',
			attachRoot: {
				name: 'ci',
				retention: { kind: 'duration', seconds: 0 }
			},
			issues: [
				{ code: 'too_small', path: ['attachRoot', 'retention', 'seconds'] }
			]
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

	it('accepts a deriver basename', () => {
		const value = {
			pushId,
			paths: [{ ...negotiationPath, deriver: `${storePathHash}-name.drv` }]
		};

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	// The NAR hash of `negotiationPath` is `sha256:<base32>`, so it is the hash
	// of a NAR SHA-256 address with that digest.
	it.each([
		{ name: 'a flat fixed-output address', ca: `fixed:sha256:${base32}` },
		{ name: 'a NAR fixed-output address', ca: `fixed:r:sha256:${base32}` },
		{ name: 'a text address', ca: `text:sha256:${base32}` },
		{ name: 'a base16 digest', ca: `fixed:sha256:${'ab'.repeat(32)}` },
		{ name: 'an MD5 digest', ca: `fixed:md5:${'ab'.repeat(16)}` },
		{
			name: 'the git method, which Nix reads with git-hashing',
			ca: `fixed:git:sha1:${'ab'.repeat(20)}`
		},
		{
			name: 'a BLAKE3 digest, which Nix reads with blake3-hashes',
			ca: `fixed:r:blake3:${base32}`
		}
	])('accepts a ca with $name', ({ ca }) => {
		const value = { pushId, paths: [contentAddressedPath(ca)] };

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	it('accepts an empty ca, which Nix reads as no address', () => {
		const value = { pushId, paths: [{ ...negotiationPath, ca: '' }] };

		expect(uploadNegotiateRequestSchema.parse(value)).toStrictEqual(value);
	});

	// Nix accepts a narinfo without a trusted signature when its content address
	// produces its store path, and then checks the NAR against the address.
	it.each([
		{
			name: 'does not produce the store path',
			path: { ...negotiationPath, ca: `fixed:r:sha256:${base32}` }
		},
		{
			name: 'produces the store path without the references',
			path: {
				...contentAddressedPath(`text:sha256:${base32}`),
				references: [`${storePathHash}-other`]
			}
		},
		{
			name: 'is a NAR SHA-256 address with another hash than the NAR hash',
			path: contentAddressedPath(`fixed:r:sha256:0${'2'.repeat(51)}`)
		}
	])('refuses a ca that $name', ({ path }) => {
		const result = uploadNegotiateRequestSchema.safeParse({
			pushId,
			paths: [path]
		});

		expect(issueLocations(result)).toStrictEqual([
			{ code: 'custom', path: ['paths', 0, 'ca'] }
		]);
	});

	it.each([
		{ name: 'no method separator', ca: 'no separator here' },
		{ name: 'an unknown method', ca: `flat:sha256:${base32}` },
		{ name: 'a bare hash', ca: `sha256:${base32}` },
		{ name: 'a digest of the wrong length', ca: 'fixed:sha256:abcd' },
		{ name: 'a missing hash', ca: 'fixed:r:' },
		{
			name: 'the git method after the NAR prefix',
			ca: `fixed:r:git:sha1:${'ab'.repeat(20)}`
		}
	])('refuses a ca with $name', ({ ca }) => {
		const result = uploadNegotiateRequestSchema.safeParse({
			pushId,
			paths: [{ ...negotiationPath, ca }]
		});

		expect(issueLocations(result)).toStrictEqual([
			{ code: 'custom', path: ['paths', 0, 'ca'] }
		]);
	});

	// Every request that contains upload path metadata shares the `ca` check.
	it.each([
		{
			name: 'a negotiate request',
			schema: uploadNegotiateRequestSchema,
			request: (path: object) => ({ pushId, paths: [path] }),
			path: ['paths', 0, 'ca']
		},
		{
			name: 'a preview request',
			schema: uploadPreviewRequestSchema,
			request: (path: object) => ({ paths: [path] }),
			path: ['paths', 0, 'ca']
		},
		{
			name: 'a publish-batch request',
			schema: commitSessionRequestSchema,
			request: (path: object) => ({
				op: 'publish-batch',
				pushId,
				entries: [
					{ operationId: '1'.repeat(64), cacheGeneration: 1, metadata: path }
				]
			}),
			path: ['entries', 0, 'metadata', 'ca']
		}
	])('refuses an invalid ca in $name', ({ schema, request, path }) => {
		const results = ['not-a-content-address', `fixed:r:sha256:${base32}`].map(
			(ca) =>
				issueLocations(schema.safeParse(request({ ...negotiationPath, ca })))
		);

		expect(results).toStrictEqual([
			[{ code: 'custom', path }],
			[{ code: 'custom', path }]
		]);
	});

	// A row written before `ca` had to be a content address can contain any
	// narinfo line there, and the server must still read it.
	it.each([
		{
			name: 'path metadata',
			schema: storedUploadPathNegotiationSchema,
			stored: negotiationPath
		},
		{
			name: 'path and blob metadata',
			schema: storedUploadPathMetadataSchema,
			stored: { ...negotiationPath, ...blobMetadata }
		}
	])(
		'reads stored $name with a ca that is not an address for the path',
		({ schema, stored }) => {
			const rows = ['not-a-content-address', `fixed:r:sha256:${base32}`].map(
				(ca) => ({ ...stored, ca })
			);

			expect(rows.map((row) => schema.parse(row))).toStrictEqual(rows);
		}
	);

	it('refuses a stored ca that is not a narinfo line', () => {
		const result = storedUploadPathNegotiationSchema.safeParse({
			...negotiationPath,
			ca: 'fixed:r:sha256:\t'
		});

		expect(issueLocations(result)).toStrictEqual([
			{ code: 'custom', path: ['ca'] }
		]);
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
		{ name: 'no configured grace fact', value: {} },
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
			name: 'upload with no configured grace',
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

	it('accepts 1,000 confirmation hashes and rejects 1,001', () => {
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
			name: 'a confirmed path with no configured grace',
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
		{
			ev: 'verdict',
			uploadId: 'upload-1',
			status: 'absent',
			reason: 'cache-removed'
		},
		{ ev: 'error', uploadId: 'upload-1', status: 500, message: 'boom' }
	])('accepts the upload-specific $ev frame', (value) => {
		expect(commitSessionFrameSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		['a credit frame', { ev: 'credit', grant: 100 }],
		['a queued frame with no sessions ahead', { ev: 'queued', ahead: 0 }],
		['a queued frame with three sessions ahead', { ev: 'queued', ahead: 3 }]
	])('accepts %s', (_name, value) => {
		expect(commitSessionFrameSchema.parse(value)).toStrictEqual(value);
	});

	it.each(['servable', 'mismatch', 'pending'])(
		'rejects the cache-removed reason with the %s status',
		(status) => {
			expect(
				commitSessionFrameSchema.safeParse({
					ev: 'verdict',
					uploadId: 'upload-1',
					status,
					reason: 'cache-removed'
				}).success
			).toBe(false);
		}
	);

	it('requires an uploadId on a verdict frame', () => {
		expect(
			commitSessionFrameSchema.safeParse({ ev: 'verdict', status: 'servable' })
				.success
		).toBe(false);
	});

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
			header: `commit-batch;max=100;${retentionMarkerAttribute}=${retentionMarkerAttributeValue};${blobDeclarationAttribute}=${blobDeclarationAttributeValue},subscribe-identity;${retentionMarkerAttribute}=${retentionMarkerAttributeValue};${blobDeclarationAttribute}=${blobDeclarationAttributeValue},renew-uploads,publication-v1,commit-credit;grant=200`
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

	it('advertises the retention-marker and blob-declaration attributes on both tokens', () => {
		expect({
			commitBatchCapabilityToken,
			subscribeIdentityCapabilityToken,
			commitCapabilitiesValue
		}).toStrictEqual({
			commitBatchCapabilityToken: `commit-batch;max=100;${retentionMarkerAttribute}=${retentionMarkerAttributeValue};${blobDeclarationAttribute}=${blobDeclarationAttributeValue}`,
			subscribeIdentityCapabilityToken: `subscribe-identity;${retentionMarkerAttribute}=${retentionMarkerAttributeValue};${blobDeclarationAttribute}=${blobDeclarationAttributeValue}`,
			commitCapabilitiesValue: `commit-batch;max=100;${retentionMarkerAttribute}=${retentionMarkerAttributeValue};${blobDeclarationAttribute}=${blobDeclarationAttributeValue},subscribe-identity;${retentionMarkerAttribute}=${retentionMarkerAttributeValue};${blobDeclarationAttribute}=${blobDeclarationAttributeValue},renew-uploads,publication-v1`
		});
	});

	it.each([
		{
			op: 'commit-batch',
			commits: [
				{
					uploadId: 'upload-1',
					storePathHash,
					narHash,
					blob: { fileHash: narHash, fileSize: 4096 }
				}
			]
		},
		{
			op: 'subscribe-identity',
			entries: [
				{
					uploadId: 'upload-1',
					storePathHash,
					narHash,
					retention: true,
					blob: { fileHash: narHash, fileSize: 4096 }
				}
			]
		}
	])('accepts the $op request with a blob declaration', (value) => {
		expect(commitSessionRequestSchema.parse(value)).toStrictEqual(value);
	});

	it.each([
		{
			shape: 'an empty file',
			blob: { fileHash: narHash, fileSize: 0 },
			path: ['commits', 0, 'blob', 'fileSize']
		},
		{
			shape: 'a fractional size',
			blob: { fileHash: narHash, fileSize: 1.5 },
			path: ['commits', 0, 'blob', 'fileSize']
		},
		{
			shape: 'a hash in another encoding',
			blob: { fileHash: 'sha256-AAAA', fileSize: 4096 },
			path: ['commits', 0, 'blob', 'fileHash']
		},
		{
			shape: 'no size',
			blob: { fileHash: narHash },
			path: ['commits', 0, 'blob', 'fileSize']
		},
		{
			shape: 'an unknown field',
			blob: { fileHash: narHash, fileSize: 4096, compression: 'zstd' },
			path: ['commits', 0, 'blob']
		}
	])('rejects a blob declaration with $shape', ({ blob, path }) => {
		const parsed = commitSessionRequestSchema.safeParse({
			op: 'commit-batch',
			commits: [{ uploadId: 'upload-1', storePathHash, narHash, blob }]
		});

		expect(parsed.error?.issues.map((issue) => issue.path)).toStrictEqual([
			path
		]);
	});

	it.each([
		{
			shape: 'no upload',
			request: { op: 'renew-uploads', pushId: 'a'.repeat(104), uploadIds: [] }
		},
		{
			shape: 'more uploads than a batch',
			request: {
				op: 'renew-uploads',
				pushId: 'a'.repeat(104),
				uploadIds: Array.from(
					{ length: 101 },
					(_, index) => `u-${String(index)}`
				)
			}
		},
		{
			shape: 'no push id',
			request: { op: 'renew-uploads', uploadIds: ['upload-1'] }
		}
	])('rejects a renew-uploads op with $shape', ({ request }) => {
		expect(commitSessionRequestSchema.safeParse(request).success).toBe(false);
	});

	it('round-trips a renew-uploads op and its reply', () => {
		const request = {
			op: 'renew-uploads',
			pushId: 'a'.repeat(104),
			uploadIds: ['upload-1', 'upload-2']
		};
		const frame = {
			ev: 'renewed',
			renewed: ['upload-1'],
			refused: ['upload-2']
		};

		expect({
			request: commitSessionRequestSchema.parse(request),
			frame: commitSessionFrameSchema.parse(frame)
		}).toStrictEqual({ request, frame });
	});
});
