import {
	authKeyIdSchema,
	cacheScopeSchema,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { isoTimestampSchema } from './scalars.ts';

export const signingKeySchema = z.strictObject({
	id: signingKeyIdSchema,
	publicKey: z.string(),
	createdAt: isoTimestampSchema
});
export type SigningKey = z.output<typeof signingKeySchema>;

export const backfillFailureSchema = z.strictObject({
	operation: z.enum(['resigning', 'cache-purge']),
	failedAt: isoTimestampSchema,
	message: z.string()
});
export type BackfillFailure = z.output<typeof backfillFailureSchema>;

// The part of a stored narinfo that keeps the backfill from publishing it: an
// invalid narinfo field, a hash that does not parse, a cache that is missing
// from the cache registry, a NAR record that is missing from the deployment,
// or `unknown` when rendering fails on no single field.
export const backfillEntryDefectSchema = z.enum([
	'storePath',
	'url',
	'compression',
	'fileHash',
	'fileSize',
	'narHash',
	'narSize',
	'references',
	'deriver',
	'ca',
	'sigs',
	'hash',
	'cacheIdentity',
	'blobState',
	'unknown'
]);
export type BackfillEntryDefect = z.output<typeof backfillEntryDefectSchema>;

// A description of each defect, completing "the narinfo cannot be published
// because ...".
export const backfillEntryDefectText: Readonly<
	Record<BackfillEntryDefect, string>
> = {
	storePath: 'its store path is invalid',
	url: 'its URL is invalid',
	compression: 'its compression is invalid',
	fileHash: 'its file hash is invalid',
	fileSize: 'its file size is invalid',
	narHash: 'its NAR hash is invalid',
	narSize: 'its NAR size is invalid',
	references: 'its references are invalid',
	deriver: 'its deriver is invalid',
	ca: 'its content address is invalid',
	sigs: 'its signatures are invalid',
	hash: 'a hash does not parse',
	cacheIdentity: 'its cache is missing from the cache registry',
	blobState: 'its NAR record is missing from the deployment',
	unknown: 'it does not render as a narinfo'
};

/**
Where each defect is stored, which decides how it can be repaired. `narinfo`
is the tenant's narinfo row, which a new push of the path writes again after
`cupboard delete`. `blob` is the deployment's shared record of the NAR, which
a new push reuses. `cache` is the tenant's cache registry. `missingBlob` is a
NAR record that is missing, so the cache cannot serve the NAR. `either` is a
defect that the backfill cannot attribute to one of them.
*/
export const backfillEntryDefectRecord: Readonly<
	Record<
		BackfillEntryDefect,
		'narinfo' | 'blob' | 'cache' | 'missingBlob' | 'either'
	>
> = {
	storePath: 'narinfo',
	url: 'blob',
	compression: 'blob',
	fileHash: 'blob',
	fileSize: 'blob',
	narHash: 'narinfo',
	narSize: 'narinfo',
	references: 'narinfo',
	deriver: 'narinfo',
	ca: 'narinfo',
	sigs: 'narinfo',
	hash: 'either',
	cacheIdentity: 'cache',
	blobState: 'missingBlob',
	unknown: 'either'
};

// A store path whose narinfo the backfill set aside because the narinfo cannot
// be published. Its narinfo keeps the signatures that it had before the
// rotation. `storePath` is the stored value as diagnostic text: a narinfo set
// aside for an invalid store path has one that does not parse. `cache` is
// absent when the narinfo's cache is missing from the cache registry.
const unpublishableStorePathSchema = z.strictObject({
	storePath: z.string(),
	cache: cacheScopeSchema.optional(),
	defect: backfillEntryDefectSchema,
	setAsideAt: isoTimestampSchema
});

// The number of store paths that the backfill set aside, and the first of
// them in store-path order. A server sends this field only when it set aside
// at least one path, and servers that predate it never send it.
export const unpublishableStorePathsSchema = z.strictObject({
	total: z.number().int().positive(),
	storePaths: z.array(unpublishableStorePathSchema)
});
export type UnpublishableStorePaths = z.output<
	typeof unpublishableStorePathsSchema
>;

const runningBackfillSchema = z.strictObject({
	state: z.literal('running'),
	startedAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	resigned: z.number().int().nonnegative(),
	remaining: z.number().int().nonnegative(),
	unpublishable: unpublishableStorePathsSchema.optional()
});

const rotatedSigningKeyEntrySchema = z.strictObject({
	state: z.literal('signing'),
	key: signingKeySchema,
	backfill: runningBackfillSchema
});

const retryingBackfillSchema = z.strictObject({
	state: z.literal('retrying'),
	startedAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	resigned: z.number().int().nonnegative(),
	remaining: z.number().int().nonnegative(),
	failure: backfillFailureSchema,
	unpublishable: unpublishableStorePathsSchema.optional()
});

const completeBackfillSchema = z.strictObject({
	state: z.literal('complete'),
	startedAt: isoTimestampSchema,
	completedAt: isoTimestampSchema,
	resigned: z.number().int().nonnegative(),
	unpublishable: unpublishableStorePathsSchema.optional()
});

export const backfillStatusSchema = z.discriminatedUnion('state', [
	runningBackfillSchema,
	retryingBackfillSchema,
	completeBackfillSchema
]);
export type BackfillStatus = z.output<typeof backfillStatusSchema>;

// `unpublishableSigned` is the number of store paths that a signature update
// set aside and whose published narinfo has this key's signature. A server
// sends it only when the number is positive.
const unpublishableSignedSchema = z.number().int().positive().optional();

export const signingKeyEntrySchema = z.discriminatedUnion('state', [
	z.strictObject({
		state: z.literal('signing'),
		key: signingKeySchema,
		backfill: backfillStatusSchema.optional(),
		unpublishableSigned: unpublishableSignedSchema
	}),
	z.strictObject({
		state: z.literal('published-only'),
		key: signingKeySchema,
		unpublishableSigned: unpublishableSignedSchema
	})
]);
export type SigningKeyEntry = z.output<typeof signingKeyEntrySchema>;

export const keyListResponseSchema = z.strictObject({
	keys: z.array(signingKeyEntrySchema)
});
export type KeyListResponse = z.output<typeof keyListResponseSchema>;

export const keyRotateResponseSchema = z.strictObject({
	rotated: rotatedSigningKeyEntrySchema,
	keys: z.array(signingKeyEntrySchema)
});
export type KeyRotateResponse = z.output<typeof keyRotateResponseSchema>;

export const keyRetireResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	state: z.enum(['published-only', 'absent'])
});
export type KeyRetireResponse = z.output<typeof keyRetireResponseSchema>;

