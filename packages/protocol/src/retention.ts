import {
	cacheNamePrefixPattern,
	rootNameSchema,
	rootTtlMaxSeconds,
	storedCacheSchema,
	storePathHashSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { countSchema } from './internal/counts.ts';

// One root names a bounded target list. Ensuring a root probes each
// distinct target's narinfo object and canonical NAR in R2 and rewrites the
// root's target rows, so the bound keeps one request's probe fan-out and
// statement size within what a single Durable Object request can serve.
export const rootSetMaxTargets = 1000;

export const rootSetBodySchema = z.strictObject({
	targets: z.array(storePathSchema).min(1).max(rootSetMaxTargets),
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

// One garbage-collection sweep's counts: expired roots, swept paths, the pending
// and committed rows it removed, and the untracked staging objects it reclaimed.
export const gcResponseSchema = z.strictObject({
	ok: z.literal(true),
	pendingUploadsDeleted: countSchema,
	pendingAttestationsDeleted: countSchema,
	rootsExpired: countSchema,
	pathsSwept: countSchema,
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

// A retention grace policy applies its grace period to every path published to
// a cache whose name starts with `cachePrefix`; the empty prefix is the
// tenant-wide default, and the longest matching prefix wins. The prefix is
// bounded by a cache name's own maximum length, since a longer prefix could
// never match one.
const gracePrefixMaxLength = 63;

const graceSecondsSchema = z.number().int().min(0).max(rootTtlMaxSeconds);

export const gracePolicyAddBodySchema = z.strictObject({
	// The prefix must be a prefix of some legal cache name, or the policy
	// could never match anything: a typo such as an uppercase letter would
	// otherwise be stored and silently defeat the retention guarantee grace
	// mode exists to provide.
	cachePrefix: z
		.string()
		.max(gracePrefixMaxLength)
		.regex(cacheNamePrefixPattern, {
			message: 'cachePrefix must be a prefix of a valid cache name'
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
	createdAt: z.string()
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

// Whether a grace policy covers a cache: a covered cache carries the grace a
// publication to it would resolve (the longest matching cache-name prefix
// wins, the same resolution a push is granted), an uncovered cache carries
// nothing.
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
export type RootListResponse = z.input<typeof rootListResponseSchema>;
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
