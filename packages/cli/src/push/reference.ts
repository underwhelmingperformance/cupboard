import { NarInfo } from '@cupboard/nix-store/narinfo';
import { type StorePathHash } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { type UploadPathMetadataFields } from '@cupboard/protocol/upload';
import { basicAuthHeader, type ReadUser } from '@cupboard/shared/http';

import { resilientFetcher } from '../client/transport.ts';
import {
	NarInfoUnavailableError,
	NarInfoUnparsableError,
	ReadCredentialPairError
} from '../errors.ts';

/**
A served cache endpoint that path metadata is read from.
*/
export interface ReferenceSource {
	readonly url: URL;
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
}

export interface ReferenceFetchDependencies {
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

/**
 * One reference entry's served narinfo, in the two forms a push needs it: the
 * fields the negotiate and commit shapes carry, and the signatures the source
 * published over the path.
 *
 * The upload fields carry no signature because the destination signs the
 * narinfo it serves itself. The receipt records the source's signatures
 * separately: they are made over the path's fingerprint, which the destination
 * serves unchanged, so a reader can check them against keys it trusts.
 */
export interface ReferenceMetadata {
	readonly upload: UploadPathMetadataFields;
	readonly signatures: readonly string[];
}

/**
 * Reads one path's served narinfo from the reference source and maps it into
 * the metadata the negotiate and commit shapes carry: the path pair, NAR hash
 * and size, references as sorted basenames, the deriver basename and content
 * address, plus the blob's file hash, file size and compression. A response
 * that is not OK refuses with {@link NarInfoUnavailableError} carrying the
 * status; a body that does not parse as a narinfo refuses with
 * {@link NarInfoUnparsableError}.
 */
export async function fetchReferenceMetadata(
	source: ReferenceSource,
	storePathHash: StorePathHash,
	dependencies: ReferenceFetchDependencies = {}
): Promise<ReferenceMetadata> {
	const fetcher = dependencies.fetch ?? resilientFetcher();
	const target = new URL(
		`${canonicalHref(source.url)}/${storePathHash}.narinfo`
	);
	const response = await fetcher(target, {
		headers: referenceAuthHeaders(source),
		signal: dependencies.signal
	});

	if (!response.ok) {
		throw new NarInfoUnavailableError(target, response.status);
	}

	const body = await response.text();

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
