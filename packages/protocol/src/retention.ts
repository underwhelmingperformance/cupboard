import {
	cacheNamePrefixPattern,
	cacheScopeSchema,
	graceSecondsSchema,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

// A root can contain at most 1,000 targets. Updating a root probes the narinfo
// and canonical NAR for each distinct target, then replaces its target rows. The
// limit bounds both R2 requests and SQL statement size within one Durable Object
// request.
export const rootSetMaxTargets = 1000;

const rootTargetListSchema = z.array(storePathSchema).max(rootSetMaxTargets);

// A root update replaces the complete target list. The list may be empty when
// another cache serves the channel generation. An empty update deletes the
// target rows but preserves the root and its expiry. Released paths enter the
// normal retention grace period.
export const rootSetBodySchema = z.strictObject({
	targets: rootTargetListSchema,
	ttlSeconds: ttlSecondsSchema.optional()
});
export type RootSetBody = z.output<typeof rootSetBodySchema>;

// An ensure request checks whether the cache already contains its targets and
// reports which targets require a build. The request must contain at least one
// target.
export const rootEnsureBodySchema = z.strictObject({
	targets: rootTargetListSchema.min(1),
	ttlSeconds: ttlSecondsSchema.optional()
});
export type RootEnsureBody = z.output<typeof rootEnsureBodySchema>;

export const rootTargetSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	present: z.boolean()
});
export type RootTarget = z.output<typeof rootTargetSchema>;

export const rootSummarySchema = z.strictObject({
	name: rootNameSchema,
	expiresAt: isoTimestampSchema.optional(),
	expired: z.boolean(),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	targets: z.array(rootTargetSchema)
});
export type RootSummary = z.output<typeof rootSummarySchema>;

export const rootSetResponseSchema = rootSummarySchema;
export type RootSetResponse = z.output<typeof rootSetResponseSchema>;

export const rootEnsureResponseSchema = z.discriminatedUnion('status', [
	z.strictObject({
		status: z.literal('retained'),
		root: rootSummarySchema
	}),
	z.strictObject({
		status: z.literal('build-required'),
		unavailable: z.array(storePathSchema).min(1)
	})
]);
export type RootEnsureResponse = z.output<typeof rootEnsureResponseSchema>;

// A target page probes the narinfo object for each distinct path. A page contains
// at most 200 targets so one request remains below the internal subrequest
// limit. Root listings use the same page size to bound response size.
export const rootListPageSize = 200;

// Clients must return the cursor unchanged to resume a listing. Its contents
// are opaque.
const listCursorSchema = z.string().min(1);

// A run root can accumulate attached paths without bound. Listings therefore
// report a target count, and clients read the targets through the paged route.
export const rootListEntrySchema = z.strictObject({
	name: rootNameSchema,
	expiresAt: isoTimestampSchema.optional(),
	expired: z.boolean(),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	targetCount: countSchema
});
export type RootListEntry = z.output<typeof rootListEntrySchema>;

export const rootListResponseSchema = z.strictObject({
	roots: z.array(rootListEntrySchema),
	cursor: listCursorSchema.optional()
});
export type RootListResponse = z.output<typeof rootListResponseSchema>;

export const rootTargetsPageSchema = z.strictObject({
	targets: z.array(rootTargetSchema),
	cursor: listCursorSchema.optional()
});
export type RootTargetsPage = z.output<typeof rootTargetsPageSchema>;

export const rootRemoveResponseSchema = z.strictObject({
	name: rootNameSchema,
	removed: z.boolean()
});
export type RootRemoveResponse = z.output<typeof rootRemoveResponseSchema>;

// Each response reports only one bounded collection pass. The counts cover
// expired roots, collected paths, pending uploads and attestations, narinfo
// rows, and untracked staging objects.
export const gcResponseSchema = z.strictObject({
	ok: z.literal(true),
	pendingUploadsDeleted: countSchema,
	pendingAttestationsDeleted: countSchema,
	rootsExpired: countSchema,
	pathsCollected: countSchema,
	narInfosDeleted: countSchema,
	orphanStagingDeleted: countSchema
});
export type GcResponse = z.output<typeof gcResponseSchema>;
export type GcResponseInput = z.input<typeof gcResponseSchema>;

// A retention policy applies a default TTL to roots by cache or by root-name
// prefix (the pattern is a literal prefix).
export const retentionPolicyScopeSchema = z.enum(['cache', 'root-name-prefix']);
export type RetentionPolicyScope = z.infer<typeof retentionPolicyScopeSchema>;

export const retentionPolicyAddBodySchema = z.discriminatedUnion('scope', [
	z.strictObject({
		scope: z.literal('cache'),
		cache: cacheScopeSchema,
		ttlSeconds: ttlSecondsSchema
	}),
	z.strictObject({
		scope: z.literal('root-name-prefix'),
		pattern: z.string().min(1),
		ttlSeconds: ttlSecondsSchema
	})
]);
export type RetentionPolicyAddBody = z.output<
	typeof retentionPolicyAddBodySchema
