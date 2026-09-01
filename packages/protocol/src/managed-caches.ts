import {
	cacheAccessModeSchema,
	cacheNameSchema,
	cachePrioritySchema,
	graceSecondsSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import { cacheRootRetentionSchema } from './retention.ts';
import {
	managedCacheGroupIdSchema,
	reuseViewDefaultPriority,
	reuseViewNameSchema,
	reuseViewPrioritySchema
} from './reuse-views.ts';
import { isoTimestampSchema } from './scalars.ts';

function requireCoherentRootRetention(
	value: {
		readonly defaultRootRetention: z.infer<typeof cacheRootRetentionSchema>;
		readonly maximumRootDurationSeconds: z.infer<typeof ttlSecondsSchema>;
		readonly allowPermanentRoots: boolean;
	},
	context: z.RefinementCtx
): void {
	if (
		value.defaultRootRetention.kind === 'permanent' &&
		!value.allowPermanentRoots
	) {
		context.addIssue({
			code: 'custom',
			message: 'permanent default retention requires permanent roots',
			path: ['defaultRootRetention']
		});
	}

	if (
		value.defaultRootRetention.kind === 'duration' &&
		value.defaultRootRetention.seconds > value.maximumRootDurationSeconds
	) {
		context.addIssue({
			code: 'custom',
			message: 'default root duration exceeds the policy maximum',
			path: ['defaultRootRetention', 'seconds']
		});
	}
}

export const managedPolicyIdSchema = z.uuid().brand('ManagedPolicyId');
export type ManagedPolicyId = z.infer<typeof managedPolicyIdSchema>;

export const managedPolicyRevisionSchema = z
	.int()
	.positive()
	.brand('ManagedPolicyRevision');
export type ManagedPolicyRevision = z.infer<typeof managedPolicyRevisionSchema>;

export const githubOwnerIdSchema = z
	.string()
	.regex(/^\d+$/)
	.brand('GitHubOwnerId');
export type GitHubOwnerId = z.infer<typeof githubOwnerIdSchema>;

export const githubRepositoryIdSchema = z
	.string()
	.regex(/^\d+$/)
	.brand('GitHubRepositoryId');
export type GitHubRepositoryId = z.infer<typeof githubRepositoryIdSchema>;

export const managedCacheNamespaceSchema = cacheNameSchema
	.refine((value) => value.endsWith('-'), 'namespace must end with a hyphen')
	.refine(
		(value) => cacheNameSchema.safeParse(`${value}1`).success,
		'namespace must leave room for a pull-request number'
	)
	.brand('ManagedCacheNamespace');
export type ManagedCacheNamespace = z.infer<typeof managedCacheNamespaceSchema>;

export const managedPolicyStatusSchema = z.enum([
	'active',
	'updating',
	'update-failed',
	'retiring'
]);
export type ManagedPolicyStatus = z.infer<typeof managedPolicyStatusSchema>;

export const cacheLifecycleStateSchema = z.enum([
	'creating',
	'active',
	'retiring',
	'deleted'
]);
export type CacheLifecycleState = z.infer<typeof cacheLifecycleStateSchema>;

export const durableCacheManagementSchema = z.strictObject({
	kind: z.literal('durable')
});
export const managedCacheManagementSchema = z.strictObject({
	kind: z.literal('managed'),
	policyId: managedPolicyIdSchema,
	policyRevision: managedPolicyRevisionSchema,
	groupId: managedCacheGroupIdSchema,
	leaseExpiresAt: isoTimestampSchema
});
export const cacheManagementSchema = z.discriminatedUnion('kind', [
	durableCacheManagementSchema,
	managedCacheManagementSchema
]);
export type CacheManagement = z.infer<typeof cacheManagementSchema>;

export const managedPolicyConfigurationSchema = z
	.strictObject({
		groupId: managedCacheGroupIdSchema,
		access: cacheAccessModeSchema,
		priority: cachePrioritySchema.default(cachePrioritySchema.parse(40)),
		defaultRootRetention: cacheRootRetentionSchema.default({
			kind: 'duration',
			seconds: ttlSecondsSchema.parse(14 * 24 * 60 * 60)
		}),
		maximumRootDurationSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(14 * 24 * 60 * 60)
		),
		allowPermanentRoots: z.boolean().default(false),
		graceSeconds: graceSecondsSchema.optional(),
		creationLeaseSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(15 * 60)
		),
		provisionalLeaseSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(60 * 60)
		),
		activityLeaseSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(24 * 60 * 60)
		),
		maximumLiveCaches: z.int().positive().max(10_000).default(100)
	})
	.superRefine(requireCoherentRootRetention);
