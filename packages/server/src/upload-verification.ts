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

/**
 * Confirms a freshly uploaded object matches the metadata the client
 * negotiated: it exists, its size is exact, and its SHA-256 is the promised NAR
 * file hash. Each failure raises a typed error carrying the offending values.
 */
export function verifyUploadedObject(
	object: UploadedObject | undefined,
	expectedSize: number,
	metadata: UploadPathMetadataFields
): void {
	const r2Key = narObjectKey(metadata.narHash);

	if (object === undefined) {
		throw new UploadedObjectNotFoundError(r2Key);
	}

	if (object.size !== expectedSize) {
		throw new UploadedObjectSizeMismatchError(r2Key, expectedSize, object.size);
	}

	const checksum = object.checksums.sha256;

	if (checksum === undefined) {
		throw new UploadedObjectChecksumMissingError(r2Key);
	}

	const actual = NixSha256Hash.fromDigest(new Uint8Array(checksum)).toString();

	if (actual === metadata.fileHash) {
		return;
	}

	throw new UploadedObjectChecksumMismatchError(
		r2Key,
		metadata.fileHash,
		actual
	);
}