>;

export const retentionPolicySummarySchema = z.discriminatedUnion('scope', [
	z.strictObject({
		id: z.string(),
		scope: z.literal('cache'),
		cache: cacheScopeSchema,
		ttlSeconds: ttlSecondsSchema
	}),
	z.strictObject({
		id: z.string(),
		scope: z.literal('root-name-prefix'),
		pattern: z.string().min(1),
		ttlSeconds: ttlSecondsSchema
	})
]);
export type RetentionPolicySummary = z.output<
	typeof retentionPolicySummarySchema
>;

export const retentionPolicyListResponseSchema = z.strictObject({
	policies: z.array(retentionPolicySummarySchema)
});
export type RetentionPolicyListResponse = z.output<
	typeof retentionPolicyListResponseSchema
>;

export const retentionPolicyRemoveResponseSchema = z.strictObject({
	id: z.string(),
	removed: z.boolean()
});
export type RetentionPolicyRemoveResponse = z.output<
	typeof retentionPolicyRemoveResponseSchema
>;

// A retention-grace policy applies to paths published in caches whose names
// start with `cachePrefix`. The empty prefix is the tenant-wide default, and the
// longest matching prefix wins. A prefix must be able to start a valid cache
// name, and cannot be longer than a cache name.
const gracePrefixMaxLength = 63;

export const gracePolicyAddBodySchema = z.strictObject({
	cachePrefix: z
		.string()
		.max(gracePrefixMaxLength)
		.regex(cacheNamePrefixPattern, {
			message: 'cachePrefix must be a valid cache-name prefix'
		}),
	graceSeconds: graceSecondsSchema
});
export type GracePolicyAddBody = z.output<typeof gracePolicyAddBodySchema>;

export const gracePolicySummarySchema = z.strictObject({
	id: z.string(),
	cachePrefix: z.string(),
	graceSeconds: graceSecondsSchema,
	createdAt: isoTimestampSchema
});
export type GracePolicySummary = z.output<typeof gracePolicySummarySchema>;

export const gracePolicyListResponseSchema = z.strictObject({
	policies: z.array(gracePolicySummarySchema)
});
export type GracePolicyListResponse = z.output<
	typeof gracePolicyListResponseSchema
>;

export const gracePolicyRemoveResponseSchema = z.strictObject({
	id: z.string(),
	removed: z.boolean()
});
export type GracePolicyRemoveResponse = z.output<
	typeof gracePolicyRemoveResponseSchema
>;

// For a covered cache, the response reports the grace period that a publication
// would resolve. The longest matching cache-name prefix wins, as it does for a
// push. An uncovered cache has no grace period in the response.
export const graceCoverageResponseSchema = z.discriminatedUnion('covered', [
	z.strictObject({
		covered: z.literal(true),
		graceSeconds: graceSecondsSchema
	}),
	z.strictObject({ covered: z.literal(false) })
]);
export type GraceCoverageResponse = z.output<
	typeof graceCoverageResponseSchema
>;

export type RootSetBodyInput = z.input<typeof rootSetBodySchema>;
export type RootTargetInput = z.input<typeof rootTargetSchema>;
export type RootSummaryInput = z.input<typeof rootSummarySchema>;
export type RootSetResponseInput = z.input<typeof rootSetResponseSchema>;
export type RootEnsureResponseInput = z.input<typeof rootEnsureResponseSchema>;
export type RootListEntryInput = z.input<typeof rootListEntrySchema>;
export type RootListResponseInput = z.input<typeof rootListResponseSchema>;
export type RootTargetsPageInput = z.input<typeof rootTargetsPageSchema>;
export type RootRemoveResponseInput = z.input<typeof rootRemoveResponseSchema>;
export type RetentionPolicyAddBodyInput = z.input<
	typeof retentionPolicyAddBodySchema
>;
export type RetentionPolicySummaryInput = z.input<
	typeof retentionPolicySummarySchema
>;
export type RetentionPolicyListResponseInput = z.input<
	typeof retentionPolicyListResponseSchema
>;
export type RetentionPolicyRemoveResponseInput = z.input<
	typeof retentionPolicyRemoveResponseSchema
>;
export type GracePolicyAddBodyInput = z.input<typeof gracePolicyAddBodySchema>;
export type GracePolicySummaryInput = z.input<typeof gracePolicySummarySchema>;
export type GracePolicyListResponseInput = z.input<
	typeof gracePolicyListResponseSchema
>;
export type GraceCoverageResponseInput = z.input<
	typeof graceCoverageResponseSchema
>;
export type GracePolicyRemoveResponseInput = z.input<
	typeof gracePolicyRemoveResponseSchema
>;
