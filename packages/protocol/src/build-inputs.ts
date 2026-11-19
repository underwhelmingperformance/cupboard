import {
	positiveIntSchema,
	referenceSet,
	storePathBasenameSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { storePathHashOf } from '@cupboard/nix-store/store-path';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

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

/**
The most entries in one `build-inputs` request.
*/
export const buildInputsRecordMaxEntries = 128;

/**
The most build inputs in one `build-inputs` request, counted across its
entries. A request at this limit can bring one path to the most build inputs
that a path can have.
*/
export const buildInputsRecordMaxBuildInputs = buildInputsMaxLength;

/**
The most build inputs that one `build-inputs` request reads, counting both
those stored on its entries' rows and those that it gives. A row never has
more than `buildInputsMaxLength` and a request gives at most
`buildInputsRecordMaxBuildInputs`, so the first entry always fits.
*/
export const buildInputsRecordWorkBudget = 4 * buildInputsMaxLength;

export const buildInputsPageLimitErrorCode = 'BUILD_INPUTS_PAGE_LIMIT_EXCEEDED';
export const buildInputsPageLimitErrorDataSchema = z.strictObject({
	maxEntries: countSchema,
	maxBuildInputs: countSchema
});

const buildInputsRecordEntrySchema = z.strictObject({
	storePath: storePathSchema,
	buildInputs: z
		.array(storePathBasenameSchema)
		.transform((buildInputs) => referenceSet(buildInputs)),
	buildInputsVersion: buildInputsVersionSchema
});
export type BuildInputsRecordEntry = z.output<
	typeof buildInputsRecordEntrySchema
>;

// The schema leaves the number of entries and of build inputs open, so a
// request above the limits receives the typed refusal. Two entries for one
// path would make the result depend on their order, so each store-path hash
// appears once.
export const buildInputsRecordBodySchema = z.strictObject({
	entries: z
		.array(buildInputsRecordEntrySchema)
		.min(1)
		.superRefine((entries, ctx) => {
			const seen = new Set<string>();

			for (const [index, entry] of entries.entries()) {
				const storePathHash = storePathHashOf(entry.storePath);

				if (storePathHash === undefined) {
					continue;
				}

				if (seen.has(storePathHash)) {
					ctx.addIssue({
						code: 'custom',
						path: [index, 'storePath'],
						message: `store path hash '${storePathHash}' appears more than once in the request`
					});
				}

				seen.add(storePathHash);
			}
		})
});
export type BuildInputsRecordBody = z.output<
	typeof buildInputsRecordBodySchema
>;

// One result for each entry, in request order. `recorded` means that the
// row's build inputs or version changed, and `unchanged` that the row already
// had every given build input at the same or a higher version. `absent` means
// that the cache has no narinfo row for the store path. `limit-exceeded`
// means that the row would go over `buildInputsMaxLength` build inputs,
// `buildInputsMaxJsonBytes`, or `pathEdgesMaxJsonBytes` with its references.
// `invalid-stored` means that the row's stored build inputs cannot be read or
// list more than `buildInputsMaxLength`. `deferred` means that the request
// reached `buildInputsRecordWorkBudget` before the entry, so the client sends
// the entry again in a later request. Only `recorded` changes the row.
export const buildInputsRecordResultSchema = z.strictObject({
	storePath: storePathSchema,
	status: z.enum([
		'recorded',
		'unchanged',
		'absent',
		'limit-exceeded',
		'invalid-stored',
		'deferred'
	])
});
export type BuildInputsRecordResult = z.output<
	typeof buildInputsRecordResultSchema
>;

export const buildInputsRecordResponseSchema = z.strictObject({
	entries: z.array(buildInputsRecordResultSchema)
});
export type BuildInputsRecordResponse = z.output<
	typeof buildInputsRecordResponseSchema
>;
