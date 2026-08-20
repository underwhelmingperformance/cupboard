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

// Each wire shape here is declared once and exposed two ways. The plain alias is
// what a builder assembles: the CLI putting together a request, the server
// putting together a response. The `Parsed…` output is what a successful parse
// yields, and code that consumes a validated value takes that branded form.

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
	// A narinfo names the deriver by basename, as it does references; the store
	// directory comes from the cache's `StoreDir`. `ca` is a content-address
	// specification, not a path, so it stays a metadata line.
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

// An identifier signed by the server when it issues upload credentials. The
// identifier scopes staging objects to `staging/<pushId>/`, so one credential
// can cover every upload in the push. The restricted wire format prevents the
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

// An opaque upload identifier issued during negotiation. The client returns it
// when committing or polling the pending upload. A brand prevents code from
// substituting another string identifier.
export const uploadIdSchema = z.string().brand('UploadId');
export type UploadId = z.infer<typeof uploadIdSchema>;

// A commit session's server-issued opaque id, one per WebSocket. A pending row
// records the session waiting on an upload so a verdict routes to the right
// socket. Branded so it cannot be passed where an upload id is expected.
export const sessionIdSchema = z.string().brand('SessionId');
export type SessionId = z.infer<typeof sessionIdSchema>;

// The server closes a commit connection when the access token from its upgrade
// expires. The client checks both values to distinguish an expired token from
// another policy failure.
export const commitAuthenticationExpiredCloseCode = 1008;
export const commitAuthenticationExpiredCloseReason = 'access token expired';

// The temporary S3-compatible credentials for direct R2 uploads, including the
// endpoint, bucket, and expiry. Both the server's credential builder and the
// protocol response use this schema.
export const r2CredentialSchema = z.strictObject({
	accessKeyId: z.string(),
	secretAccessKey: z.string(),
	sessionToken: z.string(),
	endpoint: z.string(),
	bucket: z.string(),
	expiresAt: isoTimestampSchema
});
export type ParsedR2Credential = z.output<typeof r2CredentialSchema>;
export type R2Credential = z.input<typeof r2CredentialSchema>;

// The credential a push uploads its blobs with, scoped to the push's staging
// prefix, plus the signed push id that names the prefix. The CLI uses these
// with a standard S3 client and uploads directly to R2, so no blob bytes pass
// through the Worker.
export const pushCredentialSchema = z.strictObject({
	pushId: pushIdSchema,
	...r2CredentialSchema.shape
});
export type ParsedPushCredential = z.output<typeof pushCredentialSchema>;
export type PushCredential = z.input<typeof pushCredentialSchema>;

// One negotiation request can contain at most 100,000 store paths. This limit is
// above expected closure sizes and bounds abusive request bodies.
export const uploadNegotiateMaxPaths = 100_000;

// The retention-grace result returned for one negotiation decision.
// `retainUntil` is the updated deadline for a path that was already present.
// `graceSeconds` is the matched policy's grace period for a planned upload or a
// read-only decision, including zero. If both fields are absent, no grace policy
// matched.
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
export type ParsedUploadGraceFact = z.output<typeof uploadGraceFactSchema>;

// The run root the push's commits attach to, bound at negotiate alongside the
// push id; the commit socket inherits it. A commit frame carries no root, so
// the name here covers every path the push commits.
export const uploadAttachRootSchema = z.strictObject({
	name: rootNameSchema,
	ttlSeconds: ttlSecondsSchema.optional()
});
export type ParsedUploadAttachRoot = z.output<typeof uploadAttachRootSchema>;

export const uploadNegotiateRequestSchema = z.strictObject({
	pushId: pushIdSchema,
	attachRoot: uploadAttachRootSchema.optional(),
	paths: z.array(uploadPathNegotiationSchema).max(uploadNegotiateMaxPaths)
});
export type ParsedUploadNegotiateRequest = z.output<
	typeof uploadNegotiateRequestSchema
>;