export type ManagedPolicyConfiguration = z.infer<
	typeof managedPolicyConfigurationSchema
>;

export const managedPolicyPutBodySchema = z
	.strictObject({
		id: managedPolicyIdSchema.optional(),
		ownerId: githubOwnerIdSchema,
		repositoryId: githubRepositoryIdSchema,
		groupId: managedCacheGroupIdSchema.optional(),
		cacheNamespace: managedCacheNamespaceSchema.optional(),
		reuseViewName: reuseViewNameSchema,
		reuseViewPriority: reuseViewPrioritySchema.default(
			reuseViewDefaultPriority
		),
		access: cacheAccessModeSchema,
		priority: cachePrioritySchema.default(cachePrioritySchema.parse(40)),
		defaultRootRetention: cacheRootRetentionSchema.default({
			kind: 'duration',
			seconds: ttlSecondsSchema.parse(14 * 24 * 60 * 60)
		}),
		maximumRootDurationSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(14 * 24 * 60 * 60)
		),
		allowPermanentRoots: z.boolean().default(false),
		graceSeconds: graceSecondsSchema.optional(),
		creationLeaseSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(15 * 60)
		),
		provisionalLeaseSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(60 * 60)
		),
		activityLeaseSeconds: ttlSecondsSchema.default(
			ttlSecondsSchema.parse(24 * 60 * 60)
		),
		maximumLiveCaches: z.int().positive().max(10_000).default(100)
	})
	.superRefine(requireCoherentRootRetention);
export type ManagedPolicyPutBody = z.infer<typeof managedPolicyPutBodySchema>;
export type ManagedPolicyPutBodyInput = z.input<
	typeof managedPolicyPutBodySchema
>;

export const managedPolicySummarySchema = z.strictObject({
	id: managedPolicyIdSchema,
	ownerId: githubOwnerIdSchema,
	repositoryId: githubRepositoryIdSchema,
	cacheNamespace: managedCacheNamespaceSchema,
	status: managedPolicyStatusSchema,
	currentRevision: managedPolicyRevisionSchema,
	reuseViewName: reuseViewNameSchema,
	reuseViewPriority: reuseViewPrioritySchema.default(reuseViewDefaultPriority),
	configuration: managedPolicyConfigurationSchema
});
export type ManagedPolicySummary = z.infer<typeof managedPolicySummarySchema>;

export const managedPolicyListSchema = z.strictObject({
	policies: z.array(managedPolicySummarySchema)
});

export const managedCacheCapacityFailureSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('temporarily-full'),
		retryAt: isoTimestampSchema
	}),
	z.strictObject({ kind: z.literal('operator-action-required') })
]);
export type ManagedCacheCapacityFailure = z.infer<
	typeof managedCacheCapacityFailureSchema
>;

export const managedCacheProvisionInputSchema = z.strictObject({
	cacheName: cacheNameSchema
});

export const managedPolicyRetireInputSchema = z.strictObject({
	policyId: managedPolicyIdSchema
});

export const managedGroupAccessUpdateInputSchema = z.strictObject({
	groupId: managedCacheGroupIdSchema,
	access: cacheAccessModeSchema
});

export {
	type ManagedCacheGroupId,
	managedCacheGroupIdSchema
} from './reuse-views.ts';
