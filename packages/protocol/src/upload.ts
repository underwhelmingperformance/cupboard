import {
	compressionSchema,
	graceSecondsSchema,
	narInfoLineSchema,
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	rootNameSchema,
	storePathBasenameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { storePathHashOf } from '@cupboard/nix-store/store-path';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

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
	// `Deriver` uses a store-path basename, as do the entries in `References`;
	// the cache's `StoreDir` supplies the directory. `CA` contains a
	// content-address specification, not a path.
	deriver: storePathBasenameSchema.optional(),
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
export type UploadPathNegotiation = z.output<
	typeof uploadPathNegotiationSchema
>;

export const uploadBlobMetadataSchema = z.strictObject(uploadBlobMetadataShape);
export type UploadBlobMetadata = z.output<typeof uploadBlobMetadataSchema>;

export const uploadPathMetadataSchema = z
	.strictObject({
		...uploadPathNegotiationShape,
		...uploadBlobMetadataShape
	})
	.refine(isStorePathHashForPath, storePathHashMismatchMessage);
export type UploadPathMetadata = z.output<typeof uploadPathMetadataSchema>;

// An identifier signed by the server when it issues upload credentials. The
// identifier scopes staging objects to `staging/<pushId>/`, so one credential
// can cover every upload in the push. The restricted format prevents the
// identifier from escaping that prefix. The schema validates only the format;
// the server separately verifies the signature.
export const pushIdSchema = z
	.string()
	.regex(
		/^[A-Za-z0-9-]{1,128}$/,
		'pushId must contain 1 to 128 ASCII letters, digits, or hyphens'
	)
	.brand('PushId');
export type PushId = z.infer<typeof pushIdSchema>;

export const uploadIdSchema = z.string().brand('UploadId');
export type UploadId = z.infer<typeof uploadIdSchema>;

export const sessionIdSchema = z.string().brand('SessionId');
export type SessionId = z.infer<typeof sessionIdSchema>;

// The server closes a commit connection when the access token from its upgrade
// expires. The client checks both values to distinguish an expired token from
// another validation failure.
export const commitAuthenticationExpiredCloseCode = 1008;
export const commitAuthenticationExpiredCloseReason = 'access token expired';

export const r2CredentialSchema = z.strictObject({
	accessKeyId: z.string(),
	secretAccessKey: z.string(),
	sessionToken: z.string(),
	endpoint: z.string(),
	bucket: z.string(),
	expiresAt: isoTimestampSchema
});
export type R2Credential = z.output<typeof r2CredentialSchema>;
export type R2CredentialInput = z.input<typeof r2CredentialSchema>;

// The CLI passes these temporary credentials to a standard S3 client and
// uploads directly to the push's staging prefix in R2. The signed push id names
// that prefix, and no blob bytes pass through the Worker.
export const pushCredentialSchema = z.strictObject({
	pushId: pushIdSchema,
	...r2CredentialSchema.shape
});
export type PushCredential = z.output<typeof pushCredentialSchema>;
export type PushCredentialInput = z.input<typeof pushCredentialSchema>;

// Negotiation and preview each accept at most 100,000 store paths. Confirmation
// uses the lower 1,000-hash limit below.
export const uploadNegotiateMaxPaths = 100_000;

// `retainUntil` reports the durable deadline after a path was confirmed.
// `graceSeconds` reports the configured grace when no deadline was written,
// including zero seconds. An empty object means grace was not configured.
export const uploadGraceFactSchema = z
	.strictObject({
		retainUntil: z.string().optional(),
		graceSeconds: graceSecondsSchema.optional()
	})
	.refine(
		(fact) => fact.retainUntil === undefined || fact.graceSeconds === undefined,
		{
			message: 'Set either retainUntil or graceSeconds, not both'
		}
	);
export type UploadGraceFact = z.output<typeof uploadGraceFactSchema>;

// Commit frames carry no root. Negotiation binds this root alongside the push
// id, and the commit socket applies it to every path in the push.
export const uploadAttachRootSchema = z.strictObject({
	name: rootNameSchema,
	ttlSeconds: ttlSecondsSchema.optional()
});
export type UploadAttachRoot = z.output<typeof uploadAttachRootSchema>;

export const uploadNegotiateRequestSchema = z.strictObject({
	pushId: pushIdSchema,
	attachRoot: uploadAttachRootSchema.optional(),
	paths: z.array(uploadPathNegotiationSchema).max(uploadNegotiateMaxPaths)
});
export type UploadNegotiateRequest = z.output<
	typeof uploadNegotiateRequestSchema
>;

export const uploadSkipDecisionSchema = z.strictObject({
	action: z.literal('skip'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	grace: uploadGraceFactSchema.optional()
});
export type UploadSkipDecision = z.output<typeof uploadSkipDecisionSchema>;

export const uploadCommitDecisionSchema = z.strictObject({
	action: z.literal('commit'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	uploadId: uploadIdSchema,
	grace: uploadGraceFactSchema.optional()
});
export type UploadCommitDecision = z.output<typeof uploadCommitDecisionSchema>;

export const uploadActionDecisionSchema = z.strictObject({
	action: z.literal('upload'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	uploadId: uploadIdSchema,
	r2Key: z.string(),
	expiresAt: isoTimestampSchema,
	grace: uploadGraceFactSchema.optional()
});
export type UploadActionDecision = z.output<typeof uploadActionDecisionSchema>;

export const uploadDecisionSchema = z.discriminatedUnion('action', [
	uploadSkipDecisionSchema,
	uploadCommitDecisionSchema,
	uploadActionDecisionSchema
]);
export type UploadDecision = z.output<typeof uploadDecisionSchema>;

export const uploadNegotiateResponseSchema = z.strictObject({
	uploads: z.array(uploadDecisionSchema)
});
export type UploadNegotiateResponse = z.output<
	typeof uploadNegotiateResponseSchema
>;

// A preview creates no upload credentials, so it has no signed `pushId`. The
// cache-scoped bearer grant and ownership check prevent the response from
// disclosing another tenant's blobs. Preview therefore needs no separate proof
// of a live push.
export const uploadPreviewRequestSchema = z.strictObject({
	paths: z.array(uploadPathNegotiationSchema).max(uploadNegotiateMaxPaths)
});
export type UploadPreviewRequest = z.output<typeof uploadPreviewRequestSchema>;

// A preview decision reports the action that negotiation would plan. It omits
// `uploadId`, `r2Key`, and `expiresAt` because preview creates no staging object.
// `grace` is present when the request accepts upload grace facts. Without that
// capability, decisions retain their legacy shape.
export const uploadPreviewDecisionSchema = z.strictObject({
	action: z.enum(['skip', 'commit', 'upload']),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	grace: uploadGraceFactSchema.optional()
});
export type UploadPreviewDecision = z.output<
	typeof uploadPreviewDecisionSchema
>;

export const uploadPreviewResponseSchema = z.strictObject({
	uploads: z.array(uploadPreviewDecisionSchema)
});
export type UploadPreviewResponse = z.output<
	typeof uploadPreviewResponseSchema
>;

// Confirmation accepts at most 1,000 store-path hashes. The server deduplicates
// its storage work but returns one result for every input entry. The CLI splits
// larger closures into sequential requests.
export const uploadConfirmMaxPaths = 1000;

export const uploadConfirmRequestSchema = z.strictObject({
	storePathHashes: z.array(storePathHashSchema).max(uploadConfirmMaxPaths)
});
export type UploadConfirmRequest = z.output<typeof uploadConfirmRequestSchema>;

// `confirmed` is false unless the committed reference, canonical NAR and
// current narinfo identity all pass their checks. The server does not extend a
// grace deadline when confirmation fails, so `grace` is absent in that case.
export const uploadConfirmedPathSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	confirmed: z.boolean(),
	grace: uploadGraceFactSchema.optional()
});
export type UploadConfirmedPath = z.output<typeof uploadConfirmedPathSchema>;

export const uploadConfirmResponseSchema = z.strictObject({
	paths: z.array(uploadConfirmedPathSchema)
});
export type UploadConfirmResponse = z.output<
	typeof uploadConfirmResponseSchema
>;

export const commitResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	status: z.enum(['committed', 'already-present', 'pending'])
});
export type CommitResponse = z.output<typeof commitResponseSchema>;

