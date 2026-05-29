import {
	StorePath,
	type UploadPathMetadataFields,
	type UploadPathNegotiationFields
} from '@cupboard/shared';

import type { CompressedNarBlob } from './blob.ts';
import type { NixSha256Hash } from './nar.ts';

export interface NixValidPathInfo {
	readonly storePath: string;
	readonly narHash: NixSha256Hash;
	readonly narSize: number;
	readonly references: readonly string[];
	readonly deriver?: string;
	readonly ca?: string;
	readonly signatures: readonly string[];
}

export interface NixStoreClient {
	resolveClosure(
		storePaths: readonly string[]
	): Promise<readonly NixValidPathInfo[]>;
	queryPathInfo(storePath: string): Promise<NixValidPathInfo>;
}

export interface PreparedStorePath {
	readonly metadata: UploadPathMetadataFields;
	readonly signatures: readonly string[];
}

export abstract class NixStoreError extends Error {}

export class NixStorePathNotFoundError extends NixStoreError {
	constructor(public readonly storePath: string) {
		super(`Nix store path is not registered locally: ${storePath}`);
		this.name = 'NixStorePathNotFoundError';
	}
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
