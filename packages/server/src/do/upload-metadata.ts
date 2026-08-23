import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import {
	type ParsedUploadBlobMetadata,
	type ParsedUploadPathMetadata,
	type ParsedUploadPathNegotiation,
	type UploadId,
	uploadPathMetadataSchema,
	uploadPathNegotiationSchema
} from '@cupboard/protocol/upload';

import {
	StoredUploadMetadataInvalidError,
	UploadedObjectChecksumMissingError
} from '../errors.ts';
import { type R2ObjectKey } from '../http/http.ts';
import { parseStoredJson } from '../http/parse.ts';

// When a canonical object already exists, use its checksum and size instead of
// the staging upload's values. This keeps `blob_state` aligned with the bytes R2
// serves after a repeated or concurrent promotion.
export interface CanonicalBlob {
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
}

export function commitMetadataFromPathAndBlob(
	path: ParsedUploadPathNegotiation,
	blob: ParsedUploadBlobMetadata
): ParsedUploadPathMetadata {
	return {
		...path,
		fileHash: blob.fileHash,
		fileSize: blob.fileSize,
		compression: blob.compression
	};
}

export function canonicalBlobOf(
	key: R2ObjectKey,
	object: R2Object
): CanonicalBlob {
	const sha256 = object.checksums.sha256;

	if (sha256 === undefined) {
		throw new UploadedObjectChecksumMissingError(key);
	}

	return {
		fileHash: NixSha256Hash.fromDigest(new Uint8Array(sha256)).value,
		fileSize: object.size
	};
}

export function parseStoredUploadPathMetadata(
	uploadId: UploadId,
	source: string
): ParsedUploadPathNegotiation {
	const onInvalid = (cause: Error): StoredUploadMetadataInvalidError =>
		new StoredUploadMetadataInvalidError(uploadId, cause);
	const json = parseStoredJson(source, onInvalid);

	// A row may store the path metadata alone (a streaming upload) or carry the
	// blob fields too (a reuse row); the commit path needs only the path
	// metadata, so project a full record down to it before validating.
	const full = uploadPathMetadataSchema.safeParse(json);

	if (full.success) {
		const {
			storePathHash,
			storePath,
			narHash,
			narSize,
			references,
			deriver,
			ca
		} = full.data;

		return {
			storePathHash,
			storePath,
			narHash,
			narSize,
			references,
			deriver,
			ca
		};
	}

	const path = uploadPathNegotiationSchema.safeParse(json);

	if (path.success) {
		return path.data;
	}

	throw onInvalid(path.error);
}
