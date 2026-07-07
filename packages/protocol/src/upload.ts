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

// An identifier for one push, signed and handed out by the server when it issues
// the push's upload credential. It namespaces the push's staging objects under
// `staging/<pushId>/`, so one credential scoped to that prefix covers every
// upload the push stages, including the fresh keys a re-negotiated slot creates.
// The wire shape is constrained to url-safe characters with no slash or dot, so
// a pushId can never widen the staging key past its prefix; the server checks
// the signature itself, the schema only bounds the wire format.
export const pushIdSchema = z
	.string()
	.regex(/^[A-Za-z0-9-]{1,128}$/, 'pushId must be url-safe');
export type ParsedPushId = z.output<typeof pushIdSchema>;

// A temporary R2 S3 credential: the access-key triple a standard S3 client signs
// with, where to send the requests, and when it stops working. The single
// declaration of the shape, shared by the server helper that builds it and the
// wire response that carries it.
export const r2CredentialSchema = z.strictObject({
	accessKeyId: z.string(),
	secretAccessKey: z.string(),
	sessionToken: z.string(),
	endpoint: z.string(),
	bucket: z.string(),
	expiresAt: z.string()
});
export type ParsedR2Credential = z.output<typeof r2CredentialSchema>;
export type R2Credential = z.input<typeof r2CredentialSchema>;

// The credential a push uploads its blobs with, scoped to the push's staging
// prefix, plus the signed push id that names the prefix. The CLI drives a
// standard S3 client with these straight to R2, so no blob byte passes the
// Worker.
export const pushCredentialSchema = z.strictObject({
	pushId: pushIdSchema,
	...r2CredentialSchema.shape
});
export type ParsedPushCredential = z.output<typeof pushCredentialSchema>;
export type PushCredential = z.input<typeof pushCredentialSchema>;

// One negotiate carries a store-path closure, bounded by the store itself. The
// cap sits well above any real closure, so it rejects only an abusive body, not
// a legitimate push.
export const uploadNegotiateMaxPaths = 100_000;

export const uploadNegotiateRequestSchema = z.strictObject({
	pushId: pushIdSchema,
	paths: z.array(uploadPathNegotiationSchema).max(uploadNegotiateMaxPaths)
});
export type ParsedUploadNegotiateRequest = z.output<
	typeof uploadNegotiateRequestSchema
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

// The multiplexed commit session: one socket per push carries every path's
// commit, so each request and frame names the upload it concerns. The client
// sends `commit` to settle one id, `commit-batch` to settle a chunk of ids in
// one message, and `subscribe` to re-attach a reconnected socket to ids still
// outstanding; the server answers with a per-id frame whose `ev` mirrors the
// single-socket protocol's events.
const uploadIdsSchema = z.array(z.string());

// The response header on the commit session's 101 listing the optional ops this
// server accepts. A client sends `commit-batch` only when the server listed it,
// so a batching client degrades to per-id `commit` ops against a server that
// does not advertise, which would close the socket on an op it cannot parse.
export const commitCapabilitiesHeader = 'x-cupboard-commit-capabilities';

// The request header the client includes on the upgrade to declare which
// optional ops it understands. A follow-up wires the client to this constant.
export const commitAcceptCapabilitiesHeader = 'x-cupboard-accept-capabilities';

// The capability name for `commit-batch`. This is the bare token name that
// clients look up in the parsed capability map; the server advertises it
// with attributes via `commitBatchCapabilityToken`.
export const commitBatchCapability = 'commit-batch';

// Bounds one `commit-batch` message. Each entry is a few hundred bytes, so the
// cap keeps a message far below the socket's limits while still collapsing a
// burst of commits into a handful of messages.
//
// Wire-freeze: this constant is encoded in the capability token the server
// advertises on every 101. Any change to this value, or to the shape of a
// known op's schema, needs a NEW capability token so older servers (which close
// on schema violations) and newer clients can coexist safely.
export const commitBatchMaxEntries = 100;

// The parameterised capability token the server includes in the 101 header.
// Carries the entry cap so a client receiving it knows the maximum batch size
// this server accepts without needing a separate negotiation round-trip.
// Build from the shared constants; never hand-code the string.
export const commitBatchCapabilityToken = `${commitBatchCapability};max=${String(commitBatchMaxEntries)}`;

// One batched commit: the upload to settle plus the path identity the client
// holds from negotiation. The identity lets a reconnect re-send an entry whose
// reply was lost: the server resolves a since-gone row against the path's
// committed narinfo and answers `already-present`, where a bare id could only
// fail as unknown.
//
// Wire-freeze: any change to this schema's shape or the `commitBatchMaxEntries`
// bound is a breaking change that requires a new capability token.
const commitBatchEntrySchema = z.strictObject({
	uploadId: z.string(),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema
});
export type ParsedCommitBatchEntry = z.output<typeof commitBatchEntrySchema>;

export const commitSessionRequestSchema = z.discriminatedUnion('op', [
	z.strictObject({ op: z.literal('commit'), uploadId: z.string() }),
	z.strictObject({
		op: z.literal('commit-batch'),
		commits: z.array(commitBatchEntrySchema).min(1).max(commitBatchMaxEntries)
	}),
	z.strictObject({
		op: z.literal('subscribe'),
		uploadIds: uploadIdsSchema
	})
]);
export type ParsedCommitSessionRequest = z.output<
	typeof commitSessionRequestSchema
>;
export type CommitSessionRequest = z.input<typeof commitSessionRequestSchema>;

export const commitSessionFrameSchema = z.discriminatedUnion('ev', [
	z.strictObject({
		ev: z.literal('settled'),
		uploadId: z.string(),
		response: commitResponseSchema
	}),
	z.strictObject({
		ev: z.literal('deferred'),
		uploadId: z.string(),
		storePathHash: storePathHashSchema,
		narHash: nixSha256HashSchema
	}),
	z.strictObject({
		ev: z.literal('verdict'),
		uploadId: z.string(),
		status: uploadStatusSchema
	}),
	z.strictObject({
		ev: z.literal('error'),
		uploadId: z.string(),
		status: z.number().int(),
		message: z.string()
	}),
	// Answers a well-formed op this server does not know, naming it, so a newer
	// client degrades per message where a close would drop the whole session. Only
	// ever sent in reply to such an op, which a client of this version or older
	// never sends, so no deployed client meets a frame it cannot parse.
	z.strictObject({
		ev: z.literal('unsupported'),
		op: z.string()
	})
]);
export type ParsedCommitSessionFrame = z.output<
	typeof commitSessionFrameSchema
>;
export type CommitSessionFrame = z.input<typeof commitSessionFrameSchema>;

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
