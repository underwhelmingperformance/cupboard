import {
	rootNameSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';
import { isoTimestampSchema } from './scalars.ts';

// The largest target set one root-set or root-ensure request may carry.
//
// Setting a root replaces its target set as a whole: every target is probed for
// servability, nothing is written if any is unavailable, the new set is swapped
// in under a write gate, and released targets enter retention grace. One request
// therefore cannot be split into several, because a partly replaced set would
// retain the wrong paths and the retention sweep would collect what the missing
// part was protecting.
//
// This bounds that one request and not a root. A run root is assembled across
// many requests through `attachRoot`, whose insert is additive and idempotent
// and carries no such bound, so a root's total target count is not limited here.
// A caller replacing more paths than this at once splits them across named
// roots, which `RootTargetLimitError` says.
//
// The number is far above what callers send. A root holds the targets a
// caller declares, not their closures, because collection reaches everything
// a target references. A push sends its declared targets alone, and a matrix
// run declares at most `maximumMatrixJobs` of them, 256, in
// `actions/src/commands/plan.ts`. So this is about four times the largest set
// the Action can ask to replace.
export const rootSetMaxTargets = 1000;

const rootTargetListSchema = z.array(storePathSchema).max(rootSetMaxTargets);

export const cacheRootRetentionSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('permanent') }),
	z.strictObject({
		kind: z.literal('duration'),
		seconds: ttlSecondsSchema
	})
]);
export type CacheRootRetention = z.output<typeof cacheRootRetentionSchema>;

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
// so a page of 200 targets makes at most 800 R2 requests. A caller reads every
// target by following the cursor the page returns. Root listings use the same
// page size to bound response size.
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
