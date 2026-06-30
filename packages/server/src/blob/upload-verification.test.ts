import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { nixSha256HashSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadedObjectNotFoundError,
	UploadedObjectSizeMismatchError
} from '../errors.ts';

import {
	type ExpectedNarBlob,
	type UploadedObject,
	verifyStoredBlob
} from './upload-verification.ts';

const digest = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const otherDigest = Uint8Array.from({ length: 32 }, (_, index) => index + 100);
const fileHash = NixSha256Hash.fromDigest(digest).value;
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
// A staging key, distinct from the canonical nar/<hash> key, to prove the error
// reports the object actually inspected rather than the canonical default.
const r2Key = 'staging/upload-1.nar.zst';

const expected: ExpectedNarBlob = { narHash, fileHash, fileSize: 4 };

function uploadedObject(
	overrides: Partial<UploadedObject> = {}
): UploadedObject {
	return { size: 4, checksums: { sha256: digest.buffer }, ...overrides };
}

function thrownBy(function_: () => void): unknown {
	let thrown: unknown;

	try {
		function_();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

function acceptedBy(function_: () => void): { readonly accepted: true } {
	function_();

	return { accepted: true };
}

describe('verifyStoredBlob', () => {
	it('accepts an object that matches the expected blob', () => {
		expect(
			acceptedBy(() => {
				verifyStoredBlob(uploadedObject(), expected, r2Key);
			})
		).toStrictEqual({ accepted: true });
	});

	it('rejects a missing object with its key', () => {
		const error = thrownBy(() => {
			verifyStoredBlob(undefined, expected, r2Key);
		});

		expect(error).toBeInstanceOf(UploadedObjectNotFoundError);
		if (!(error instanceof UploadedObjectNotFoundError)) {
			throw error;
		}
		expect({ name: error.name, r2Key: error.r2Key }).toStrictEqual({
			name: UploadedObjectNotFoundError.name,
			r2Key
		});
	});

	it('rejects a size mismatch with the expected and actual sizes', () => {
		const error = thrownBy(() => {
			verifyStoredBlob(uploadedObject({ size: 9 }), expected, r2Key);
		});

		expect(error).toBeInstanceOf(UploadedObjectSizeMismatchError);
		if (!(error instanceof UploadedObjectSizeMismatchError)) {
			throw error;
		}
		expect({
			name: error.name,
			r2Key: error.r2Key,
			expectedSize: error.expectedSize,
			actualSize: error.actualSize
		}).toStrictEqual({
			name: UploadedObjectSizeMismatchError.name,
			r2Key,
			expectedSize: 4,
			actualSize: 9
		});
	});

	it('rejects an object with no checksum', () => {
		const error = thrownBy(() => {
			verifyStoredBlob(uploadedObject({ checksums: {} }), expected, r2Key);
		});

		expect(error).toBeInstanceOf(UploadedObjectChecksumMissingError);
		if (!(error instanceof UploadedObjectChecksumMissingError)) {
			throw error;
		}
		expect({ name: error.name, r2Key: error.r2Key }).toStrictEqual({
			name: UploadedObjectChecksumMissingError.name,
			r2Key
		});
	});

	it('rejects a checksum mismatch with the expected and actual hashes', () => {
		const error = thrownBy(() => {
			verifyStoredBlob(
				uploadedObject({ checksums: { sha256: otherDigest.buffer } }),
				expected,
				r2Key
			);
		});

		expect(error).toBeInstanceOf(UploadedObjectChecksumMismatchError);
		if (!(error instanceof UploadedObjectChecksumMismatchError)) {
			throw error;
		}
		expect({
			name: error.name,
			r2Key: error.r2Key,
			expectedFileHash: error.expectedFileHash,
			actualFileHash: error.actualFileHash
		}).toStrictEqual({
			name: UploadedObjectChecksumMismatchError.name,
			r2Key,
			expectedFileHash: fileHash,
			actualFileHash: NixSha256Hash.fromDigest(otherDigest).toString()
		});
	});
});
