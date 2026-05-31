import { z } from 'zod';

import {
	compressionSchema,
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from './scalars.ts';
import { storePathHashOf } from './store-path.ts';

// Parsed schema outputs are branded; buildable wire inputs are unbranded.

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const storePathHashMatchesPath = (value: {
	readonly storePathHash: string;
	readonly storePath: string;
}): boolean => storePathHashOf(value.storePath) === value.storePathHash;

const storePathHashMismatchMessage =
	'storePathHash does not match the hash of storePath';

const uploadPathNegotiationShape = {
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	narHash: nixSha256HashSchema,
	narSize: positiveIntSchema,
	references: referencesSchema,
	deriver: z.string().optional(),
	ca: z.string().optional()
};

const uploadBlobMetadataShape = {
	fileHash: nixSha256HashSchema,
	fileSize: positiveIntSchema,
	compression: compressionSchema
};

export const uploadPathNegotiationSchema = z
	.strictObject(uploadPathNegotiationShape)
	.refine(storePathHashMatchesPath, storePathHashMismatchMessage);
export type ParsedUploadPathNegotiation = z.output<
	typeof uploadPathNegotiationSchema
>;

export const uploadBlobMetadataSchema = z.strictObject(uploadBlobMetadataShape);
export type ParsedUploadBlobMetadata = z.output<
	typeof uploadBlobMetadataSchema
>;

export const uploadPathMetadataSchema = z
	.strictObject({
		...uploadPathNegotiationShape,
		...uploadBlobMetadataShape
	})
	.refine(storePathHashMatchesPath, storePathHashMismatchMessage);
export type ParsedUploadPathMetadata = z.output<
	typeof uploadPathMetadataSchema
>;

export const uploadNegotiateRequestSchema = z.strictObject({
	paths: z.array(uploadPathNegotiationSchema)
});
export type ParsedUploadNegotiateRequest = z.output<
	typeof uploadNegotiateRequestSchema
>;

export const uploadPrepareRequestSchema = uploadBlobMetadataSchema;
export type ParsedUploadPrepareRequest = z.output<
	typeof uploadPrepareRequestSchema
>;

export const uploadPrepareResponseSchema = z.strictObject({
	uploadUrl: z.string(),
	uploadHeaders: z.record(z.string(), z.string()),
	expiresAt: z.string()
});
export type ParsedUploadPrepareResponse = z.output<
	typeof uploadPrepareResponseSchema
>;

export const uploadDecisionSchema = z.discriminatedUnion('action', [
	z.strictObject({
		action: z.literal('skip'),
		storePathHash: storePathHashSchema,
		narHash: nixSha256HashSchema
	}),
	z.strictObject({
		action: z.literal('commit'),
		storePathHash: storePathHashSchema,
		narHash: nixSha256HashSchema,
		uploadId: z.string()
	}),
	z.strictObject({
		action: z.literal('upload'),
		storePathHash: storePathHashSchema,
		narHash: nixSha256HashSchema,
		uploadId: z.string(),
		r2Key: z.string(),
		expiresAt: z.string()
	})
]);
export type ParsedUploadDecision = z.output<typeof uploadDecisionSchema>;

export const uploadNegotiateResponseSchema = z.strictObject({
	uploads: z.array(uploadDecisionSchema)
});
export type ParsedUploadNegotiateResponse = z.output<
	typeof uploadNegotiateResponseSchema
>;

export const commitResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	status: z.enum(['committed', 'already-present'])
});
export type ParsedCommitResponse = z.output<typeof commitResponseSchema>;

export const bootstrapResponseSchema = z.strictObject({
	url: z.string(),
	publicKey: z.string(),
	token: z.string()
});
export type ParsedBootstrapResponse = z.output<typeof bootstrapResponseSchema>;

export const statsResponseSchema = z.strictObject({
	storePaths: countSchema,
	narBlobs: countSchema,
	pendingUploads: countSchema,
	totalFileSize: countSchema
});
export type ParsedStatsResponse = z.output<typeof statsResponseSchema>;

export const deletePathRequestSchema = z.strictObject({
	storePathHash: storePathHashSchema
});
export type ParsedDeletePathRequest = z.output<typeof deletePathRequestSchema>;

export const deletePathResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	deleted: z.boolean(),
	narScheduledForDeletion: z.boolean()
});
export type ParsedDeletePathResponse = z.output<
	typeof deletePathResponseSchema
>;

export const rootSetBodySchema = z.strictObject({
	targets: z.array(storePathSchema).min(1),
	ttlSeconds: ttlSecondsSchema.optional()
});
export type ParsedRootSetBody = z.output<typeof rootSetBodySchema>;

export const rootSetRequestSchema = z.strictObject({
	name: rootNameSchema,
	targets: z.array(storePathSchema).min(1),
	ttlSeconds: ttlSecondsSchema.optional()
});
export type ParsedRootSetRequest = z.output<typeof rootSetRequestSchema>;

export const rootTargetSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	present: z.boolean()
});
export type ParsedRootTarget = z.output<typeof rootTargetSchema>;

export const rootSummarySchema = z.strictObject({
	name: rootNameSchema,
	expiresAt: z.string().optional(),
	expired: z.boolean(),
	createdAt: z.string(),
	updatedAt: z.string(),
	targets: z.array(rootTargetSchema)
});
export type ParsedRootSummary = z.output<typeof rootSummarySchema>;

// A set-root response is a root summary; the named alias documents the route.
export const rootSetResponseSchema = rootSummarySchema;
export type ParsedRootSetResponse = z.output<typeof rootSetResponseSchema>;

export const rootListResponseSchema = z.strictObject({
	roots: z.array(rootSummarySchema)
});
export type ParsedRootListResponse = z.output<typeof rootListResponseSchema>;

export const rootRemoveRequestSchema = z.strictObject({
	name: rootNameSchema
});
export type ParsedRootRemoveRequest = z.output<typeof rootRemoveRequestSchema>;

export const rootRemoveResponseSchema = z.strictObject({
	name: rootNameSchema,
	removed: z.boolean()
});
export type ParsedRootRemoveResponse = z.output<
	typeof rootRemoveResponseSchema
>;
