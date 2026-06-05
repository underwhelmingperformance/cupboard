import {
	compressionSchema,
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix/scalars';
import { storePathHashOf } from '@cupboard/nix/store-path';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

// Parsed schema outputs are branded; buildable wire inputs are unbranded.

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
	status: z.enum(['committed', 'already-present', 'pending'])
});
export type ParsedCommitResponse = z.output<typeof commitResponseSchema>;

export const statsResponseSchema = z.strictObject({
	storePaths: countSchema,
	narBlobs: countSchema,
	narFileSize: countSchema,
	casObjects: countSchema,
	casFileSize: countSchema,
	pendingUploads: countSchema,
	totalFileSize: countSchema
});
export type ParsedStatsResponse = z.output<typeof statsResponseSchema>;

export const usageResponseSchema = z.strictObject({
	narBlobs: countSchema,
	narFileSize: countSchema,
	casObjects: countSchema,
	casFileSize: countSchema,
	totalFileSize: countSchema,
	quotaBytes: countSchema.optional(),
	remainingQuotaBytes: countSchema.optional()
});
export type ParsedUsageResponse = z.output<typeof usageResponseSchema>;

export const deletePathResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	deleted: z.boolean(),
	narScheduledForDeletion: z.boolean()
});
export type ParsedDeletePathResponse = z.output<
	typeof deletePathResponseSchema
>;

// Buildable wire shapes: schema inputs are unbranded, so callers construct
// request bodies and the server builds response bodies without minting brands.
// The `Parsed…` outputs above are the branded results of a successful parse.
export type UploadPathNegotiationFields = z.input<
	typeof uploadPathNegotiationSchema
>;
export type UploadBlobMetadataFields = z.input<typeof uploadBlobMetadataSchema>;
export type UploadPathMetadataFields = z.input<typeof uploadPathMetadataSchema>;
export type UploadNegotiateRequest = z.input<
	typeof uploadNegotiateRequestSchema
>;
export type UploadPrepareRequest = z.input<typeof uploadPrepareRequestSchema>;
export type UploadPrepareResponse = z.input<typeof uploadPrepareResponseSchema>;
export type UploadDecision = z.input<typeof uploadDecisionSchema>;
export type UploadNegotiateResponse = z.input<
	typeof uploadNegotiateResponseSchema
>;
export type CommitResponse = z.input<typeof commitResponseSchema>;
export type StatsResponse = z.input<typeof statsResponseSchema>;
export type UsageResponse = z.input<typeof usageResponseSchema>;
export type DeletePathResponse = z.input<typeof deletePathResponseSchema>;
