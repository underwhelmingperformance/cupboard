import { z } from 'zod';

import {
	cacheNameSchema,
	cachePrioritySchema,
	compressionSchema,
	DEFAULT_CACHE,
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
export type BootstrapResponse = z.input<typeof bootstrapResponseSchema>;
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