// The status of a deferred upload. `servable` means verification committed the
// upload. `pending` means verification is still running. `mismatch` and
// `over-quota` are terminal failures. `absent` means the observation window
// expired or another upload of the same path completed first.
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
export type UploadStatusResponse = z.output<typeof uploadStatusResponseSchema>;
export type UploadStatusResponseInput = z.input<
	typeof uploadStatusResponseSchema
>;

// One WebSocket handles all commits for a push. Upload-specific requests and
// responses identify their upload. The `request-credit` operation and the
// `credit` and `queued` frames apply to the connection. An `unsupported` frame
// identifies an unrecognised operation. None of these connection-level frames
// carries an upload id.
const uploadIdsSchema = z.array(uploadIdSchema);

// A client sends `commit-batch` only when the server lists it in the 101
// response. A server that does not list the operation would close the socket if
// it could not parse the request, so the client falls back to individual
// `commit` operations.
export const commitCapabilitiesHeader = 'x-cupboard-commit-capabilities';

export const uploadCapabilitiesHeader = 'x-cupboard-upload-capabilities';

// Upload negotiation and the commit session share this request header for
// optional protocol semantics the client understands.
export const acceptCapabilitiesHeader = 'x-cupboard-accept-capabilities';

export const commitAcceptCapabilitiesHeader = acceptCapabilitiesHeader;

