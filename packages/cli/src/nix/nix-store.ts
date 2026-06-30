import type { NixValidPathInfo } from '@cupboard/nix';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { UploadPathNegotiationFields } from '@cupboard/protocol/upload';

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
