import {
	positiveIntSchema,
	referenceSet,
	storePathBasenameSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

/**
The most build inputs that the server records for one path. A publication
can send at most this many.
*/
export const buildInputsMaxLength = 8192;

/**
The most bytes in the JSON array that stores the build inputs of one path.
Cloudflare limits a Durable Object SQLite row, and a string bound to a
statement, to 2 MB. The build inputs take at most half of that, so the row
keeps the other half for its references and other columns.
*/
export const buildInputsMaxJsonBytes = 1_000_000;

/**
Whether the JSON array of `buildInputs` fits in `buildInputsMaxJsonBytes`.
Store path basenames are ASCII, so the length of the JSON text is its size in
bytes.
*/
export function canStoreBuildInputs(buildInputs: readonly string[]): boolean {
	return JSON.stringify(buildInputs).length <= buildInputsMaxJsonBytes;
}

/**
The build inputs of a path: the store path basenames of the outputs that its
derivation used when it was built, as a set in code-unit order.
*/
export const buildInputsSchema = z
	.array(storePathBasenameSchema)
	.max(buildInputsMaxLength)
	.transform((buildInputs) => referenceSet(buildInputs))
	.refine(
		canStoreBuildInputs,
		`The build inputs must fit in ${String(buildInputsMaxJsonBytes)} bytes of JSON`
	);

/**
The version of the client's algorithm that computed a set of build inputs. A
client that changes the algorithm sends a higher version.
*/
export const buildInputsVersionSchema = positiveIntSchema;

/**
Whether a value has both `buildInputs` and `buildInputsVersion`, or neither.
*/
export function hasPairedBuildInputs(value: {
	readonly buildInputs?: unknown;
	readonly buildInputsVersion?: unknown;
}): boolean {
	return (
		(value.buildInputs === undefined) ===
		(value.buildInputsVersion === undefined)
	);
}

export const pairedBuildInputsMessage =
	'Set buildInputs and buildInputsVersion together';

/**
The most bytes of JSON that the references and the build inputs of one path
take together. Both go in the path's narinfo row and in the metadata of its
pending upload, and Cloudflare limits each of those to 2 MB. The other
columns and fields take far less than the remaining 500,000 bytes.
*/
export const pathEdgesMaxJsonBytes = 1_500_000;

/**
Whether the JSON arrays of a path's references and build inputs fit in
`pathEdgesMaxJsonBytes` together. Metadata without build inputs always fits, so
a path that a client without build inputs publishes is not refused.
*/
export function hasStorableEdges(value: {
	readonly references: readonly string[];
	readonly buildInputs?: readonly string[];
}): boolean {
	return (
		value.buildInputs === undefined ||
		JSON.stringify(value.references).length +
			JSON.stringify(value.buildInputs).length <=
			pathEdgesMaxJsonBytes
	);
}

export const storableEdgesMessage = `The references and build inputs must fit in ${String(pathEdgesMaxJsonBytes)} bytes of JSON`;

// A client accepts this token on the credential request when it can send
// `buildInputs` and `buildInputsVersion` in path metadata. Older servers reject
// metadata with a field that they do not know, so the client sends the fields
// only when the server echoes this token. A client that sends them must also
// accept the token in `x-cupboard-accept-capabilities` on every negotiation,
// preview and plan request, which the server refuses otherwise.
export const buildInputsCapability = 'build-inputs-v1';