export const uploadSkipDecisionSchema = z.strictObject({
	action: z.literal('skip'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	grace: uploadGraceFactSchema.optional()
});
export type ParsedUploadSkipDecision = z.output<
	typeof uploadSkipDecisionSchema
>;

export const uploadCommitDecisionSchema = z.strictObject({
	action: z.literal('commit'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	uploadId: uploadIdSchema,
	grace: uploadGraceFactSchema.optional()
});
export type ParsedUploadCommitDecision = z.output<
	typeof uploadCommitDecisionSchema
>;

export const uploadActionDecisionSchema = z.strictObject({
	action: z.literal('upload'),
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	uploadId: uploadIdSchema,
	r2Key: z.string(),
	expiresAt: isoTimestampSchema,
	grace: uploadGraceFactSchema.optional()
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

// A preview creates no upload credentials, so it has no signed `pushId`. The
// cache-scoped bearer grant and ownership check prevent the response from
// disclosing another tenant's blobs. Preview therefore needs no separate proof
// of a live push.
export const uploadPreviewRequestSchema = z.strictObject({
	paths: z.array(uploadPathNegotiationSchema).max(uploadNegotiateMaxPaths)
});
export type ParsedUploadPreviewRequest = z.output<
	typeof uploadPreviewRequestSchema
>;

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
export type ParsedUploadPreviewDecision = z.output<
	typeof uploadPreviewDecisionSchema
>;

export const uploadPreviewResponseSchema = z.strictObject({
	uploads: z.array(uploadPreviewDecisionSchema)
});
export type ParsedUploadPreviewResponse = z.output<
	typeof uploadPreviewResponseSchema
>;

// A confirmation request accepts at most 1,000 store-path hashes. Each hash
// requires an identity check and a monotonic deadline update. The CLI splits
// larger closures across sequential requests.
export const uploadConfirmMaxPaths = 1000;

export const uploadConfirmRequestSchema = z.strictObject({
	storePathHashes: z.array(storePathHashSchema).max(uploadConfirmMaxPaths)
});
export type ParsedUploadConfirmRequest = z.output<
	typeof uploadConfirmRequestSchema
>;

// `confirmed` is false when the cache has no committed narinfo for the path. In
// that case no deadline was extended, so `grace` is absent.
export const uploadConfirmedPathSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	confirmed: z.boolean(),
	grace: uploadGraceFactSchema.optional()
});
export type ParsedUploadConfirmedPath = z.output<
	typeof uploadConfirmedPathSchema
>;

export const uploadConfirmResponseSchema = z.strictObject({
	paths: z.array(uploadConfirmedPathSchema)
});
export type ParsedUploadConfirmResponse = z.output<
	typeof uploadConfirmResponseSchema
>;

export const commitResponseSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	status: z.enum(['committed', 'already-present', 'pending'])
});
export type ParsedCommitResponse = z.output<typeof commitResponseSchema>;

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
export type ParsedUploadStatusResponse = z.output<
	typeof uploadStatusResponseSchema
>;
export type UploadStatusResponse = z.input<typeof uploadStatusResponseSchema>;

// One WebSocket handles all commits for a push. Every request and response
// identifies its upload. The client uses `commit`, `commit-batch`, or `subscribe`;
// the server sends one result frame for each upload.
const uploadIdsSchema = z.array(uploadIdSchema);

// The response header on the commit session's 101 listing the optional ops this
// server accepts. A client sends `commit-batch` only when the server listed it.
// A server that does not list the op would close the socket on an op it cannot
// parse, so a batching client falls back to per-id `commit` ops instead.
export const commitCapabilitiesHeader = 'x-cupboard-commit-capabilities';

// The response header on upload negotiation listing the optional response
// semantics this server accepted for the request.
export const uploadCapabilitiesHeader = 'x-cupboard-upload-capabilities';

// The request header clients use to declare optional protocol semantics they
// understand. It is shared by upload negotiation and the commit session.
export const acceptCapabilitiesHeader = 'x-cupboard-accept-capabilities';

// The request header the client includes on the upgrade to declare which
// optional ops it understands.
export const commitAcceptCapabilitiesHeader = acceptCapabilitiesHeader;

// Opts an upload negotiation into grace facts on decisions and on the commit
// frames belonging to pending uploads created by that negotiation.
export const uploadGraceFactsCapability = 'upload-grace-facts';
export const uploadCapabilitiesValue = uploadGraceFactsCapability;

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

// The attribute both tokens below carry once the server accepts the optional
// `retention` marker on a `commitBatchEntrySchema` entry (see that schema's
// wire-freeze note). A client checks for this attribute before ever setting
// the marker, so a server that predates it -- whose schema is a
// `strictObject` and would reject an unknown field -- never receives one.
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
// Wire-freeze: the op's entry schema reuses `commitBatchEntrySchema` and is
// bounded by `commitBatchMaxEntries`. Any change to that shape or bound needs a
// new capability token.
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
// Wire-freeze: this token covers the `request-credit` op and the `credit` and
// `queued` frames. Any change to their shapes needs a new capability token.
export const commitCreditCapability = 'commit-credit';

// The attribute carrying the credit the server grants the session at upgrade
// time, so an uncontended tenant starts committing without a further round trip.
export const commitCreditGrantAttribute = 'grant';

