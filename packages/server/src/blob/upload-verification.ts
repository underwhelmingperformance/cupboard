import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';

import {
	UploadedObjectChecksumMismatchError,
	UploadedObjectChecksumMissingError,
	UploadedObjectNotFoundError,
	UploadedObjectSizeMismatchError
} from '../errors.ts';
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

export interface UploadedObject {
	readonly size: number;
	readonly checksums: { readonly sha256?: ArrayBuffer };
}

export interface ExpectedNarBlob {
	readonly narHash: NixSha256HashString;
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
}

/**
 * Checks that an R2 object exists and has the expected compressed size and
 * stored SHA-256 checksum. This check does not decompress or verify the NAR
 * contents.
 */
export function verifyStoredBlob(
	object: UploadedObject | undefined,
	expected: ExpectedNarBlob,
	r2Key: R2ObjectKey = narObjectKey(expected.narHash)
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
