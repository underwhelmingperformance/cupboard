import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import {
	type ParsedUploadBlobMetadata,
	type ParsedUploadPathMetadata,
	type ParsedUploadPathNegotiation,
	uploadPathMetadataSchema,
	uploadPathNegotiationSchema
} from '@cupboard/protocol/upload';

import {
	StoredUploadMetadataInvalidError,
	UploadedObjectChecksumMissingError,
	UploadNotPreparedError
} from '../errors.ts';
import { parseStoredJson } from '../http/parse.ts';

// The compressed metadata of the one canonical object served for a NAR hash.
// Read from the object itself so a committed narinfo always advertises the
// encoding actually stored, regardless of which upload promoted it.
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

export function canonicalBlobOf(key: string, object: R2Object): CanonicalBlob {
	const sha256 = object.checksums.sha256;

	if (sha256 === undefined) {
		throw new UploadedObjectChecksumMissingError(key);
	}

	return {
		fileHash: NixSha256Hash.fromDigest(new Uint8Array(sha256)).value,
		fileSize: object.size
	};
}

export function parseStoredUploadMetadata(
	uploadId: string,
	source: string
): ParsedUploadPathMetadata {
	const onInvalid = (cause: Error): StoredUploadMetadataInvalidError =>
		new StoredUploadMetadataInvalidError(uploadId, cause);
	const json = parseStoredJson(source, onInvalid);
	const prepared = uploadPathMetadataSchema.safeParse(json);

	if (prepared.success) {
		return prepared.data;
	}

	// Negotiation stores the path metadata alone until the upload is prepared
	// with its blob details. A well-formed path-only record means the client
	// committed before preparing, not that the stored state is corrupt.
	if (uploadPathNegotiationSchema.safeParse(json).success) {
		throw new UploadNotPreparedError(uploadId);
	}

	throw onInvalid(prepared.error);
}

export function parseStoredUploadPathMetadata(
	uploadId: string,
	source: string
): ParsedUploadPathNegotiation {
	const onInvalid = (cause: Error): StoredUploadMetadataInvalidError =>
		new StoredUploadMetadataInvalidError(uploadId, cause);
	const json = parseStoredJson(source, onInvalid);

	// A row may store the path metadata alone (a streaming upload) or carry the
	// blob fields too (a prepared or reuse row); the commit path needs only the
	// path metadata, so project a full record down to it before validating.
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

export function uploadHeadersFor(
	metadata: ParsedUploadPathMetadata
): Readonly<Record<string, string>> {
	return {
		'x-amz-checksum-sha256': NixSha256Hash.parse(
			metadata.fileHash
		).digestBase64()
	};
}