// A client advertises this capability to receive grace facts in negotiation
// decisions and in later commit frames for the same pending uploads.
export const uploadGraceFactsCapability = 'upload-grace-facts';
export const uploadCapabilitiesValue = uploadGraceFactsCapability;

// Clients look up the bare `commit-batch` name in the parsed capability map.
// The server advertises the parameterised form below.
export const commitBatchCapability = 'commit-batch';

// This constant is encoded in the capability token the server
// advertises on every 101. Any change to this value, or to the shape of a
// known op's schema, needs a new capability token so older servers (which close
// on schema violations) and newer clients can coexist safely.
export const commitBatchMaxEntries = 100;

// The attribute both tokens below carry once the server accepts the optional
// `retention` marker on a `commitBatchEntrySchema` entry (see that schema's
// compatibility note). A client checks for this attribute before ever setting the
// marker, so a server that predates it never receives the unknown field that
// its strict schema would reject.
export const retentionMarkerAttribute = 'retention';
export const retentionMarkerAttributeValue = '1';

// The parameterised capability token the server includes in the 101 header.
// Carries the entry cap so a client receiving it knows the maximum batch size
// this server accepts without needing a separate negotiation round-trip, and
// the retention-marker attribute so it knows the entry schema accepts the
// marker. Build from the shared constants; never hand-code the string.
export const commitBatchCapabilityToken = `${commitBatchCapability};max=${String(commitBatchMaxEntries)};${retentionMarkerAttribute}=${retentionMarkerAttributeValue}`;

// The capability name for `subscribe-identity`. A client looks this up in the
// parsed capability map; the server advertises it so a capable client replays
// acked ids through the identity-carrying op, which resolves a gone row by the
// path's committed narinfo.
//
// The op's entry schema reuses `commitBatchEntrySchema` and is bounded
// by `commitBatchMaxEntries`. Any change to that shape or bound needs a new
// capability token.
export const subscribeIdentityCapability = 'subscribe-identity';

// The capability token the server includes in the 101 header alongside the
// commit-batch token. The entry shape and bound are shared with `commit-batch`
// and are already encoded in that token; the retention-marker attribute is
// repeated here since a `subscribe-identity` op is sent without a
// `commit-batch` op ever having been.
export const subscribeIdentityCapabilityToken = `${subscribeIdentityCapability};${retentionMarkerAttribute}=${retentionMarkerAttributeValue}`;

