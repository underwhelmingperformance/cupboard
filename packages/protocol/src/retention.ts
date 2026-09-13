import {
	cacheScopeSchema,
	graceSecondsSchema,
	rootNameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from './platform.ts';
import { isoTimestampSchema } from './scalars.ts';

// The largest target set one root-set or root-ensure request may carry.
//
// Either request replaces the root's whole target set: a target with no
// committed row refuses the whole request, the new set is swapped in under the
// write gate, and the targets it releases enter retention grace. A caller cannot
// split one set across two requests, because the second would replace the first
// and the sweep would collect what the missing part protected. A caller with
// more paths than this splits them across named roots, which
// `RootTargetLimitError` says.
//
// This bounds one request, not a root. A run root grows one target at a time
// through `attachRoot`, which is additive and unbounded.
//
// The full dispatch can make six calls per target and four fixed calls.
export const rootSetMaxTargets = Math.floor(
	(workersInvocationAllowances.free.subrequests - subrequestSafetyReserve - 4) /
		6
);

const rootTargetListSchema = z.array(storePathSchema).max(rootSetMaxTargets);

export const cacheRootRetentionSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('permanent') }),
	z.strictObject({
		kind: z.literal('duration'),
		seconds: ttlSecondsSchema
	})
]);
export type CacheRootRetention = z.output<typeof cacheRootRetentionSchema>;

// The server resolves `inherit` against the cache before writing the root's
// expiry. Stored cache defaults and overrides cannot themselves inherit.
export const rootRetentionRequestSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('inherit') }),
	...cacheRootRetentionSchema.options
]);
export type RootRetentionRequest = z.output<typeof rootRetentionRequestSchema>;

// A root update replaces the complete target list. The list may be empty when
// another cache serves the channel generation. An empty update deletes the
// target rows but preserves the root and its expiry. Released paths enter the
// normal retention grace period.
export const rootSetBodySchema = z.strictObject({
	targets: rootTargetListSchema,
	retention: rootRetentionRequestSchema.default({ kind: 'inherit' })
});
export type RootSetBody = z.output<typeof rootSetBodySchema>;

// An ensure request checks whether the cache already contains its targets and
// reports which targets require a build. The request must contain at least one
// target.
export const rootEnsureBodySchema = z.strictObject({
	targets: rootTargetListSchema.min(1),
	retention: rootRetentionRequestSchema.default({ kind: 'inherit' })
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

// A target page probes each distinct path for servability: its narinfo object
// and NAR, a repair of a missing narinfo object, and the repaired objects again,
// so a page at this limit fits the Free plan's usable slice. A caller reads every
// target by following the cursor the page returns. Root listings use the same
// page size to bound response size.
export const rootListPageSize = rootSetMaxTargets;

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

export type RootSetBodyInput = z.input<typeof rootSetBodySchema>;
export type RootEnsureBodyInput = z.input<typeof rootEnsureBodySchema>;
export type RootTargetInput = z.input<typeof rootTargetSchema>;
export type RootSummaryInput = z.input<typeof rootSummarySchema>;
export type RootSetResponseInput = z.input<typeof rootSetResponseSchema>;
export type RootEnsureResponseInput = z.input<typeof rootEnsureResponseSchema>;
export type RootListEntryInput = z.input<typeof rootListEntrySchema>;
export type RootListResponseInput = z.input<typeof rootListResponseSchema>;
export type RootTargetsPageInput = z.input<typeof rootTargetsPageSchema>;
export type RootRemoveResponseInput = z.input<typeof rootRemoveResponseSchema>;

// Legacy policies remain readable and removable until local step 4 completes.
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

export type RetentionPolicySummaryInput = z.input<
	typeof retentionPolicySummarySchema
>;

export type RetentionPolicyListResponseInput = z.input<
	typeof retentionPolicyListResponseSchema
>;

export type RetentionPolicyRemoveResponseInput = z.input<
	typeof retentionPolicyRemoveResponseSchema
>;

export type GracePolicySummaryInput = z.input<typeof gracePolicySummarySchema>;

export type GracePolicyListResponseInput = z.input<
	typeof gracePolicyListResponseSchema
>;

export type GracePolicyRemoveResponseInput = z.input<
	typeof gracePolicyRemoveResponseSchema
>;
