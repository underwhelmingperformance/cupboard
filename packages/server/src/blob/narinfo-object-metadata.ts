import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NarInfoGeneration,
	type NixSha256HashString,
	type SigningKeyGeneration,
	storePathMaxLength,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';

import { narObjectKeyPrefix, narObjectKeySuffix } from '../http/http.ts';

// Cloudflare limits the entire SQLite row, not just each text value, to 2 MB:
// https://developers.cloudflare.com/durable-objects/platform/limits/
// Use 2 MiB conservatively (D1 specifies the smaller 2,000,000 bytes). References,
// deriver, CA and signatures share that budget, including persisted values that
// predate today's ingest caps. JSON escaping cannot enlarge rendered UTF-8.
// References render no larger than their JSON; each signature can double it:
// an empty JSON entry costs at least three bytes, versus six for `Sig: \n`.
// buildNarInfo reads signatures from sigs_json; initial signing and key backfill
// persist generated signatures before publication, so they share the row bound.
const persistedRowMaxBytes = 2 * 1024 * 1024;
const persistedRenderMaxBytes = 2 * persistedRowMaxBytes;

// NarInfo.render's remaining labels/newlines and ASCII values: one full path,
// two SHA-256 hashes, two safe-integer sizes, and narObjectKey's hash plus a
// dot and at most 19 decimal digits for a persisted SQLite int64 incarnation.
const hashBytes = 'sha256:'.length + 52;
const fixedProjectionMaxBytes =
	new TextEncoder().encode(
		'StorePath: \nURL: \nCompression: zstd\nFileHash: \nFileSize: \nNarHash: \nNarSize: \nReferences: \nDeriver: \nCA: \n'
	).byteLength +
	storePathMaxLength +
	3 * hashBytes +
	2 * String(Number.MAX_SAFE_INTEGER).length +
	narObjectKeyPrefix.length +
	narObjectKeySuffix.length +
	1 +
	19;

/**
Internal authority probe bound, independent of public metadata paging.
*/
export const narInfoProjectionMaxBytes =
	persistedRenderMaxBytes + fixedProjectionMaxBytes;

/**
Identifies one commit of a store path in one cache.

Narinfo objects are keyed by store path, so publishing a new commit
overwrites the previous commit's object. Narinfo generations increase and are
never reused for a stored name and path, even after the stored name is
deleted and registered again. The generation therefore identifies the commit.
The reference edge also records the NAR hash. Readers compare that hash with
the object's metadata before serving it.
*/
export interface NarInfoReferenceVersion {
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

/**
The commit, NAR URL and signing-key generation recorded in a published
narinfo object's metadata.
*/
export interface NarInfoObjectVersion extends NarInfoReferenceVersion {
	readonly narUrl: string;
	readonly signatureGeneration: SigningKeyGeneration;
}

export interface NarInfoObjectMetadata {
	readonly [key: string]: string;
	readonly generation: string;
	readonly narHash: string;
	readonly narUrl: string;
	readonly signatureGeneration: string;
}

export function narInfoObjectMetadata(
	version: NarInfoObjectVersion
): NarInfoObjectMetadata {
	return {
		generation: String(version.generation),
		narHash: version.narHash,
		narUrl: version.narUrl,
		signatureGeneration: String(version.signatureGeneration)
	};
}

export function recordedNarInfoMetadata(
	object: Pick<R2Object, 'customMetadata'> | null
): NarInfoObjectMetadata | undefined {
	const generation = object?.customMetadata?.generation;
	const narHash = object?.customMetadata?.narHash;
	const narUrl = object?.customMetadata?.narUrl;
	const signatureGeneration = object?.customMetadata?.signatureGeneration;

	if (
		generation === undefined ||
		narHash === undefined ||
		narUrl === undefined ||
		signatureGeneration === undefined
	) {
		return undefined;
	}

	return { generation, narHash, narUrl, signatureGeneration };
}

/**
Whether recorded metadata describes `commit`.

Returns false for absent metadata. This server records the commit in every
published narinfo object, so callers require the metadata before serving an
object.
*/
export function isMetadataOfCommit(
	metadata: NarInfoObjectMetadata | undefined,
	commit: NarInfoReferenceVersion
): boolean {
	return (
		metadata?.generation === String(commit.generation) &&
		metadata.narHash === commit.narHash
	);
}

export function isNarInfoObjectOfCommit(
	object: R2Object | null,
	commit: NarInfoReferenceVersion
): boolean {
	return isMetadataOfCommit(recordedNarInfoMetadata(object), commit);
}

/**
Whether an object's commit, NAR URL and signing-key generation match the
supplied version. Republication rewrites the object after a signing-key
change or a new NAR incarnation.
*/
export function isNarInfoObjectVersion(
	object: R2Object | null,
	version: NarInfoObjectVersion
): boolean {
	const metadata = recordedNarInfoMetadata(object);

	return (
		isMetadataOfCommit(metadata, version) &&
		metadata?.narUrl === version.narUrl &&
		metadata.signatureGeneration === String(version.signatureGeneration)
	);
}

/**
Metadata whose path and NAR identity have been checked against the R2 body.
*/
export interface NarInfoProjection {
	readonly metadata: NarInfoObjectMetadata | undefined;
	readonly storePath: StorePathString;
}

/**
Reads at most the admitted/persisted render bound. A HEAD proves a commit
version, not which full path the served body describes. Malformed projections
and provider failures fail the probe rather than becoming repairable absence.
*/
export async function readNarInfoProjection(
	object: Pick<R2ObjectBody, 'customMetadata' | 'size' | 'body'> | null
): Promise<NarInfoProjection | undefined> {
	if (object === null) {
		return undefined;
	}
	const metadata = recordedNarInfoMetadata(object);
	if (object.size > narInfoProjectionMaxBytes) {
		await object.body.cancel();
		throw new RangeError(
			'The narinfo projection exceeds the internal byte limit'
		);
	}
	const reader = object.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	const parts: string[] = [];
	let bytes = 0;
	let isComplete = false;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) {
				isComplete = true;
				parts.push(decoder.decode());
				break;
			}
			const value: unknown = result.value;
			if (!(value instanceof Uint8Array)) {
				throw new TypeError('The R2 narinfo body returned a non-byte chunk');
			}
			bytes += value.byteLength;
			if (bytes > narInfoProjectionMaxBytes) {
				throw new RangeError(
					'The narinfo projection exceeds the internal byte limit'
				);
			}
			parts.push(decoder.decode(value, { stream: true }));
		}
	} finally {
		try {
			if (!isComplete) {
				await reader.cancel();
			}
		} finally {
			reader.releaseLock();
		}
	}
	const narInfo = NarInfo.parse(parts.join(''));
	if (
		metadata !== undefined &&
		(narInfo.narHash.toString() !== metadata.narHash ||
			narInfo.url !== metadata.narUrl)
	) {
		throw new Error(
			'The narinfo projection body disagrees with its recorded NAR identity'
		);
	}
	return {
		metadata,
		storePath: storePathSchema.parse(narInfo.storePath.value)
	};
}