// The capability name for credit-based admission. A client looks this up in the
// parsed capability map; the server advertises it with the connection's opening
// grant as an attribute. Advertised, it tells the client that this server bounds
// the session by granted credit rather than by a client-side window: the client
// may send `request-credit`, and every entry it sends must be covered by credit
// it holds.
//
// This token covers the `request-credit` op and the `credit` and
// `queued` frames. Any change to their shapes needs a new capability token.
export const commitCreditCapability = 'commit-credit';

export const commitCreditGrantAttribute = 'grant';

// The credit token for one connection. Unlike the tokens above it varies from
// one 101 to the next, since the opening grant depends on how much of the
// tenant's budget is free when the upgrade arrives.
export function commitCreditCapabilityToken(openingGrant: number): string {
	return `${commitCreditCapability};${commitCreditGrantAttribute}=${String(openingGrant)}`;
}

export const commitCapabilitiesValue = `${commitBatchCapabilityToken},${subscribeIdentityCapabilityToken}`;

export function commitCapabilitiesValueWithCredit(
	openingGrant: number
): string {
	return `${commitCapabilitiesValue},${commitCreditCapabilityToken(openingGrant)}`;
}

// Entries for `commit-batch` and `subscribe-identity` include the upload and the
// path identity from negotiation. A reconnect can therefore resend an entry
// whose reply was lost. If the pending row has gone, the server can compare the
// identity with the committed narinfo and return `already-present`; a bare id
// could only fail as unknown. When the server advertised the retention marker,
// `retention` also records that this upload accepted grace facts. The
// `already-present` response can then include the path's durable grace fact.
//
// Any change to this schema's shape or the `commitBatchMaxEntries`
// bound is a breaking change that requires a new capability token for each op
// that uses it.
export const commitBatchEntrySchema = z.strictObject({
	uploadId: uploadIdSchema,
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	retention: z.literal(true).optional()
});
export type CommitBatchEntry = z.output<typeof commitBatchEntrySchema>;

export const commitSessionRequestSchema = z.discriminatedUnion('op', [
	z.strictObject({ op: z.literal('commit'), uploadId: uploadIdSchema }),
	z.strictObject({
		op: z.literal('commit-batch'),
		commits: z.array(commitBatchEntrySchema).min(1).max(commitBatchMaxEntries)
	}),
	z.strictObject({
		op: z.literal('subscribe'),
		uploadIds: uploadIdsSchema
	}),
	// Entries reuse `commitBatchEntrySchema` and are bounded by
	// `commitBatchMaxEntries`; the server advertises `subscribe-identity` only
	// when it handles this op, so an older server never receives it.
	z.strictObject({
		op: z.literal('subscribe-identity'),
		entries: z.array(commitBatchEntrySchema).min(1).max(commitBatchMaxEntries)
	}),
	// A client reports how many entries it has queued but cannot send without
	// more credit. Each report replaces the previous count, so updates do not
	// accumulate stale demand. Clients send this only after the server advertises
	// `commit-credit`.
	z.strictObject({
		op: z.literal('request-credit'),
		entries: positiveIntSchema
	})
]);
export type CommitSessionRequest = z.output<typeof commitSessionRequestSchema>;
export type CommitSessionRequestInput = z.input<
	typeof commitSessionRequestSchema
>;

