import { z } from 'zod';

import {
	cacheNameSchema,
	cachePrioritySchema,
	compressionSchema,
	DEFAULT_CACHE,
	isAllowedIssuerUrl,
	IssuerUrl,
	nixSha256HashSchema,
	positiveIntSchema,
	referencesSchema,
	rootNameSchema,
	signingKeyIdSchema,
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

export const rootSetBodySchema = z.strictObject({
	targets: z.array(storePathSchema).min(1),
	ttlSeconds: ttlSecondsSchema.optional()
});
export type ParsedRootSetBody = z.output<typeof rootSetBodySchema>;

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

export const rootRemoveResponseSchema = z.strictObject({
	name: rootNameSchema,
	removed: z.boolean()
});
export type ParsedRootRemoveResponse = z.output<
	typeof rootRemoveResponseSchema
>;

// A key signs new narinfos (`signing`), is advertised from `/pubkey` while
// clients may still trust it (`publication`), or has been dropped (`absent`).
export const signingKeyStageSchema = z.enum([
	'signing',
	'publication',
	'absent'
]);
export type SigningKeyStage = z.infer<typeof signingKeyStageSchema>;

export const signingKeySummarySchema = z.strictObject({
	id: signingKeyIdSchema,
	publicKey: z.string(),
	stage: signingKeyStageSchema,
	createdAt: z.string()
});
export type ParsedSigningKeySummary = z.output<typeof signingKeySummarySchema>;

export const keyListResponseSchema = z.strictObject({
	keys: z.array(signingKeySummarySchema)
});
export type ParsedKeyListResponse = z.output<typeof keyListResponseSchema>;

export const keyRotateResponseSchema = z.strictObject({
	rotated: signingKeySummarySchema,
	keys: z.array(signingKeySummarySchema)
});
export type ParsedKeyRotateResponse = z.output<typeof keyRotateResponseSchema>;

export const keyRetireResponseSchema = z.strictObject({
	id: signingKeyIdSchema,
	stage: signingKeyStageSchema
});
export type ParsedKeyRetireResponse = z.output<typeof keyRetireResponseSchema>;

// The auth-token signing keys. `active` marks the key that currently mints;
// every listed key still verifies and is published in the JWKS.
export const authKeySummarySchema = z.strictObject({
	kid: z.string(),
	createdAt: z.string(),
	active: z.boolean()
});
export type ParsedAuthKeySummary = z.output<typeof authKeySummarySchema>;

export const authKeyListResponseSchema = z.strictObject({
	keys: z.array(authKeySummarySchema)
});
export type ParsedAuthKeyListResponse = z.output<
	typeof authKeyListResponseSchema
>;

export const authKeyRotateResponseSchema = z.strictObject({
	rotated: z.string(),
	keys: z.array(authKeySummarySchema)
});
export type ParsedAuthKeyRotateResponse = z.output<
	typeof authKeyRotateResponseSchema
>;

export const authKeyRetireResponseSchema = z.strictObject({
	kid: z.string(),
	retired: z.boolean()
});
export type ParsedAuthKeyRetireResponse = z.output<
	typeof authKeyRetireResponseSchema
>;

// A cache summary names a cache (the empty string is the default), its Nix
// priority and how many store paths it holds.
export const cacheSummarySchema = z.strictObject({
	name: z.string(),
	priority: cachePrioritySchema,
	storePaths: countSchema
});
export type ParsedCacheSummary = z.output<typeof cacheSummarySchema>;

export const cacheListResponseSchema = z.strictObject({
	caches: z.array(cacheSummarySchema)
});
export type ParsedCacheListResponse = z.output<typeof cacheListResponseSchema>;

export const cachePutBodySchema = z.strictObject({
	priority: cachePrioritySchema
});
export type ParsedCachePutBody = z.output<typeof cachePutBodySchema>;

export const cacheRemoveResponseSchema = z.strictObject({
	name: z.string(),
	removed: z.boolean(),
	storePathsRemoved: countSchema
});
export type ParsedCacheRemoveResponse = z.output<
	typeof cacheRemoveResponseSchema
>;

// A retention policy applies a default TTL to roots by cache (the pattern is a
// cache name, or the empty string for the default cache) or by root-name prefix
// (the pattern is a literal prefix).
export const retentionPolicyScopeSchema = z.enum(['cache', 'root-name-prefix']);
export type RetentionPolicyScope = z.infer<typeof retentionPolicyScopeSchema>;

export const retentionPolicyAddBodySchema = z.discriminatedUnion('scope', [
	z.strictObject({
		scope: z.literal('cache'),
		pattern: z.union([z.literal(DEFAULT_CACHE), cacheNameSchema]),
		ttlSeconds: ttlSecondsSchema
	}),
	z.strictObject({
		scope: z.literal('root-name-prefix'),
		pattern: z.string().min(1),
		ttlSeconds: ttlSecondsSchema
	})
]);
export type ParsedRetentionPolicyAddBody = z.output<
	typeof retentionPolicyAddBodySchema
>;

export const retentionPolicySummarySchema = z.strictObject({
	id: z.string(),
	scope: retentionPolicyScopeSchema,
	pattern: z.string(),
	ttlSeconds: ttlSecondsSchema
});
export type ParsedRetentionPolicySummary = z.output<
	typeof retentionPolicySummarySchema
>;

export const retentionPolicyListResponseSchema = z.strictObject({
	policies: z.array(retentionPolicySummarySchema)
});
export type ParsedRetentionPolicyListResponse = z.output<
	typeof retentionPolicyListResponseSchema
>;

export const retentionPolicyRemoveResponseSchema = z.strictObject({
	id: z.string(),
	removed: z.boolean()
});
export type ParsedRetentionPolicyRemoveResponse = z.output<
	typeof retentionPolicyRemoveResponseSchema
>;

// A storage check reconciles committed metadata against R2: a NAR blob is
// missing, a narinfo R2 object is missing, or a deep file-hash recompute does
// not match the recorded hash.
export const checkDiscrepancyKindSchema = z.enum([
	'missing-nar',
	'missing-narinfo-object',
	'file-hash-mismatch',
	'nar-hash-mismatch',
	'nar-size-mismatch',
	'undecodable'
]);
export type CheckDiscrepancyKind = z.infer<typeof checkDiscrepancyKindSchema>;

export const checkDiscrepancySchema = z.strictObject({
	kind: checkDiscrepancyKindSchema,
	cache: z.string(),
	storePathHash: z.string(),
	narHash: z.string()
});
export type ParsedCheckDiscrepancy = z.output<typeof checkDiscrepancySchema>;

export const checkReportSchema = z.strictObject({
	narInfosChecked: countSchema,
	narBlobsChecked: countSchema,
	complete: z.boolean(),
	discrepancies: z.array(checkDiscrepancySchema)
});
export type ParsedCheckReport = z.output<typeof checkReportSchema>;

// One bounded pass of background verification: how many narinfo rows it scanned,
// how many missing narinfo objects it re-materialised, how many dangling
// narinfos (their NAR gone) it removed, and the resume position as a composite
// (cursorCache, cursor) — both empty once the scan has wrapped, so the next pass
// starts at the first cache's lowest store path hash.
export const verifyReportSchema = z.strictObject({
	scanned: countSchema,
	narInfoObjectsRestored: countSchema,
	danglingNarInfosRemoved: countSchema,
	cursor: z.string(),
	cursorCache: z.string(),
	wrapped: z.boolean()
});
export type ParsedVerifyReport = z.output<typeof verifyReportSchema>;

// RFC 8693 token-exchange is the only grant the token endpoint accepts. The
// subject token is an external OIDC JWT — the owner's `id_token` or a CI GitHub
// Actions token. The issued cupboard token is reported as an access token.
export const tokenExchangeGrantType =
	'urn:ietf:params:oauth:grant-type:token-exchange';
export const issuedAccessTokenType =
	'urn:ietf:params:oauth:token-type:access_token';

// The subject token is a JWT either way. cupboard accepts only these two RFC 8693
// type identifiers and verifies both the same way, rejecting any other type. Its
// callers present an `id_token`; `jwt` is accepted for clients that label a plain
// OIDC JWT with the generic type.
export const subjectTokenTypeIdToken =
	'urn:ietf:params:oauth:token-type:id_token';
export const subjectTokenTypeJwt = 'urn:ietf:params:oauth:token-type:jwt';

// The optional fields RFC 8693 permits (`audience`, `scope`, `resource`, …) are
// accepted and ignored: the matched trust rule alone fixes the issued scope and
// audience, so a non-strict object strips them rather than rejecting the request.
export const tokenExchangeRequestSchema = z.object({
	grant_type: z.string().min(1),
	subject_token: z.string().min(1),
	subject_token_type: z.string().min(1)
});
export type ParsedTokenExchangeRequest = z.output<
	typeof tokenExchangeRequestSchema
>;

// The token endpoint's success body (RFC 6749 §5.1 / RFC 8693 §2.2.1). The
// access token is the cupboard JWT; `issued_token_type` is present for the
// token-exchange grant. Field names are the OAuth wire spelling.
export const tokenResponseSchema = z.strictObject({
	access_token: z.string(),
	token_type: z.literal('Bearer'),
	expires_in: positiveIntSchema,
	scope: z.string().optional(),
	issued_token_type: z.string().optional()
});
export type ParsedTokenResponse = z.output<typeof tokenResponseSchema>;

// A trust rule federates an external OIDC identity into a cupboard scope. The
// owner's `admin` rule is seeded from deploy config; `write` rules (CI) are
// managed through the admin API and bind the minted token to `allowedRoots`.
export const oidcTrustScopeSchema = z.enum(['write', 'admin']);
export type OidcTrustScope = z.infer<typeof oidcTrustScopeSchema>;

export const oidcTrustAddBodySchema = z.strictObject({
	issuer: z
		.url()
		.refine(
			isAllowedIssuerUrl,
			'issuer must be an https URL (http only for loopback)'
		)
		.transform((value) => IssuerUrl.parse(value)?.value ?? value),
	audience: z.string().min(1),
	claims: z
		.record(z.string().min(1), z.string())
		.refine(
			(value) => Object.keys(value).length > 0,
			'at least one claim is required to bind the rule'
		),
	allowedRoots: z.array(z.string().min(1))
});
export type ParsedOidcTrustAddBody = z.output<typeof oidcTrustAddBodySchema>;

export const oidcTrustSummarySchema = z.strictObject({
	id: z.string(),
	issuer: z.string(),
	audience: z.string(),
	scope: oidcTrustScopeSchema,
	claims: z.record(z.string(), z.string()),
	allowedRoots: z.array(z.string()),
	disabled: z.boolean()
});
export type ParsedOidcTrustSummary = z.output<typeof oidcTrustSummarySchema>;

export const oidcTrustListResponseSchema = z.strictObject({
	rules: z.array(oidcTrustSummarySchema)
});
export type ParsedOidcTrustListResponse = z.output<
	typeof oidcTrustListResponseSchema
>;

export const oidcTrustRemoveResponseSchema = z.strictObject({
	id: z.string(),
	removed: z.boolean()
});
export type ParsedOidcTrustRemoveResponse = z.output<
	typeof oidcTrustRemoveResponseSchema
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
export type RootSetBody = z.input<typeof rootSetBodySchema>;
export type RootTarget = z.input<typeof rootTargetSchema>;
export type RootSummary = z.input<typeof rootSummarySchema>;
export type RootSetResponse = z.input<typeof rootSetResponseSchema>;
export type RootListResponse = z.input<typeof rootListResponseSchema>;
export type RootRemoveResponse = z.input<typeof rootRemoveResponseSchema>;
export type SigningKeySummary = z.input<typeof signingKeySummarySchema>;
export type KeyListResponse = z.input<typeof keyListResponseSchema>;
export type KeyRotateResponse = z.input<typeof keyRotateResponseSchema>;
export type KeyRetireResponse = z.input<typeof keyRetireResponseSchema>;
export type AuthKeySummary = z.input<typeof authKeySummarySchema>;
export type AuthKeyListResponse = z.input<typeof authKeyListResponseSchema>;
export type AuthKeyRotateResponse = z.input<typeof authKeyRotateResponseSchema>;
export type AuthKeyRetireResponse = z.input<typeof authKeyRetireResponseSchema>;
export type CacheSummary = z.input<typeof cacheSummarySchema>;
export type CacheListResponse = z.input<typeof cacheListResponseSchema>;
export type CachePutBody = z.input<typeof cachePutBodySchema>;
export type CacheRemoveResponse = z.input<typeof cacheRemoveResponseSchema>;
export type RetentionPolicyAddBody = z.input<
	typeof retentionPolicyAddBodySchema
>;
export type RetentionPolicySummary = z.input<
	typeof retentionPolicySummarySchema
>;
export type RetentionPolicyListResponse = z.input<
	typeof retentionPolicyListResponseSchema
>;
export type RetentionPolicyRemoveResponse = z.input<
	typeof retentionPolicyRemoveResponseSchema
>;
export type CheckDiscrepancy = z.input<typeof checkDiscrepancySchema>;
export type CheckReport = z.input<typeof checkReportSchema>;
export type VerifyReport = z.input<typeof verifyReportSchema>;
export type TokenExchangeRequest = z.input<typeof tokenExchangeRequestSchema>;
export type TokenResponse = z.input<typeof tokenResponseSchema>;
export type OidcTrustAddBody = z.input<typeof oidcTrustAddBodySchema>;
export type OidcTrustSummary = z.input<typeof oidcTrustSummarySchema>;
export type OidcTrustListResponse = z.input<typeof oidcTrustListResponseSchema>;
export type OidcTrustRemoveResponse = z.input<
	typeof oidcTrustRemoveResponseSchema
>;
