import {
	compressionSchema,
	narInfoLineSchema,
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { storePathHashOf } from '@cupboard/nix-store/store-path';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

// Parsed schema outputs are branded; buildable wire inputs are unbranded.

const isStorePathHashForPath = (value: {
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
	deriver: narInfoLineSchema.optional(),
	ca: narInfoLineSchema.optional()
};

const uploadBlobMetadataShape = {
	fileHash: nixSha256HashSchema,
	fileSize: positiveIntSchema,
	compression: compressionSchema
};

export const uploadPathNegotiationSchema = z
	.strictObject(uploadPathNegotiationShape)
	.refine(isStorePathHashForPath, storePathHashMismatchMessage);
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
	.refine(isStorePathHashForPath, storePathHashMismatchMessage);
export type ParsedUploadPathMetadata = z.output<
	typeof uploadPathMetadataSchema
>;

// One negotiate carries a store-path closure, bounded by the store itself. The
// cap sits well above any real closure, so it rejects only an abusive body, not
// a legitimate push.
export const uploadNegotiateMaxPaths = 100_000;

export const uploadNegotiateRequestSchema = z.strictObject({
	paths: z.array(uploadPathNegotiationSchema).max(uploadNegotiateMaxPaths)
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

// One batch prepare presigns a chunk of a push in a single round-trip. The cap
// bounds the request body; the client chunks the closure under it.
export const uploadPrepareBatchMaxItems = 256;

export const uploadPrepareItemRequestSchema = z.strictObject({
	id: z.string(),
	...uploadBlobMetadataShape
});
export type ParsedUploadPrepareItemRequest = z.output<
	typeof uploadPrepareItemRequestSchema
>;

export const uploadPrepareBatchRequestSchema = z.strictObject({
	items: z
		.array(uploadPrepareItemRequestSchema)
		.min(1)
		.max(uploadPrepareBatchMaxItems)
});
export type ParsedUploadPrepareBatchRequest = z.output<
	typeof uploadPrepareBatchRequestSchema
>;

// A per-item result, so one item whose slot expired or turned out reusable does
// not fail the whole chunk: a presigned item carries its URL, a failed one its
// id and reason, and the client re-negotiates the failed ids one at a time.
export const uploadPrepareItemResultSchema = z.discriminatedUnion('ok', [
	z.strictObject({
		ok: z.literal(true),
		id: z.string(),
		...uploadPrepareResponseSchema.shape
	}),
	z.strictObject({
		ok: z.literal(false),
		id: z.string(),
		error: z.string()
	})
]);
export type ParsedUploadPrepareItemResult = z.output<
	typeof uploadPrepareItemResultSchema
>;
export type UploadPrepareItemResult = z.input<
	typeof uploadPrepareItemResultSchema
>;

export const uploadPrepareBatchResponseSchema = z.strictObject({
	items: z.array(uploadPrepareItemResultSchema)
});
export type ParsedUploadPrepareBatchResponse = z.output<
	typeof uploadPrepareBatchResponseSchema
>;
export type UploadPrepareBatchResponse = z.input<
	typeof uploadPrepareBatchResponseSchema
>;

export const uploadSkipDecisionSchema = z.strictObject({
	action: z.literal('skip'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema
});
export type ParsedUploadSkipDecision = z.output<
	typeof uploadSkipDecisionSchema
>;

export const uploadCommitDecisionSchema = z.strictObject({
	action: z.literal('commit'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	uploadId: z.string()
});
export type ParsedUploadCommitDecision = z.output<
	typeof uploadCommitDecisionSchema
>;

export const uploadActionDecisionSchema = z.strictObject({
	action: z.literal('upload'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	uploadId: z.string(),
	r2Key: z.string(),
	expiresAt: z.string()
});
export type ParsedUploadActionDecision = z.output<
	typeof uploadActionDecisionSchema
>;

export const uploadDecisionSchema = z.discriminatedUnion('action', [
	uploadSkipDecisionSchema,
	uploadCommitDecisionSchema,
	uploadActionDecisionSchema
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

// The status of a deferred upload. `servable` once verification committed it,
// `pending` while it still verifies, the terminal `mismatch`/`over-quota` on
// failure, and `absent` once the upload is gone (its observation window
// passed, or another upload of the same path settled it).
export const uploadStatusSchema = z.enum([
	'servable',
	'pending',
	'mismatch',
	'over-quota',
	'absent'
]);
export const uploadStatusResponseSchema = z.strictObject({
	status: uploadStatusSchema
});
export type ParsedUploadStatusResponse = z.output<
	typeof uploadStatusResponseSchema
>;
export type UploadStatusResponse = z.input<typeof uploadStatusResponseSchema>;

// The commit endpoint is a WebSocket: the upgrade request carries the write
// token, and every frame is server to client. The first frame settles the
// path at commit time (`result`) or reports it stored pending verification
// (`deferred`); a deferred upload's socket stays open until the verification
// pass answers with the terminal `verdict`. `error` mirrors what the HTTP
// error response would have said, then the socket closes.
export const commitSocketFrameSchema = z.discriminatedUnion('event', [
	z.strictObject({
		event: z.literal('result'),
		response: commitResponseSchema
	}),
	z.strictObject({
		event: z.literal('deferred'),
		storePathHash: storePathHashSchema,
		narHash: nixSha256HashSchema
	}),
	z.strictObject({
		event: z.literal('verdict'),
		status: uploadStatusSchema
	}),
	z.strictObject({
		event: z.literal('error'),
		status: z.number().int(),
		message: z.string()
	})
]);
export type ParsedCommitSocketFrame = z.output<typeof commitSocketFrameSchema>;
export type CommitSocketFrame = z.input<typeof commitSocketFrameSchema>;

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

export const pathDeletionResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	deleted: z.boolean(),
	narScheduledForDeletion: z.boolean()
});
export type ParsedDeletePathResponse = z.output<
	typeof pathDeletionResponseSchema
>;

// Buildable wire shapes: schema inputs are unbranded, so callers construct
// request bodies and the server builds response bodies without issuing brands.
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
export type UploadActionDecision = z.input<typeof uploadActionDecisionSchema>;
export type UploadCommitDecision = z.input<typeof uploadCommitDecisionSchema>;
export type UploadDecision = z.input<typeof uploadDecisionSchema>;
export type UploadNegotiateResponse = z.input<
	typeof uploadNegotiateResponseSchema
>;
export type CommitResponse = z.input<typeof commitResponseSchema>;
export type StatsResponse = z.input<typeof statsResponseSchema>;
export type UsageResponse = z.input<typeof usageResponseSchema>;
export type DeletePathResponse = z.input<typeof pathDeletionResponseSchema>;
