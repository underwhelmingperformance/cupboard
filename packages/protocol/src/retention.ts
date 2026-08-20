import {
	cacheNamePrefixPattern,
	graceSecondsSchema,
	rootNameSchema,
	storedCacheSchema,
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
export type ParsedRootSetBody = z.output<typeof rootSetBodySchema>;

// An ensure asks whether the cache already holds the named targets and reports
// which of them require a build, so the request must name at least one target.
export const rootEnsureBodySchema = z.strictObject({
	targets: rootTargetListSchema.min(1),
	ttlSeconds: ttlSecondsSchema.optional()
});
export type ParsedRootEnsureBody = z.output<typeof rootEnsureBodySchema>;

export const rootTargetSchema = z.strictObject({
	storePathHash: storePathHashSchema,
	storePath: storePathSchema,
	present: z.boolean()
});
export type ParsedRootTarget = z.output<typeof rootTargetSchema>;

export const rootSummarySchema = z.strictObject({
	name: rootNameSchema,
	expiresAt: isoTimestampSchema.optional(),
	expired: z.boolean(),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	targets: z.array(rootTargetSchema)
});
export type ParsedRootSummary = z.output<typeof rootSummarySchema>;

// A set-root response is a root summary; the named alias documents the route.
export const rootSetResponseSchema = rootSummarySchema;
export type ParsedRootSetResponse = z.output<typeof rootSetResponseSchema>;

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
export type ParsedRootEnsureResponse = z.output<
	typeof rootEnsureResponseSchema
>;

// A target page probes the narinfo object for each distinct path. A page contains
// at most 200 targets so one request remains below the internal subrequest
// limit. Root listings use the same page size to bound response size.
export const rootListPageSize = 200;

// A continuation for a listing with more pages: opaque to the client, passed
// back unchanged to resume where the previous page stopped.
const listCursorSchema = z.string().min(1);

// One root in the listing. A run root can accumulate attached paths without
// bound, so the listing reports a target count instead of the targets
// themselves; a root's targets are read through the paged targets route.
export const rootListEntrySchema = z.strictObject({
	name: rootNameSchema,
	expiresAt: isoTimestampSchema.optional(),
	expired: z.boolean(),
	createdAt: isoTimestampSchema,
	updatedAt: isoTimestampSchema,
	targetCount: countSchema
});
export type ParsedRootListEntry = z.output<typeof rootListEntrySchema>;

export const rootListResponseSchema = z.strictObject({
	roots: z.array(rootListEntrySchema),
	cursor: listCursorSchema.optional()
});
export type ParsedRootListResponse = z.output<typeof rootListResponseSchema>;

export const rootTargetsPageSchema = z.strictObject({
	targets: z.array(rootTargetSchema),
	cursor: listCursorSchema.optional()
});
export type ParsedRootTargetsPage = z.output<typeof rootTargetsPageSchema>;

export const rootRemoveResponseSchema = z.strictObject({
	name: rootNameSchema,
	removed: z.boolean()
});
export type ParsedRootRemoveResponse = z.output<
	typeof rootRemoveResponseSchema
>;

// One garbage-collection pass's counts: expired roots, collected paths, the
// pending and committed rows it removed, and the untracked staging objects it
// reclaimed.
export const gcResponseSchema = z.strictObject({
	ok: z.literal(true),
	pendingUploadsDeleted: countSchema,
	pendingAttestationsDeleted: countSchema,
	rootsExpired: countSchema,
	pathsCollected: countSchema,
	narInfosDeleted: countSchema,
	orphanStagingDeleted: countSchema
});
export type ParsedGcResponse = z.output<typeof gcResponseSchema>;
export type GcResponse = z.input<typeof gcResponseSchema>;

// A retention policy applies a default TTL to roots by cache (the pattern is a
// cache name, or the empty string for the default cache) or by root-name prefix
// (the pattern is a literal prefix).
export const retentionPolicyScopeSchema = z.enum(['cache', 'root-name-prefix']);
export type RetentionPolicyScope = z.infer<typeof retentionPolicyScopeSchema>;

export const retentionPolicyAddBodySchema = z.discriminatedUnion('scope', [
	z.strictObject({
		scope: z.literal('cache'),
		pattern: storedCacheSchema,
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

// A retention-grace policy applies to paths published in caches whose names
// start with `cachePrefix`. The empty prefix is the tenant-wide default, and the
// longest matching prefix wins. A prefix cannot exceed the maximum cache-name
// length because a longer value could not match a cache.
const gracePrefixMaxLength = 63;

export const gracePolicyAddBodySchema = z.strictObject({
	// The prefix must also be the prefix of a valid cache name. This rejects values
	// such as uppercase cache names that could never match.
	cachePrefix: z
		.string()
		.max(gracePrefixMaxLength)
		.regex(cacheNamePrefixPattern, {
			message: 'cachePrefix must be a valid cache-name prefix'
		}),
	graceSeconds: graceSecondsSchema
});
export type ParsedGracePolicyAddBody = z.output<
	typeof gracePolicyAddBodySchema
>;

export const gracePolicySummarySchema = z.strictObject({
	id: z.string(),
	cachePrefix: z.string(),
	graceSeconds: graceSecondsSchema,
	createdAt: isoTimestampSchema
});
export type ParsedGracePolicySummary = z.output<
	typeof gracePolicySummarySchema
>;

export const gracePolicyListResponseSchema = z.strictObject({
	policies: z.array(gracePolicySummarySchema)
});
export type ParsedGracePolicyListResponse = z.output<
	typeof gracePolicyListResponseSchema
>;

export const gracePolicyRemoveResponseSchema = z.strictObject({
	id: z.string(),
	removed: z.boolean()
});
export type ParsedGracePolicyRemoveResponse = z.output<
	typeof gracePolicyRemoveResponseSchema
>;

// Whether a grace policy covers a cache. For a covered cache the response
// reports the grace a publication to it would resolve, the longest matching
// cache-name prefix winning exactly as it does for a push. For an uncovered
// cache it reports no grace period at all.
export const graceCoverageResponseSchema = z.discriminatedUnion('covered', [
	z.strictObject({
		covered: z.literal(true),
		graceSeconds: graceSecondsSchema
	}),
	z.strictObject({ covered: z.literal(false) })
]);
export type ParsedGraceCoverageResponse = z.output<
	typeof graceCoverageResponseSchema
>;

export type RootSetBody = z.input<typeof rootSetBodySchema>;
export type RootTarget = z.input<typeof rootTargetSchema>;
export type RootSummary = z.input<typeof rootSummarySchema>;
export type RootSetResponse = z.input<typeof rootSetResponseSchema>;
export type RootEnsureResponse = z.input<typeof rootEnsureResponseSchema>;
export type RootListEntry = z.input<typeof rootListEntrySchema>;
export type RootListResponse = z.input<typeof rootListResponseSchema>;
export type RootTargetsPage = z.input<typeof rootTargetsPageSchema>;
export type RootRemoveResponse = z.input<typeof rootRemoveResponseSchema>;
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
export type GracePolicyAddBody = z.input<typeof gracePolicyAddBodySchema>;
export type GracePolicySummary = z.input<typeof gracePolicySummarySchema>;
export type GracePolicyListResponse = z.input<
	typeof gracePolicyListResponseSchema
>;
export type GraceCoverageResponse = z.input<typeof graceCoverageResponseSchema>;
export type GracePolicyRemoveResponse = z.input<
	typeof gracePolicyRemoveResponseSchema
>;
