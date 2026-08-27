import {
	type NarInfoGeneration,
	type NixSha256HashString,
	type SigningKeyGeneration
} from '@cupboard/nix-store/scalars';

/**
 * Identifies one commit of a store path in one cache.
 *
 * Narinfo objects are keyed by store path, so publishing a new commit
 * overwrites the previous commit's object. Narinfo generations increase and are
 * never reused for a stored name and path, even after the stored name is
 * deleted and registered again. The generation therefore identifies the commit.
 * The reference edge also records the NAR hash. Readers compare that hash with
 * the object's metadata before serving it.
 */
export interface NarInfoReferenceVersion {
	readonly generation: NarInfoGeneration;
	readonly narHash: NixSha256HashString;
}

/**
 * The commit, NAR URL and signing-key generation recorded in a published
 * narinfo object's metadata.
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
	object: R2Object | null
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
 * Whether recorded metadata describes `commit`.
 *
 * Returns false for absent metadata. This server records the commit in every
 * published narinfo object, so callers require the metadata before serving an
 * object.
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
 * Whether an object's commit, NAR URL and signing-key generation match the
 * supplied version. Republication rewrites the object after a signing-key
 * change or a new NAR incarnation.
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
