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

// A batch probes the servability of every target of every root in one pass.
// Like one root-set request, that pass makes six calls per target plus four
// fixed calls. The batch makes the fixed calls once, so all of its targets
// together have the budget of one request. The tenant object refuses a batch
// whose entries cost more than this capacity with `ROOT_BATCH_LIMIT_EXCEEDED`.
// The refusal comes after the request has been parsed and authorised, but
// before the cache is resolved or any target is probed. The schema below leaves
// the number of entries open, so a client receives the typed refusal.
export const rootBatchCapacity = rootSetMaxTargets;

/**
Returns the part of `rootBatchCapacity` that one batch entry uses: one per
target, and one for an entry without targets. Every root in a batch is written
under the same write gate, so counting an empty entry keeps that work
proportional to the capacity. A client splits its roots across batches with
this function, so it agrees with the tenant object.
*/
export function rootBatchEntryCost(entry: {
	readonly targets: readonly string[];
}): number {
	return Math.max(1, entry.targets.length);
}

export const rootBatchLimitErrorCode = 'ROOT_BATCH_LIMIT_EXCEEDED';
export const rootBatchLimitErrorDataSchema = z.strictObject({
	capacity: countSchema
});

const rootBatchEntrySchema = z.discriminatedUnion('action', [
	rootSetBodySchema.extend({ action: z.literal('set'), name: rootNameSchema }),
	rootEnsureBodySchema.extend({
		action: z.literal('ensure'),
		name: rootNameSchema
	})
]);

// Each entry has the meaning of the single set or ensure request for its root.
// Two entries for one root would make the result depend on their order, so the
// names must be distinct.
export const rootBatchBodySchema = z.strictObject({
	roots: z
		.array(rootBatchEntrySchema)
		.min(1)
		.superRefine((roots, ctx) => {
			const seen = new Set<string>();

			for (const [index, entry] of roots.entries()) {
				if (seen.has(entry.name)) {
					ctx.addIssue({
						code: 'custom',
						path: [index, 'name'],
						message: `root '${entry.name}' appears more than once in the batch`
					});
				}

				seen.add(entry.name);
			}
		})
});
export type RootBatchBody = z.output<typeof rootBatchBodySchema>;

// One result per entry, in request order. A written root, from either action,
// is `retained`. An ensure is `build-required` when the cache cannot serve
// every one of its targets, which is also the single ensure's answer. A set is
// `targets-unavailable` when one of its targets has no committed narinfo, for
// which the single set returns 409. Neither of the last two changes the root.
export const rootBatchResultSchema = z.discriminatedUnion('status', [
	z.strictObject({
		name: rootNameSchema,
		status: z.literal('retained'),
		root: rootSummarySchema
	}),
	z.strictObject({
		name: rootNameSchema,
		status: z.literal('build-required'),
		unavailable: z.array(storePathSchema).min(1)
	}),
	z.strictObject({
		name: rootNameSchema,
		status: z.literal('targets-unavailable'),
		unavailable: z.array(storePathSchema).min(1)
	})
]);
export type RootBatchResult = z.output<typeof rootBatchResultSchema>;

export const rootBatchResponseSchema = z.strictObject({
	roots: z.array(rootBatchResultSchema)
});
export type RootBatchResponse = z.output<typeof rootBatchResponseSchema>;

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