export const keyAbortResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	state: z.literal('absent')
});
export type KeyAbortResponse = z.output<typeof keyAbortResponseSchema>;

// `active` marks the key that issues new tokens. Every listed key still
// verifies tokens and remains published in the JWKS.
export const authKeySummarySchema = z.strictObject({
	kid: authKeyIdSchema,
	createdAt: isoTimestampSchema,
	active: z.boolean(),
	scheduledRetireAt: isoTimestampSchema.optional()
});
export type AuthKeySummary = z.output<typeof authKeySummarySchema>;

export const authKeyListResponseSchema = z.strictObject({
	keys: z.array(authKeySummarySchema)
});
export type AuthKeyListResponse = z.output<typeof authKeyListResponseSchema>;

export const authKeyRotateResponseSchema = z.strictObject({
	rotated: authKeyIdSchema,
	retiring: z
		.strictObject({
			kid: authKeyIdSchema,
			scheduledRetireAt: isoTimestampSchema
		})
		.optional(),
	keys: z.array(authKeySummarySchema)
});
export type AuthKeyRotateResponse = z.output<
	typeof authKeyRotateResponseSchema
>;

export const authKeyRetireResponseSchema = z.strictObject({
	kid: authKeyIdSchema,
	retired: z.boolean()
});
export type AuthKeyRetireResponse = z.output<
	typeof authKeyRetireResponseSchema
>;

export type SigningKeyInput = z.input<typeof signingKeySchema>;
export type BackfillFailureInput = z.input<typeof backfillFailureSchema>;
export type UnpublishableStorePathsInput = z.input<
	typeof unpublishableStorePathsSchema
>;
export type BackfillStatusInput = z.input<typeof backfillStatusSchema>;
export type SigningKeyEntryInput = z.input<typeof signingKeyEntrySchema>;
export type KeyListResponseInput = z.input<typeof keyListResponseSchema>;
export type KeyRotateResponseInput = z.input<typeof keyRotateResponseSchema>;
export type KeyRetireResponseInput = z.input<typeof keyRetireResponseSchema>;
export type KeyAbortResponseInput = z.input<typeof keyAbortResponseSchema>;
export type AuthKeySummaryInput = z.input<typeof authKeySummarySchema>;
export type AuthKeyListResponseInput = z.input<
	typeof authKeyListResponseSchema
>;
export type AuthKeyRotateResponseInput = z.input<
	typeof authKeyRotateResponseSchema
>;
export type AuthKeyRetireResponseInput = z.input<
	typeof authKeyRetireResponseSchema
>;