export const commitSessionFrameSchema = z.discriminatedUnion('ev', [
	// The optional `grace` fields below are sent only for an upload whose
	// negotiation accepted the upload-grace-facts capability. A client that did
	// not opt in receives exactly the legacy shapes.
	z.strictObject({
		ev: z.literal('settled'),
		uploadId: uploadIdSchema,
		response: commitResponseSchema,
		grace: uploadGraceFactSchema.optional()
	}),
	z.strictObject({
		ev: z.literal('deferred'),
		uploadId: uploadIdSchema,
		storePathHash: storePathHashSchema,
		narHash: nixSha256HashSchema,
		grace: uploadGraceFactSchema.optional()
	}),
	z.strictObject({
		ev: z.literal('verdict'),
		uploadId: uploadIdSchema,
		status: uploadStatusSchema,
		grace: uploadGraceFactSchema.optional()
	}),
	z.strictObject({
		ev: z.literal('error'),
		uploadId: uploadIdSchema,
		status: z.number().int(),
		message: z.string()
	}),
	// Answers a well-formed op this server does not know, naming it, so a newer
	// client degrades one message at a time, whereas a close would drop the whole
	// session. Only ever sent in reply to such an op, which a client of this
	// version or older never sends, so no deployed client meets a frame it cannot
	// parse.
	z.strictObject({
		ev: z.literal('unsupported'),
		op: z.string()
	}),
	// Grants the session credit for `grant` further entries. The server pushes
	// this frame both in answer to `request-credit` and unprompted, whenever
	// another session's entry releases credit the tenant can pass on. A grant of
	// zero is never sent; `queued` answers a request the server can grant nothing
	// against.
	z.strictObject({
		ev: z.literal('credit'),
		grant: positiveIntSchema
	}),
	// Answers a `request-credit` the tenant's budget cannot cover yet. `ahead`
	// counts the sessions before this one in the server's rotation at the moment
	// the frame was built. It is diagnostic only, for logs and for a timeout
	// error's cause: the rotation moves on as soon as any entry settles, so a
	// client must never render it as a queue position or an estimated wait.
	z.strictObject({
		ev: z.literal('queued'),
		ahead: countSchema
	})
]);
export type CommitSessionFrame = z.output<typeof commitSessionFrameSchema>;
export type CommitSessionFrameInput = z.input<typeof commitSessionFrameSchema>;

export const statsResponseSchema = z.strictObject({
	storePaths: countSchema,
	narBlobs: countSchema,
	narFileSize: countSchema,
	casObjects: countSchema,
	casFileSize: countSchema,
	pendingUploads: countSchema,
	totalFileSize: countSchema
});
export type StatsResponse = z.output<typeof statsResponseSchema>;

export const usageResponseSchema = z.strictObject({
	narBlobs: countSchema,
	narFileSize: countSchema,
	casObjects: countSchema,
	casFileSize: countSchema,
	totalFileSize: countSchema,
	quotaBytes: countSchema.optional(),
	remainingQuotaBytes: countSchema.optional()
});
export type UsageResponse = z.output<typeof usageResponseSchema>;

export const pathDeletionResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	deleted: z.boolean(),
	narScheduledForDeletion: z.boolean()
});
export type DeletePathResponse = z.output<typeof pathDeletionResponseSchema>;

export type UploadPathNegotiationFields = z.input<
	typeof uploadPathNegotiationSchema
>;
export type UploadBlobMetadataFields = z.input<typeof uploadBlobMetadataSchema>;
export type UploadPathMetadataFields = z.input<typeof uploadPathMetadataSchema>;
export type UploadAttachRootInput = z.input<typeof uploadAttachRootSchema>;
export type UploadNegotiateRequestInput = z.input<
	typeof uploadNegotiateRequestSchema
>;
export type UploadActionDecisionInput = z.input<
	typeof uploadActionDecisionSchema
>;
export type UploadCommitDecisionInput = z.input<
	typeof uploadCommitDecisionSchema
>;
export type UploadDecisionInput = z.input<typeof uploadDecisionSchema>;
export type UploadNegotiateResponseInput = z.input<
	typeof uploadNegotiateResponseSchema
>;
export type UploadPreviewRequestInput = z.input<
	typeof uploadPreviewRequestSchema
>;
export type UploadPreviewDecisionInput = z.input<
	typeof uploadPreviewDecisionSchema
>;
export type UploadPreviewResponseInput = z.input<
	typeof uploadPreviewResponseSchema
>;
export type UploadConfirmRequestInput = z.input<
	typeof uploadConfirmRequestSchema
>;
export type UploadConfirmedPathInput = z.input<
	typeof uploadConfirmedPathSchema
>;
export type UploadConfirmResponseInput = z.input<
	typeof uploadConfirmResponseSchema
>;
export type CommitResponseInput = z.input<typeof commitResponseSchema>;
export type StatsResponseInput = z.input<typeof statsResponseSchema>;
export type UsageResponseInput = z.input<typeof usageResponseSchema>;
export type DeletePathResponseInput = z.input<
	typeof pathDeletionResponseSchema
>;
