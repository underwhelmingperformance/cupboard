import { NixSha256Hash, type UploadPathMetadataFields } from '@cupboard/shared';
import { describe, expect, it } from 'vitest';

import {
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadedObjectNotFoundError,
	UploadedObjectSizeMismatchError
} from './errors.ts';
import {
	type UploadedObject,
	verifyUploadedObject
} from './upload-verification.ts';

const digest = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const otherDigest = Uint8Array.from({ length: 32 }, (_, index) => index + 100);
const fileHash = NixSha256Hash.fromDigest(digest).toString();
const narHash = `sha256:${'1'.repeat(52)}`;
const r2Key = `nar/${narHash}.nar.zst`;

const metadata: UploadPathMetadataFields = {
	storePathHash: '0'.repeat(32),
	storePath: `/nix/store/${'0'.repeat(32)}-app`,
	narHash,
	narSize: 1234,
	references: [],
	fileHash,
	fileSize: 4,
	compression: 'zstd'
};

function uploadedObject(
	overrides: Partial<UploadedObject> = {}
): UploadedObject {
	return { size: 4, checksums: { sha256: digest.buffer }, ...overrides };
}

function rejection<E extends Error>(
	function_: () => void,
	type: abstract new (...arguments_: never[]) => E
): E {
	try {
		function_();
	} catch (error) {
		expect(error).toBeInstanceOf(type);

		return error as E;
	}

	throw new Error('expected verifyUploadedObject to throw');
}

describe('verifyUploadedObject', () => {
	it('accepts an object that matches the metadata', () => {
		expect(() => {
			verifyUploadedObject(uploadedObject(), 4, metadata);
		}).not.toThrow();
	});

	it('rejects a missing object with its key', () => {
		const error = rejection(() => {
			verifyUploadedObject(undefined, 4, metadata);
		}, UploadedObjectNotFoundError);

		expect(error.r2Key).toBe(r2Key);
	});

	it('rejects a size mismatch with the expected and actual sizes', () => {
		const error = rejection(() => {
			verifyUploadedObject(uploadedObject({ size: 9 }), 4, metadata);
		}, UploadedObjectSizeMismatchError);

		expect({
			r2Key: error.r2Key,
			expectedSize: error.expectedSize,
			actualSize: error.actualSize
		}).toStrictEqual({ r2Key, expectedSize: 4, actualSize: 9 });
	});

	it('rejects an object with no checksum', () => {
		const error = rejection(() => {
			verifyUploadedObject(uploadedObject({ checksums: {} }), 4, metadata);
		}, UploadedObjectChecksumMissingError);

		expect(error.r2Key).toBe(r2Key);
	});

	it('rejects a checksum mismatch with the expected and actual hashes', () => {
		const error = rejection(() => {
			verifyUploadedObject(
				uploadedObject({ checksums: { sha256: otherDigest.buffer } }),
				4,
				metadata
			);
		}, UploadedObjectChecksumMismatchError);

		expect({
			r2Key: error.r2Key,
			expectedFileHash: error.expectedFileHash,
			actualFileHash: error.actualFileHash
		}).toStrictEqual({
			r2Key,
			expectedFileHash: fileHash,
			actualFileHash: NixSha256Hash.fromDigest(otherDigest).toString()
		});
	});
});
