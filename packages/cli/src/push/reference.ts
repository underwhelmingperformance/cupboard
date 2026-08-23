import { NarInfo } from '@cupboard/nix-store/narinfo';
import { type StorePathHash } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { type UploadPathMetadataFields } from '@cupboard/protocol/upload';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';
import { readResponseText } from '@cupboard/shared/response-body';

import { resilientFetcher } from '../client/transport.ts';
import {
	NarInfoUnavailableError,
	NarInfoUnparsableError,
	ReadCredentialPairError
} from '../errors.ts';

export interface ReferenceSource {
	readonly url: URL;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

export interface ReferenceFetchDependencies {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

const maximumNarInfoBytes = 1024 * 1024;

/**
 * The destination signs the narinfo it serves, so upload metadata excludes the
 * source signatures. The receipt retains them because they cover the unchanged
 * path fingerprint and remain independently verifiable.
 */
export interface ReferenceMetadata {
	readonly upload: UploadPathMetadataFields;
	readonly signatures: readonly string[];
}

/**
 * Fetches and parses `<store-path-hash>.narinfo` from a reference source. The
 * result retains source signatures separately from upload metadata. A
 * non-success response throws {@link NarInfoUnavailableError}; invalid narinfo
 * text throws {@link NarInfoUnparsableError}.
 */
export async function fetchReferenceMetadata(
	source: ReferenceSource,
	storePathHash: StorePathHash,
	dependencies: ReferenceFetchDependencies = {}
): Promise<ReferenceMetadata> {
	const fetcher = dependencies.fetch ?? resilientFetcher('replay-safe');
	const target = new URL(
		`${canonicalHref(source.url)}/${storePathHash}.narinfo`
	);
	const response = await fetcher(target, {
		headers: referenceAuthHeaders(source),
		signal: dependencies.signal
	});

	if (!response.ok) {
		await discardResponseBody(response);
		throw new NarInfoUnavailableError(target, response.status);
	}

	const body = await readResponseText(response, {
		description: `Narinfo response from ${target.href}`,
		maximumBytes: maximumNarInfoBytes,
		signal: dependencies.signal
	});

	try {
		const narInfo = NarInfo.parse(body);

		return {
			upload: referenceMetadata(narInfo),
			signatures: [...narInfo.sigs]
		};
	} catch (error) {
		throw new NarInfoUnparsableError(target, { cause: error });
	}
}

function referenceMetadata(narInfo: NarInfo): UploadPathMetadataFields {
	return {
		storePathHash: narInfo.storePath.hash,
		storePath: narInfo.storePath.value,
		narHash: narInfo.narHash.toString(),
		narSize: narInfo.narSize,
		references: [...narInfo.references].toSorted(byCodeUnit),
		...(narInfo.deriver !== undefined && { deriver: narInfo.deriver }),
		...(narInfo.ca !== undefined && { ca: narInfo.ca }),
		fileHash: narInfo.fileHash.toString(),
		fileSize: narInfo.fileSize,
		compression: narInfo.compression
	};
}

function referenceAuthHeaders(source: ReferenceSource): Headers {
	const headers = new Headers();

	if (source.readUser === undefined && source.readPassword === undefined) {
		return headers;
	}

	if (source.readUser === undefined || source.readPassword === undefined) {
		throw new ReadCredentialPairError();
	}

	headers.set(
		'authorization',
		basicAuthHeader({ user: source.readUser, password: source.readPassword })
			.authorization
	);

	return headers;
}