// The credit token for one connection. Unlike the tokens above it varies from
// one 101 to the next, since the opening grant depends on how much of the
// tenant's budget is free when the upgrade arrives.
export function commitCreditCapabilityToken(openingGrant: number): string {
	return `${commitCreditCapability};${commitCreditGrantAttribute}=${String(openingGrant)}`;
}

// The connection-independent part of the `x-cupboard-commit-capabilities`
// header. Build from the shared constants so no call site hand-codes the
// combined string.
export const commitCapabilitiesValue = `${commitBatchCapabilityToken},${subscribeIdentityCapabilityToken}`;

// The full header value a 101 carries for a session the server admits under
// credit: the fixed tokens plus this connection's opening grant.
export function commitCapabilitiesValueWithCredit(
	openingGrant: number
): string {
	return `${commitCapabilitiesValue},${commitCreditCapabilityToken(openingGrant)}`;
}

// One identity-carrying entry shared by `commit-batch` and `subscribe-identity`.
// Carries the upload to settle or resume plus the path identity the client holds
// from negotiation. The identity lets a reconnect re-send an entry whose reply
// was lost: the server resolves a since-gone row against the path's committed
// narinfo and answers `already-present`, whereas a bare id could only fail as
// unknown. `retention`, present only when the server advertised the
// retention-marker attribute, additionally tells the server this upload
// accepted grace facts, so that `already-present` answer can attach the path's
// durable grace fact instead of none.
//
// Wire-freeze: any change to this schema's shape or the `commitBatchMaxEntries`
// bound is a breaking change that requires a new capability token for each op
// that uses it.
export const commitBatchEntrySchema = z.strictObject({
	uploadId: uploadIdSchema,
	storePathHash: storePathHashSchema,
	narHash: nixSha256HashSchema,
	retention: z.literal(true).optional()
});
export type ParsedCommitBatchEntry = z.output<typeof commitBatchEntrySchema>;

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
	// Wire-freeze: entries reuse `commitBatchEntrySchema` and are bounded by
	// `commitBatchMaxEntries`; the server advertises `subscribe-identity` only
	// when it handles this op, so an older server never receives it.
	z.strictObject({
		op: z.literal('subscribe-identity'),
		entries: z.array(commitBatchEntrySchema).min(1).max(commitBatchMaxEntries)
	}),
	// Declares how many entries the session has queued and cannot send for want
	// of credit. The declaration is absolute and replaces the previous one, so a
	// client re-sends it as its queue grows without the server accumulating
	// stale demand. Sent only against a server that advertised `commit-credit`.
	z.strictObject({
		op: z.literal('request-credit'),
		entries: positiveIntSchema
	})
]);
export type ParsedCommitSessionRequest = z.output<
	typeof commitSessionRequestSchema
>;
export type CommitSessionRequest = z.input<typeof commitSessionRequestSchema>;

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

// The shapes a builder assembles: a schema's input is unbranded, so the CLI
// constructs a request body and the server a response body from these forms
// directly. The `Parsed…` outputs above are what a successful parse yields, and
// code that consumes a validated value takes that branded form.
export type UploadPathNegotiationFields = z.input<
	typeof uploadPathNegotiationSchema
>;
export type UploadBlobMetadataFields = z.input<typeof uploadBlobMetadataSchema>;
export type UploadPathMetadataFields = z.input<typeof uploadPathMetadataSchema>;
export type UploadAttachRoot = z.input<typeof uploadAttachRootSchema>;
export type UploadNegotiateRequest = z.input<
	typeof uploadNegotiateRequestSchema
>;
export type UploadActionDecision = z.input<typeof uploadActionDecisionSchema>;
export type UploadCommitDecision = z.input<typeof uploadCommitDecisionSchema>;
export type UploadDecision = z.input<typeof uploadDecisionSchema>;
export type UploadNegotiateResponse = z.input<
	typeof uploadNegotiateResponseSchema
>;
export type UploadPreviewRequest = z.input<typeof uploadPreviewRequestSchema>;
export type UploadPreviewDecision = z.input<typeof uploadPreviewDecisionSchema>;
export type UploadPreviewResponse = z.input<typeof uploadPreviewResponseSchema>;
export type UploadConfirmRequest = z.input<typeof uploadConfirmRequestSchema>;
export type UploadConfirmedPath = z.input<typeof uploadConfirmedPathSchema>;
export type UploadConfirmResponse = z.input<typeof uploadConfirmResponseSchema>;
export type CommitResponse = z.input<typeof commitResponseSchema>;
export type StatsResponse = z.input<typeof statsResponseSchema>;
export type UsageResponse = z.input<typeof usageResponseSchema>;
export type DeletePathResponse = z.input<typeof pathDeletionResponseSchema>;
