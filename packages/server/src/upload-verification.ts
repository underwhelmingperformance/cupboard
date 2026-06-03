import { NixSha256Hash, type UploadPathMetadataFields } from '@cupboard/shared';

import {
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadedObjectNotFoundError,
	UploadedObjectSizeMismatchError
} from './errors.ts';
import { narObjectKey } from './http.ts';

// The subset of an R2 object the commit step verifies before trusting it: its
// byte length and the SHA-256 the store computed on upload.
export interface UploadedObject {
	readonly size: number;
	readonly checksums: { readonly sha256?: ArrayBuffer };
}

// What a stored NAR blob must satisfy: it exists, its size is exact, and its
// SHA-256 equals the recorded file hash.
export interface ExpectedNarBlob {
	readonly narHash: string;
	readonly fileHash: string;
	readonly fileSize: number;
}

/**
 * Confirms a stored R2 object matches the NAR blob it is meant to hold: it
 * exists, its size is exact, and its SHA-256 is the recorded file hash. Each
 * failure raises a typed error carrying the offending values. The commit step
 * verifies a freshly uploaded object; the storage check re-verifies a committed
 * one.
 */
export function verifyStoredBlob(
	object: UploadedObject | undefined,
	expected: ExpectedNarBlob,
	r2Key: string = narObjectKey(expected.narHash)
): void {
	if (object === undefined) {
		throw new UploadedObjectNotFoundError(r2Key);
	}

	if (object.size !== expected.fileSize) {
		throw new UploadedObjectSizeMismatchError(
			r2Key,
			expected.fileSize,
			object.size
		);
	}

	const checksum = object.checksums.sha256;

	if (checksum === undefined) {
		throw new UploadedObjectChecksumMissingError(r2Key);
	}

	const actual = NixSha256Hash.fromDigest(new Uint8Array(checksum)).toString();

	if (actual === expected.fileHash) {
		return;
	}

	throw new UploadedObjectChecksumMismatchError(
		r2Key,
		expected.fileHash,
		actual
	);
}

/**
 * Confirms a freshly uploaded object matches the metadata the client
 * negotiated.
 */
export function verifyUploadedObject(
	object: UploadedObject | undefined,
	expectedSize: number,
	metadata: UploadPathMetadataFields,
	r2Key: string
): void {
	verifyStoredBlob(
		object,
		{
			narHash: metadata.narHash,
			fileHash: metadata.fileHash,
			fileSize: expectedSize
		},
		r2Key
	);
}
