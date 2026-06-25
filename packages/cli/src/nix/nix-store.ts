import type { NixValidPathInfo } from '@cupboard/nix';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	UploadPathMetadataFields,
	UploadPathNegotiationFields
} from '@cupboard/protocol/upload';

import type { CompressedNarBlob } from './blob.ts';

export interface PreparedStorePath {
	readonly metadata: UploadPathMetadataFields;
	readonly signatures: readonly string[];
}

export function prepareStorePathMetadata(
	pathInfo: NixValidPathInfo,
	blob: CompressedNarBlob
): PreparedStorePath {
	return {
		metadata: {
			...prepareStorePathNegotiation(pathInfo),
			fileHash: blob.fileHash.toString(),
			fileSize: blob.fileSize,
			compression: blob.compression
		},
		signatures: pathInfo.signatures
	};
}

export function prepareStorePathNegotiation(
	pathInfo: NixValidPathInfo
): UploadPathNegotiationFields {
	return {
		storePathHash: StorePath.hash(pathInfo.storePath),
		storePath: pathInfo.storePath,
		narHash: pathInfo.narHash.toString(),
		narSize: pathInfo.narSize,
		references: StorePath.referenceBasenames(pathInfo.references),
		deriver: normaliseOptionalStorePathBasename(pathInfo.deriver),
		ca: pathInfo.ca
	};
}

function normaliseOptionalStorePathBasename(
	value: string | undefined
): string | undefined {
	if (value === undefined || value === '') {
		return undefined;
	}

	return StorePath.basename(value);
}
