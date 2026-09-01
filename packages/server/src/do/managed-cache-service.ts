import {
	type CacheAccessMode,
	cacheAccessModeSchema,
	type CacheGeneration,
	cacheGenerationSchema,
	type CacheName,
	cacheNameSchema,
	cachePrioritySchema,
	type CacheReadRevision,
	cacheReadRevisionSchema,
	type CacheScope,
	graceSecondsSchema,
	isSameCacheScope,
	type TenantId,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { cacheWriterEpoch } from '@cupboard/protocol/cache-deployment-manifest';
import type { AuthorizationDetail } from '@cupboard/protocol/grants';
import {
	githubOwnerIdSchema,
	githubRepositoryIdSchema,
	type ManagedCacheGroupId,
	managedCacheGroupIdSchema,
	managedCacheNamespaceSchema,
	type ManagedPolicyId,
	managedPolicyIdSchema,
	type ManagedPolicyPutBody,
	type ManagedPolicyRevision,
	managedPolicyRevisionSchema,
	type ManagedPolicySummary
} from '@cupboard/protocol/managed-caches';
import type { RootRetentionRequest } from '@cupboard/protocol/retention';
import {
	reuseViewNameSchema,
	reuseViewPrioritySchema
} from '@cupboard/protocol/reuse-views';
import { isoTimestamp, isoTimestampSchema } from '@cupboard/protocol/scalars';
import { chunk } from '@cupboard/shared/collections';
import {
	and,
	asc,
	count,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	or,
	sql
} from 'drizzle-orm';
import { z } from 'zod';

import type { AccessClaims } from '../auth/auth.ts';
import { cacheIdentityCondition, type ResolvedCache } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	ManagedActivationRepairConflictError,
	ManagedActivationRepairDeferredError,
	ManagedCacheCapacityError,
	ManagedCacheConflictError,
	ManagedGroupNotFoundError,
	ManagedPolicyConflictError
} from '../errors.ts';
import { internalOrigin } from '../http/http.ts';

import { armAlarmNoLaterThan } from './alarm.ts';
import type { CacheAdminService } from './cache-admin-service.ts';
import type { ServerContext } from './context.ts';
import type { ReuseViewAdminService } from './reuse-view-admin-service.ts';

type PolicyFamilyRow = typeof d1Schema.managedPolicyFamily.$inferSelect;
type PolicyRevisionRow = typeof d1Schema.managedPolicyRevision.$inferSelect;
type PolicyGroupRow = typeof d1Schema.managedCacheGroup.$inferSelect;
type GroupAccessTransitionRow =
	typeof d1Schema.managedGroupAccessTransition.$inferSelect;

const maximumManagedPoliciesPerGroup = 20;
const groupAccessCacheBatchSize = 4;
const groupAccessConditionBatchSize = 16;
const groupAccessCaptureBatchSize = 12;
const policyUpdateCacheBatchSize = 4;

interface StoredPolicy {
	readonly family: PolicyFamilyRow;
	readonly revision: PolicyRevisionRow;
	readonly group: PolicyGroupRow;
}

const managedActivationRepairPayloadSchema = z.strictObject({
	cacheName: cacheNameSchema,
	access: cacheAccessModeSchema,
	generation: cacheGenerationSchema,
	readRevision: cacheReadRevisionSchema,
	policyId: managedPolicyIdSchema,
	policyRevision: managedPolicyRevisionSchema,
	groupId: managedCacheGroupIdSchema,
	creationExpiresAt: isoTimestampSchema,
	leaseExpiresAt: isoTimestampSchema
});

const groupAccessParticipantSchema = z.strictObject({
	policyId: managedPolicyIdSchema,
	sourceRevision: managedPolicyRevisionSchema,
	targetRevision: managedPolicyRevisionSchema
});
const groupAccessParticipantsSchema = z.array(groupAccessParticipantSchema);
type GroupAccessParticipant = z.infer<typeof groupAccessParticipantSchema>;

const groupAccessCacheWorkSchema = z.strictObject({
	cacheName: cacheNameSchema,
	generation: cacheGenerationSchema,
	targetReadRevision: cacheReadRevisionSchema,
	policyId: managedPolicyIdSchema
});
type GroupAccessCacheWork = z.infer<typeof groupAccessCacheWorkSchema>;
interface GroupAccessCacheIdentity {
	readonly cacheName: CacheName;
	readonly generation: CacheGeneration;
	readonly policyId: ManagedPolicyId;
}
interface GroupAccessCacheMove {
	readonly cacheName: CacheName;
	readonly generation: CacheGeneration;
	readonly targetReadRevision: CacheReadRevision;
	readonly policyId: ManagedPolicyId;
	readonly sourceRevision: ManagedPolicyRevision;
	readonly pendingRevision: ManagedPolicyRevision;
}

function groupAccessParticipants(
	transition: GroupAccessTransitionRow
): readonly GroupAccessParticipant[] {
	return groupAccessParticipantsSchema.parse(
		JSON.parse(transition.participantPoliciesJson)
	);
}

function d1GroupCacheCondition(cache: GroupAccessCacheIdentity) {
	return and(
		eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
		eq(d1Schema.cacheLifecycle.cacheName, cache.cacheName),
		eq(d1Schema.cacheLifecycle.generation, cache.generation),
		eq(d1Schema.cacheLifecycle.managedPolicyId, cache.policyId)
	);
}

function localGroupCacheCondition(cache: GroupAccessCacheIdentity) {
	return and(
		eq(schema.caches.kind, 'named'),
		eq(schema.caches.name, cache.cacheName),
		eq(schema.caches.generation, cache.generation),
		eq(schema.caches.managedPolicyId, cache.policyId)
	);
}

function d1GroupCacheConditions(caches: readonly GroupAccessCacheIdentity[]) {
	const conditions = caches.map((cache) => d1GroupCacheCondition(cache));

	return or(...conditions);
}

function localGroupCacheConditions(
	caches: readonly GroupAccessCacheIdentity[]
) {
	const conditions = caches.map((cache) => localGroupCacheCondition(cache));

	return or(...conditions);
}

function d1TransitionCacheCondition(
	tenant: TenantId,
	transitionId: string,
	cacheName: CacheName
) {
	return and(
		eq(d1Schema.managedGroupAccessTransitionCache.tenant, tenant),
		eq(d1Schema.managedGroupAccessTransitionCache.transitionId, transitionId),
		eq(d1Schema.managedGroupAccessTransitionCache.cacheName, cacheName)
	);
}

type ManagedActivationRepairPayload = z.infer<
	typeof managedActivationRepairPayloadSchema
>;

async function beginManagedActivationRepair(
	context: ServerContext,
	payload: ManagedActivationRepairPayload
): Promise<string> {
	const tenant = context.requireTenant();
	const fence = await context.d1
		.select({ revision: d1Schema.d1AppMutationFence.revision })
		.from(d1Schema.d1AppMutationFence)
		.where(eq(d1Schema.d1AppMutationFence.id, 'application'))
		.get();

	if (fence === undefined) {
		throw new ManagedCacheConflictError({
			kind: 'named',
			name: payload.cacheName
		});
	}

	const id = crypto.randomUUID();
	const now = isoTimestamp(new Date());
	await context.d1.insert(d1Schema.projectionRepairIntent).values({
		id,
		tenant,
		writerEpoch: cacheWriterEpoch,
		fenceRevision: fence.revision,
		status: 'pending',
		operation: 'managed-cache-activation',
		payloadJson: JSON.stringify(payload),
		createdAt: now,
		updatedAt: now
	});

	return id;
}

async function finishManagedActivationRepair(
	context: ServerContext,
	id: string,
	status: 'complete' | 'rolled-back'
): Promise<void> {
	const result = await context.d1
		.update(d1Schema.projectionRepairIntent)
		.set({
			status,
			claimId: sql`NULL`,
			claimExpiresAt: sql`NULL`,
			updatedAt: isoTimestamp(new Date()),
			lastFailureJson: sql`NULL`
		})
		.where(
			and(
				eq(d1Schema.projectionRepairIntent.id, id),
				inArray(d1Schema.projectionRepairIntent.status, [
					'pending',
					'running',
					'failed'
				])
			)
		)
		.run();

	if (result.meta.changes !== 1) {
		throw new ManagedActivationRepairConflictError(id);
	}
}

function atSeconds(date: Date, seconds: number): Date {
	return new Date(date.getTime() + seconds * 1000);
}

function defaultNamespace(repositoryId: string) {
	return managedCacheNamespaceSchema.parse(`gh-${repositoryId}-pr-`);
}

function policySummary(policy: StoredPolicy): ManagedPolicySummary {
	return {
		id: policy.family.id,
		ownerId: githubOwnerIdSchema.parse(policy.family.ownerId),
		repositoryId: githubRepositoryIdSchema.parse(policy.family.repositoryId),
		cacheNamespace: managedCacheNamespaceSchema.parse(
			policy.family.cacheNamespace
		),
		status: policy.family.status,
		currentRevision: managedPolicyRevisionSchema.parse(
			policy.family.currentRevision
		),
		reuseViewName: reuseViewNameSchema.parse(policy.group.reuseViewName),
		reuseViewPriority: reuseViewPrioritySchema.parse(
			policy.group.reuseViewPriority
		),
		configuration: {
			groupId: policy.group.id,
			access: policy.revision.access,
			priority: cachePrioritySchema.parse(policy.revision.priority),
			defaultRootRetention:
				policy.revision.defaultRootTtlSeconds === null
					? { kind: 'permanent' }
					: {
							kind: 'duration',
							seconds: ttlSecondsSchema.parse(
								policy.revision.defaultRootTtlSeconds
							)
						},
			maximumRootDurationSeconds: ttlSecondsSchema.parse(
				policy.revision.maximumRootDurationSeconds
			),
			allowPermanentRoots: policy.revision.allowPermanentRoots,
			graceSeconds:
				policy.revision.graceSeconds === null
					? undefined
					: graceSecondsSchema.parse(policy.revision.graceSeconds),
			creationLeaseSeconds: ttlSecondsSchema.parse(
				policy.revision.creationLeaseSeconds
			),
			provisionalLeaseSeconds: ttlSecondsSchema.parse(
				policy.revision.provisionalLeaseSeconds
			),
			activityLeaseSeconds: ttlSecondsSchema.parse(
				policy.revision.activityLeaseSeconds
			),
			maximumLiveCaches: policy.revision.maximumLiveCaches
		}
	};
}

function isSamePolicyRequest(
	policy: ManagedPolicySummary,
	request: ManagedPolicyPutBody
): boolean {
	const expectedNamespace =
		request.cacheNamespace ?? defaultNamespace(request.repositoryId);

	return (
		(request.id === undefined || policy.id === request.id) &&
		policy.ownerId === request.ownerId &&
		policy.repositoryId === request.repositoryId &&
		policy.cacheNamespace === expectedNamespace &&
		policy.reuseViewName === request.reuseViewName &&
		policy.reuseViewPriority === request.reuseViewPriority &&
		(request.groupId === undefined ||
			policy.configuration.groupId === request.groupId) &&
		policy.configuration.access === request.access &&
		policy.configuration.priority === request.priority &&
		JSON.stringify(policy.configuration.defaultRootRetention) ===
			JSON.stringify(request.defaultRootRetention) &&
		policy.configuration.maximumRootDurationSeconds ===
			request.maximumRootDurationSeconds &&
		policy.configuration.allowPermanentRoots === request.allowPermanentRoots &&
		policy.configuration.graceSeconds === request.graceSeconds &&
		policy.configuration.creationLeaseSeconds ===
			request.creationLeaseSeconds &&
		policy.configuration.provisionalLeaseSeconds ===
			request.provisionalLeaseSeconds &&
		policy.configuration.activityLeaseSeconds ===
			request.activityLeaseSeconds &&
		policy.configuration.maximumLiveCaches === request.maximumLiveCaches
	);
}

function isSamePolicyIdentity(
	policy: ManagedPolicySummary,
	request: ManagedPolicyPutBody
): boolean {
	const expectedNamespace =
		request.cacheNamespace ?? defaultNamespace(request.repositoryId);

	return (
		(request.id === undefined || policy.id === request.id) &&
		policy.ownerId === request.ownerId &&
		policy.repositoryId === request.repositoryId &&
		policy.cacheNamespace === expectedNamespace &&
		policy.reuseViewName === request.reuseViewName &&
		policy.reuseViewPriority === request.reuseViewPriority &&
		(request.groupId === undefined ||
			policy.configuration.groupId === request.groupId)
	);
}

function exactProvisionGrant(
	claims: AccessClaims,
	scope: CacheScope
): Extract<AuthorizationDetail, { type: 'cupboard_cache' }> {
	const grants = claims.grants.filter(
		(
			grant
		): grant is Extract<AuthorizationDetail, { type: 'cupboard_cache' }> =>
			grant.type === 'cupboard_cache' &&
			grant.actions.includes('cache:provision') &&
			isSameCacheScope(grant.cache, scope) &&
			grant.managedPolicy !== undefined
	);

	const [grant] = grants;

	if (grant === undefined || grants.length !== 1) {
		throw new ManagedCacheConflictError(scope);
	}

	return grant;
}

export class ManagedCacheService {
	constructor(
		private readonly context: ServerContext,
		private readonly cacheAdmin: CacheAdminService,
		private readonly reuseViews: ReuseViewAdminService
	) {}

	private async storedPolicy(
		policyId: ManagedPolicyId
	): Promise<StoredPolicy | undefined> {
		const tenant = this.context.requireTenant();
		const family = await this.context.d1
			.select()
			.from(d1Schema.managedPolicyFamily)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyFamily.id, policyId)
				)
			)
			.get();

		if (family === undefined) {
			return undefined;
		}

		const revisionCondition = and(
			eq(d1Schema.managedPolicyRevision.tenant, tenant),
			eq(d1Schema.managedPolicyRevision.policyId, policyId),
			eq(d1Schema.managedPolicyRevision.revision, family.currentRevision)
		);
		const revision = await this.context.d1
			.select()
			.from(d1Schema.managedPolicyRevision)
			.where(revisionCondition)
			.get();

		if (revision === undefined) {
			throw new ManagedPolicyConflictError(policyId);
		}

		const groupCondition = and(
			eq(d1Schema.managedCacheGroup.tenant, tenant),
			eq(d1Schema.managedCacheGroup.id, revision.groupId)
		);
		const group = await this.context.d1
			.select()
			.from(d1Schema.managedCacheGroup)
			.where(groupCondition)
			.get();

		if (group === undefined) {
			throw new ManagedPolicyConflictError(policyId);
		}

		return { family, revision, group };
	}

	private async storedPolicyRevision(
		family: PolicyFamilyRow,
		revisionNumber: ManagedPolicyRevision
	): Promise<StoredPolicy> {
		const tenant = this.context.requireTenant();
		const revision = await this.context.d1
			.select()
			.from(d1Schema.managedPolicyRevision)
			.where(
				and(
					eq(d1Schema.managedPolicyRevision.tenant, tenant),
					eq(d1Schema.managedPolicyRevision.policyId, family.id),
					eq(d1Schema.managedPolicyRevision.revision, revisionNumber)
				)
			)
			.get();

		if (revision === undefined) {
			throw new ManagedPolicyConflictError(family.id);
		}

		const group = await this.context.d1
			.select()
			.from(d1Schema.managedCacheGroup)
			.where(
				and(
					eq(d1Schema.managedCacheGroup.tenant, tenant),
					eq(d1Schema.managedCacheGroup.id, revision.groupId)
				)
			)
			.get();

		if (group === undefined) {
			throw new ManagedPolicyConflictError(family.id);
		}

		return { family, revision, group };
	}

	private async pendingPolicyRevision(
		policy: StoredPolicy
	): Promise<StoredPolicy | undefined> {
		return policy.family.pendingRevision === null
			? undefined
			: this.storedPolicyRevision(policy.family, policy.family.pendingRevision);
	}

	private async policyForRepository(
		repositoryId: ManagedPolicyPutBody['repositoryId']
	): Promise<StoredPolicy | undefined> {
		const tenant = this.context.requireTenant();
		const family = await this.context.d1
			.select({ id: d1Schema.managedPolicyFamily.id })
			.from(d1Schema.managedPolicyFamily)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyFamily.repositoryId, repositoryId)
				)
			)
			.get();

		return family === undefined ? undefined : this.storedPolicy(family.id);
	}

	private reconcileManagedView(policy: StoredPolicy): void {
		this.reuseViews.setManagedView(
			reuseViewNameSchema.parse(policy.group.reuseViewName),
			{
				access: policy.group.access,
				selectors: [{ kind: 'managed-group', groupId: policy.group.id }],
				priority: reuseViewPrioritySchema.parse(policy.group.reuseViewPriority)
			}
		);
	}

	private retirementEligibilityCondition(policyId?: ManagedPolicyId) {
		return and(
			eq(schema.caches.managementKind, 'managed'),
			...(policyId === undefined
				? []
				: [eq(schema.caches.managedPolicyId, policyId)]),
			eq(schema.caches.lifecycleState, 'active'),
			eq(schema.caches.updateHold, false),
			isNull(schema.caches.deletedAt),
			sql`not exists (select 1 from ${schema.retentionRoots} where ${schema.retentionRoots.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.retentionRootTargets} where ${schema.retentionRootTargets.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.retentionGrace} where ${schema.retentionGrace.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.narInfos} where ${schema.narInfos.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.pendingUploads} where ${schema.pendingUploads.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.pendingAttestations} where ${schema.pendingAttestations.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.narInfoDeletions} where ${schema.narInfoDeletions.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.verificationCursor} where ${schema.verificationCursor.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.garbageCollectionScans} where ${schema.garbageCollectionScans.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.garbageCollectionFrontier} where ${schema.garbageCollectionFrontier.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.garbageCollectionMarks} where ${schema.garbageCollectionMarks.cacheId} = ${schema.caches.id})`,
			sql`not exists (select 1 from ${schema.garbageCollectionTenantRuns} where ${schema.garbageCollectionTenantRuns.cacheId} = ${schema.caches.id})`
		);
	}

	private retirementCondition(now: string, policyId?: ManagedPolicyId) {
		return and(
			this.retirementEligibilityCondition(policyId),
			sql`${schema.caches.leaseExpiresAt} <= ${now}`
		);
	}

	private hasExpiredCreation(now: string): boolean {
		return (
			this.context.db
				.select({ id: schema.caches.id })
				.from(schema.caches)
				.where(
					and(
						eq(schema.caches.managementKind, 'managed'),
						eq(schema.caches.lifecycleState, 'creating'),
						sql`${schema.caches.creationExpiresAt} <= ${now}`,
						isNull(schema.caches.deletedAt)
					)
				)
				.limit(1)
				.get() !== undefined
		);
	}

	private async recoverExpiredCreations(limit: number): Promise<number> {
		const tenant = this.context.requireTenant();
		const nowDate = new Date();
		const now = isoTimestamp(nowDate);
		const candidates = await this.context.d1
			.select()
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.managementKind, 'managed'),
					eq(d1Schema.cacheLifecycle.state, 'creating'),
					sql`${d1Schema.cacheLifecycle.creationExpiresAt} <= ${now}`
				)
			)
			.limit(limit)
			.all();

		for (const candidate of candidates) {
			const scope = cacheNameSchema.parse(candidate.cacheName);
			const local = this.context.db
				.select()
				.from(schema.caches)
				.where(
					and(
						eq(schema.caches.kind, 'named'),
						eq(schema.caches.name, scope),
						isNull(schema.caches.deletedAt)
					)
				)
				.get();
			const policy =
				candidate.managedPolicyId === null
					? undefined
					: await this.storedPolicy(candidate.managedPolicyId);

			if (
				candidate.managedPolicyId !== null &&
				candidate.managedPolicyRevision !== null &&
				policy?.family.status === 'active' &&
				policy.group.state === 'active' &&
				policy.family.currentRevision === candidate.managedPolicyRevision &&
				local?.lifecycleState === 'creating' &&
				local.managementKind === 'managed' &&
				local.generation === candidate.generation &&
				local.managedPolicyId === candidate.managedPolicyId &&
				local.managedPolicyRevision === candidate.managedPolicyRevision
			) {
				const leaseExpiresAt = isoTimestamp(
					atSeconds(nowDate, policy.revision.provisionalLeaseSeconds)
				);
				this.context.db
					.update(schema.caches)
					.set({
						lifecycleState: 'active',
						creationExpiresAt: sql`NULL`,
						leaseExpiresAt,
						selectionState: 'source-active'
					})
					.where(eq(schema.caches.id, local.id))
					.run();
				const activated = await this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({
						state: 'active',
						creationExpiresAt: sql`NULL`,
						leaseExpiresAt,
						selectionState: 'source-active',
						updatedAt: now
					})
					.where(
						and(
							eq(d1Schema.cacheLifecycle.tenant, tenant),
							eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
							eq(d1Schema.cacheLifecycle.cacheName, scope),
							eq(d1Schema.cacheLifecycle.state, 'creating'),
							eq(d1Schema.cacheLifecycle.generation, candidate.generation)
						)
					)
					.run();

				if (activated.meta.changes === 1) {
					continue;
				}

				const active = await this.context.d1
					.select({ generation: d1Schema.cacheLifecycle.generation })
					.from(d1Schema.cacheLifecycle)
					.where(
						and(
							eq(d1Schema.cacheLifecycle.tenant, tenant),
							eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
							eq(d1Schema.cacheLifecycle.cacheName, scope),
							eq(d1Schema.cacheLifecycle.state, 'active'),
							eq(d1Schema.cacheLifecycle.generation, candidate.generation),
							eq(
								d1Schema.cacheLifecycle.managedPolicyId,
								candidate.managedPolicyId
							)
						)
					)
					.get();

				if (active !== undefined) {
					continue;
				}

				const cache = this.context.cacheRepository.resolvedForId(local.id);
				await this.cacheAdmin.tearDownCache(cache, internalOrigin);
				continue;
			}

			if (local !== undefined) {
				if (local.generation !== candidate.generation) {
					throw new ManagedCacheConflictError({ kind: 'named', name: scope });
				}

				const cache = this.context.cacheRepository.resolvedForId(local.id);
				await this.cacheAdmin.tearDownCache(cache, internalOrigin);
				continue;
			}
			const cancelled = await this.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					state: 'deleted',
					generation: cacheGenerationSchema.parse(candidate.generation + 1),
					readRevision: cacheReadRevisionSchema.parse(
						candidate.readRevision + 1
					),
					creationExpiresAt: sql`NULL`,
					leaseExpiresAt: now,
					selectionState: 'detached',
					deletedAt: now,
					updatedAt: now
				})
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
						eq(d1Schema.cacheLifecycle.cacheName, scope),
						eq(d1Schema.cacheLifecycle.state, 'creating'),
						eq(d1Schema.cacheLifecycle.generation, candidate.generation)
					)
				)
				.run();

			if (cancelled.meta.changes !== 1) {
				throw new ManagedCacheConflictError({ kind: 'named', name: scope });
			}
		}

		return candidates.length;
	}

	private async activeGroupAccessTransition(
		groupId?: ManagedCacheGroupId
	): Promise<GroupAccessTransitionRow | undefined> {
		const tenant = this.context.requireTenant();
		const groupCondition =
			groupId === undefined
				? undefined
				: eq(d1Schema.managedGroupAccessTransition.groupId, groupId);

		return this.context.d1
			.select()
			.from(d1Schema.managedGroupAccessTransition)
			.where(
				and(
					eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
					inArray(d1Schema.managedGroupAccessTransition.status, [
						'running',
						'finalising'
					]),
					groupCondition
				)
			)
			.orderBy(asc(d1Schema.managedGroupAccessTransition.createdAt))
			.limit(1)
			.get();
	}

	private groupAccessTransitionCondition(transitionId: string) {
		return and(
			eq(
				d1Schema.managedGroupAccessTransition.tenant,
				this.context.requireTenant()
			),
			eq(d1Schema.managedGroupAccessTransition.id, transitionId)
		);
	}

	private async latestGroupAccessTransition(
		groupId: ManagedCacheGroupId
	): Promise<GroupAccessTransitionRow | undefined> {
		const tenant = this.context.requireTenant();

		return this.context.d1
			.select()
			.from(d1Schema.managedGroupAccessTransition)
			.where(
				and(
					eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
					eq(d1Schema.managedGroupAccessTransition.groupId, groupId),
					inArray(d1Schema.managedGroupAccessTransition.status, [
						'running',
						'finalising',
						'failed'
					])
				)
			)
			.orderBy(sql`${d1Schema.managedGroupAccessTransition.createdAt} DESC`)
			.limit(1)
			.get();
	}

	private async cancelNextCreatingGroupCache(
		transition: GroupAccessTransitionRow
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		const creation = await this.context.d1
			.select()
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.managedGroupId, transition.groupId),
					eq(d1Schema.cacheLifecycle.state, 'creating')
				)
			)
			.orderBy(asc(d1Schema.cacheLifecycle.cacheName))
			.limit(1)
			.get();

		if (creation === undefined) {
			return false;
		}

		const cacheName = cacheNameSchema.parse(creation.cacheName);
		const local = this.context.db
			.select()
			.from(schema.caches)
			.where(
				and(
					eq(schema.caches.kind, 'named'),
					eq(schema.caches.name, cacheName),
					eq(schema.caches.generation, creation.generation),
					isNull(schema.caches.deletedAt)
				)
			)
			.get();

		if (local?.lifecycleState === 'active') {
			const repair = await this.context.d1
				.select({
					id: d1Schema.projectionRepairIntent.id,
					payloadJson: d1Schema.projectionRepairIntent.payloadJson
				})
				.from(d1Schema.projectionRepairIntent)
				.where(
					and(
						eq(d1Schema.projectionRepairIntent.tenant, tenant),
						eq(
							d1Schema.projectionRepairIntent.operation,
							'managed-cache-activation'
						),
						inArray(d1Schema.projectionRepairIntent.status, [
							'pending',
							'running',
							'failed'
						]),
						sql`json_extract(${d1Schema.projectionRepairIntent.payloadJson}, '$.cacheName') = ${cacheName}`,
						sql`json_extract(${d1Schema.projectionRepairIntent.payloadJson}, '$.generation') = ${creation.generation}`
					)
				)
				.limit(1)
				.get();

			if (repair === undefined) {
				throw new ManagedCacheConflictError({
					kind: 'named',
					name: cacheName
				});
			}

			const outcome = await this.resolveManagedActivationRepair(
				repair.id,
				repair.payloadJson
			);

			if (outcome !== 'complete') {
				throw new ManagedCacheConflictError({
					kind: 'named',
					name: cacheName
				});
			}

			return true;
		}

		if (local !== undefined && local.lifecycleState !== 'creating') {
			throw new ManagedCacheConflictError({
				kind: 'named',
				name: cacheName
			});
		}

		if (local !== undefined) {
			this.context.db
				.delete(schema.caches)
				.where(eq(schema.caches.id, local.id))
				.run();
		}
		const cancelled = await this.context.d1
			.update(d1Schema.cacheLifecycle)
			.set({
				state: 'deleted',
				generation: cacheGenerationSchema.parse(creation.generation + 1),
				readRevision: cacheReadRevisionSchema.parse(creation.readRevision + 1),
				creationExpiresAt: sql`NULL`,
				leaseExpiresAt: now,
				selectionState: 'detached',
				deletedAt: now,
				updatedAt: now
			})
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
					eq(d1Schema.cacheLifecycle.cacheName, cacheName),
					eq(d1Schema.cacheLifecycle.generation, creation.generation),
					eq(d1Schema.cacheLifecycle.state, 'creating')
				)
			)
			.run();

		if (cancelled.meta.changes !== 1) {
			const current = await this.context.d1
				.select({
					state: d1Schema.cacheLifecycle.state,
					generation: d1Schema.cacheLifecycle.generation
				})
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
						eq(d1Schema.cacheLifecycle.cacheName, cacheName)
					)
				)
				.get();

			if (
				current?.state === 'deleted' &&
				current.generation === creation.generation + 1
			) {
				return true;
			}

			throw new ManagedCacheConflictError({
				kind: 'named',
				name: cacheName
			});
		}

		return true;
	}

	private async resumeFailedGroupAccessTransition(
		transition: GroupAccessTransitionRow
	): Promise<GroupAccessTransitionRow> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		const transitionCondition = and(
			eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
			eq(d1Schema.managedGroupAccessTransition.id, transition.id),
			eq(d1Schema.managedGroupAccessTransition.status, 'failed')
		);
		const familyCondition = and(
			eq(d1Schema.managedPolicyFamily.tenant, tenant),
			eq(d1Schema.managedPolicyFamily.status, 'update-failed'),
			isNotNull(d1Schema.managedPolicyFamily.pendingRevision),
			inArray(
				d1Schema.managedPolicyFamily.id,
				groupAccessParticipants(transition).map(
					(participant) => participant.policyId
				)
			)
		);
		const resumedStatus =
			transition.phase === 'release-holds' ||
			transition.phase === 'activate-policies'
				? 'finalising'
				: 'running';
		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.managedGroupAccessTransition)
				.set({
					status: resumedStatus,
					lastFailureJson: sql`NULL`,
					updatedAt: now
				})
				.where(transitionCondition),
			this.context.d1
				.update(d1Schema.managedPolicyFamily)
				.set({ status: 'updating', updatedAt: now })
				.where(familyCondition)
		]);

		const resumed = await this.activeGroupAccessTransition(transition.groupId);

		if (resumed === undefined) {
			throw new ManagedPolicyConflictError();
		}

		return resumed;
	}

	private async beginGroupAccessTransition(
		group: PolicyGroupRow,
		targetAccess: CacheAccessMode
	): Promise<GroupAccessTransitionRow> {
		const tenant = this.context.requireTenant();
		const existing = await this.latestGroupAccessTransition(group.id);

		if (existing !== undefined) {
			if (existing.targetAccess !== targetAccess) {
				throw new ManagedPolicyConflictError();
			}

			if (existing.status === 'failed') {
				return this.resumeFailedGroupAccessTransition(existing);
			}

			if (existing.status === 'complete') {
				throw new ManagedPolicyConflictError();
			}

			return existing;
		}

		const policies = await this.context.d1
			.select({
				family: d1Schema.managedPolicyFamily,
				revision: d1Schema.managedPolicyRevision
			})
			.from(d1Schema.managedPolicyFamily)
			.innerJoin(
				d1Schema.managedPolicyRevision,
				and(
					eq(
						d1Schema.managedPolicyRevision.tenant,
						d1Schema.managedPolicyFamily.tenant
					),
					eq(
						d1Schema.managedPolicyRevision.policyId,
						d1Schema.managedPolicyFamily.id
					),
					eq(
						d1Schema.managedPolicyRevision.revision,
						d1Schema.managedPolicyFamily.currentRevision
					)
				)
			)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyRevision.groupId, group.id)
				)
			)
			.limit(maximumManagedPoliciesPerGroup + 1)
			.all();

		if (
			group.state !== 'active' ||
			policies.length === 0 ||
			policies.length > maximumManagedPoliciesPerGroup ||
			policies.some(
				({ family }) =>
					family.status !== 'active' || family.pendingRevision !== null
			)
		) {
			throw new ManagedPolicyConflictError();
		}

		const retiringCache = await this.context.d1
			.select({ cacheName: d1Schema.cacheLifecycle.cacheName })
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.managedGroupId, group.id),
					eq(d1Schema.cacheLifecycle.state, 'retiring')
				)
			)
			.limit(1)
			.get();

		if (retiringCache !== undefined) {
			throw new ManagedPolicyConflictError();
		}

		const transitionId = crypto.randomUUID();
		const targetGroupId = managedCacheGroupIdSchema.parse(crypto.randomUUID());
		const now = isoTimestamp(new Date());
		const participants: readonly GroupAccessParticipant[] = policies
			.map(({ family }) => ({
				policyId: family.id,
				sourceRevision: managedPolicyRevisionSchema.parse(
					family.currentRevision
				),
				targetRevision: managedPolicyRevisionSchema.parse(
					family.currentRevision + 1
				)
			}))
			.toSorted((left, right) => left.policyId.localeCompare(right.policyId));
		const sourceGroupCondition = and(
			eq(d1Schema.managedCacheGroup.tenant, tenant),
			eq(d1Schema.managedCacheGroup.id, group.id),
			eq(d1Schema.managedCacheGroup.state, 'active')
		);
		const results = await this.context.d1.batch([
			this.context.d1.insert(d1Schema.managedCacheGroup).values({
				tenant,
				id: targetGroupId,
				access: targetAccess,
				reuseViewName: reuseViewNameSchema.parse(`transition-${transitionId}`),
				reuseViewPriority: group.reuseViewPriority,
				state: 'transitioning',
				createdAt: now
			}),
			this.context.d1
				.update(d1Schema.managedCacheGroup)
				.set({ state: 'transitioning' })
				.where(sourceGroupCondition),
			this.context.d1.insert(d1Schema.managedGroupAccessTransition).values({
				tenant,
				id: transitionId,
				groupId: group.id,
				targetGroupId,
				sourceAccess: group.access,
				targetAccess,
				status: 'running',
				createdAt: now,
				updatedAt: now,
				participantPoliciesJson: JSON.stringify(participants),
				phase: 'cancel-creations'
			})
		]);

		if (results.some((result) => result.meta.changes !== 1)) {
			throw new ManagedPolicyConflictError();
		}

		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());

		const started = await this.activeGroupAccessTransition(group.id);

		if (started === undefined) {
			throw new ManagedPolicyConflictError();
		}

		return started;
	}

	private async setGroupAccessTransitionPhase(
		transition: GroupAccessTransitionRow,
		phase: GroupAccessTransitionRow['phase']
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const updated = await this.context.d1
			.update(d1Schema.managedGroupAccessTransition)
			.set({ phase, updatedAt: isoTimestamp(new Date()) })
			.where(
				and(
					eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
					eq(d1Schema.managedGroupAccessTransition.id, transition.id),
					eq(d1Schema.managedGroupAccessTransition.phase, transition.phase),
					inArray(d1Schema.managedGroupAccessTransition.status, [
						'running',
						'finalising'
					])
				)
			)
			.run();

		if (updated.meta.changes !== 1) {
			const current = await this.context.d1
				.select({
					phase: d1Schema.managedGroupAccessTransition.phase,
					status: d1Schema.managedGroupAccessTransition.status
				})
				.from(d1Schema.managedGroupAccessTransition)
				.where(
					and(
						eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
						eq(d1Schema.managedGroupAccessTransition.id, transition.id)
					)
				)
				.get();

			if (
				current?.phase === phase &&
				(current.status === 'running' || current.status === 'finalising')
			) {
				return;
			}

			throw new ManagedPolicyConflictError();
		}
	}

	private async prepareNextGroupAccessPolicy(
		transition: GroupAccessTransitionRow
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const participants = groupAccessParticipants(transition);
		const nextIndex =
			transition.policyCursor === null
				? 0
				: participants.findIndex(
						(participant) => participant.policyId === transition.policyCursor
					) + 1;
		const participant = participants[nextIndex];

		if (participant === undefined) {
			await this.setGroupAccessTransitionPhase(transition, 'capture-caches');
			return false;
		}

		const policy = await this.context.d1
			.select({
				family: d1Schema.managedPolicyFamily,
				revision: d1Schema.managedPolicyRevision
			})
			.from(d1Schema.managedPolicyFamily)
			.innerJoin(
				d1Schema.managedPolicyRevision,
				and(
					eq(
						d1Schema.managedPolicyRevision.tenant,
						d1Schema.managedPolicyFamily.tenant
					),
					eq(
						d1Schema.managedPolicyRevision.policyId,
						d1Schema.managedPolicyFamily.id
					),
					eq(
						d1Schema.managedPolicyRevision.revision,
						d1Schema.managedPolicyFamily.currentRevision
					)
				)
			)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyFamily.id, participant.policyId),
					eq(
						d1Schema.managedPolicyFamily.currentRevision,
						participant.sourceRevision
					),
					eq(d1Schema.managedPolicyFamily.status, 'active'),
					isNull(d1Schema.managedPolicyFamily.pendingRevision),
					eq(d1Schema.managedPolicyRevision.groupId, transition.groupId)
				)
			)
			.get();

		if (policy === undefined) {
			throw new ManagedPolicyConflictError(participant.policyId);
		}

		const now = isoTimestamp(new Date());
		const nextPhase =
			nextIndex === participants.length - 1
				? 'capture-caches'
				: 'prepare-policies';
		const familyCondition = and(
			eq(d1Schema.managedPolicyFamily.tenant, tenant),
			eq(d1Schema.managedPolicyFamily.id, participant.policyId),
			eq(
				d1Schema.managedPolicyFamily.currentRevision,
				participant.sourceRevision
			),
			eq(d1Schema.managedPolicyFamily.status, 'active'),
			isNull(d1Schema.managedPolicyFamily.pendingRevision)
		);
		const cursorCondition =
			transition.policyCursor === null
				? isNull(d1Schema.managedGroupAccessTransition.policyCursor)
				: eq(
						d1Schema.managedGroupAccessTransition.policyCursor,
						transition.policyCursor
					);
		const transitionCondition = and(
			eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
			eq(d1Schema.managedGroupAccessTransition.id, transition.id),
			eq(d1Schema.managedGroupAccessTransition.phase, 'prepare-policies'),
			cursorCondition
		);
		const results = await this.context.d1.batch([
			this.context.d1
				.insert(d1Schema.managedPolicyRevision)
				.values({
					...policy.revision,
					revision: participant.targetRevision,
					groupId: transition.targetGroupId,
					access: transition.targetAccess,
					createdAt: now
				})
				.onConflictDoNothing(),
			this.context.d1
				.update(d1Schema.managedPolicyFamily)
				.set({
					status: 'updating',
					pendingRevision: participant.targetRevision,
					updatedAt: now
				})
				.where(familyCondition),
			this.context.d1
				.update(d1Schema.managedGroupAccessTransition)
				.set({
					policyCursor: participant.policyId,
					phase: nextPhase,
					updatedAt: now
				})
				.where(transitionCondition)
		]);

		if (results.some((result) => result.meta.changes !== 1)) {
			const revisionCondition = and(
				eq(d1Schema.managedPolicyRevision.tenant, tenant),
				eq(d1Schema.managedPolicyRevision.policyId, participant.policyId),
				eq(d1Schema.managedPolicyRevision.revision, participant.targetRevision)
			);
			const currentFamilyCondition = and(
				eq(d1Schema.managedPolicyFamily.tenant, tenant),
				eq(d1Schema.managedPolicyFamily.id, participant.policyId)
			);
			const [revision, family, currentTransition] = await Promise.all([
				this.context.d1
					.select({
						groupId: d1Schema.managedPolicyRevision.groupId,
						access: d1Schema.managedPolicyRevision.access
					})
					.from(d1Schema.managedPolicyRevision)
					.where(revisionCondition)
					.get(),
				this.context.d1
					.select({
						status: d1Schema.managedPolicyFamily.status,
						currentRevision: d1Schema.managedPolicyFamily.currentRevision,
						pendingRevision: d1Schema.managedPolicyFamily.pendingRevision
					})
					.from(d1Schema.managedPolicyFamily)
					.where(currentFamilyCondition)
					.get(),
				this.context.d1
					.select({
						phase: d1Schema.managedGroupAccessTransition.phase,
						policyCursor: d1Schema.managedGroupAccessTransition.policyCursor
					})
					.from(d1Schema.managedGroupAccessTransition)
					.where(this.groupAccessTransitionCondition(transition.id))
					.get()
			]);
			const currentCursorIndex = participants.findIndex(
				(candidate) => candidate.policyId === currentTransition?.policyCursor
			);
			const hasFamilyAdvanced =
				(family?.status === 'updating' &&
					family.currentRevision === participant.sourceRevision &&
					family.pendingRevision === participant.targetRevision) ||
				(family?.status === 'active' &&
					family.currentRevision === participant.targetRevision &&
					family.pendingRevision === null);
			const hasTransitionAdvanced =
				currentTransition !== undefined &&
				(currentTransition.phase !== 'prepare-policies' ||
					currentCursorIndex >= nextIndex);

			if (
				hasFamilyAdvanced &&
				hasTransitionAdvanced &&
				revision?.groupId === transition.targetGroupId &&
				revision.access === transition.targetAccess
			) {
				return true;
			}

			throw new ManagedPolicyConflictError(participant.policyId);
		}

		return true;
	}

	private async captureGroupAccessCaches(
		transition: GroupAccessTransitionRow
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const rows = await this.context.d1
			.select({
				cacheName: d1Schema.cacheLifecycle.cacheName,
				generation: d1Schema.cacheLifecycle.generation,
				readRevision: d1Schema.cacheLifecycle.readRevision,
				policyId: d1Schema.cacheLifecycle.managedPolicyId
			})
			.from(d1Schema.cacheLifecycle)
			.where(
				and(
					eq(d1Schema.cacheLifecycle.tenant, tenant),
					eq(d1Schema.cacheLifecycle.managedGroupId, transition.groupId),
					eq(d1Schema.cacheLifecycle.state, 'active'),
					eq(d1Schema.cacheLifecycle.selectionState, 'source-active'),
					eq(d1Schema.cacheLifecycle.updateHold, false),
					isNotNull(d1Schema.cacheLifecycle.cacheName),
					transition.cacheCursor === null
						? undefined
						: gt(d1Schema.cacheLifecycle.cacheName, transition.cacheCursor)
				)
			)
			.orderBy(asc(d1Schema.cacheLifecycle.cacheName))
			.limit(groupAccessCaptureBatchSize)
			.all();

		if (rows.length === 0) {
			await this.setGroupAccessTransitionPhase(transition, 'move-caches');
			return false;
		}

		const participantIds = new Set(
			groupAccessParticipants(transition).map(
				(participant) => participant.policyId
			)
		);
		const work = rows.map((row): GroupAccessCacheWork => {
			if (row.cacheName === null || row.policyId === null) {
				throw new ManagedPolicyConflictError();
			}

			const parsed = groupAccessCacheWorkSchema.parse({
				cacheName: row.cacheName,
				generation: row.generation,
				targetReadRevision: row.readRevision + 1,
				policyId: row.policyId
			});

			if (!participantIds.has(parsed.policyId)) {
				throw new ManagedPolicyConflictError(parsed.policyId);
			}

			return parsed;
		});
		const last = work.at(-1);

		if (last === undefined) {
			throw new ManagedPolicyConflictError();
		}

		const now = isoTimestamp(new Date());
		const lifecycleCondition = and(
			eq(d1Schema.cacheLifecycle.tenant, tenant),
			eq(d1Schema.cacheLifecycle.state, 'active'),
			d1GroupCacheConditions(work)
		);
		const cursorCondition =
			transition.cacheCursor === null
				? isNull(d1Schema.managedGroupAccessTransition.cacheCursor)
				: eq(
						d1Schema.managedGroupAccessTransition.cacheCursor,
						transition.cacheCursor
					);
		const transitionCondition = and(
			eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
			eq(d1Schema.managedGroupAccessTransition.id, transition.id),
			eq(d1Schema.managedGroupAccessTransition.phase, 'capture-caches'),
			cursorCondition
		);
		const results = await this.context.d1.batch([
			this.context.d1
				.insert(d1Schema.managedGroupAccessTransitionCache)
				.values(
					work.map((cache) => ({
						tenant,
						transitionId: transition.id,
						cacheName: cache.cacheName,
						generation: cache.generation,
						targetReadRevision: cache.targetReadRevision,
						policyId: cache.policyId
					}))
				)
				.onConflictDoNothing(),
			this.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({ updateHold: true, updatedAt: now })
				.where(lifecycleCondition),
			this.context.d1
				.update(d1Schema.managedGroupAccessTransition)
				.set({
					cacheCursor: last.cacheName,
					phase:
						work.length < groupAccessCaptureBatchSize
							? 'move-caches'
							: 'capture-caches',
					updatedAt: now
				})
				.where(transitionCondition)
		]);

		const transitionResult = results.at(-1);

		if (transitionResult?.meta.changes !== 1) {
			const current = await this.context.d1
				.select({
					cacheCursor: d1Schema.managedGroupAccessTransition.cacheCursor
				})
				.from(d1Schema.managedGroupAccessTransition)
				.where(this.groupAccessTransitionCondition(transition.id))
				.get();

			if (current?.cacheCursor !== last.cacheName) {
				throw new ManagedPolicyConflictError();
			}
		}

		for (const cacheBatch of chunk(work, groupAccessConditionBatchSize)) {
			this.context.db
				.update(schema.caches)
				.set({ updateHold: true })
				.where(
					and(
						eq(schema.caches.lifecycleState, 'active'),
						localGroupCacheConditions(cacheBatch)
					)
				)
				.run();
		}

		return true;
	}

	private async failGroupAccessTransition(
		transition: GroupAccessTransitionRow
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());
		const transitionCondition = and(
			eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
			eq(d1Schema.managedGroupAccessTransition.id, transition.id),
			inArray(d1Schema.managedGroupAccessTransition.status, [
				'running',
				'finalising'
			])
		);
		const familyCondition = and(
			eq(d1Schema.managedPolicyFamily.tenant, tenant),
			eq(d1Schema.managedPolicyFamily.status, 'updating'),
			isNotNull(d1Schema.managedPolicyFamily.pendingRevision),
			inArray(
				d1Schema.managedPolicyFamily.id,
				groupAccessParticipants(transition).map(
					(participant) => participant.policyId
				)
			),
			sql`exists (
				select 1 from ${d1Schema.managedGroupAccessTransition}
				where ${d1Schema.managedGroupAccessTransition.tenant} = ${tenant}
					and ${d1Schema.managedGroupAccessTransition.id} = ${transition.id}
					and ${d1Schema.managedGroupAccessTransition.status} = 'failed'
			)`,
			sql`exists (
				select 1 from ${d1Schema.managedPolicyRevision}
				where ${d1Schema.managedPolicyRevision.tenant} = ${tenant}
					and ${d1Schema.managedPolicyRevision.policyId} = ${d1Schema.managedPolicyFamily.id}
					and ${d1Schema.managedPolicyRevision.revision} = ${d1Schema.managedPolicyFamily.pendingRevision}
					and ${d1Schema.managedPolicyRevision.groupId} = ${transition.targetGroupId}
			)`
		);
		await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.managedGroupAccessTransition)
				.set({
					status: 'failed',
					lastFailureJson: JSON.stringify({
						code: 'MANAGED_GROUP_ACCESS_UPDATE_FAILED'
					}),
					updatedAt: now
				})
				.where(transitionCondition),
			this.context.d1
				.update(d1Schema.managedPolicyFamily)
				.set({ status: 'update-failed', updatedAt: now })
				.where(familyCondition)
		]);
	}

	private async moveGroupAccessCache(
		transition: GroupAccessTransitionRow,
		row: GroupAccessCacheMove
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const cacheName = cacheNameSchema.parse(row.cacheName);
		const targetRevision = row.pendingRevision;
		const targetReadRevision = row.targetReadRevision;
		const d1Identity = and(
			eq(d1Schema.cacheLifecycle.tenant, tenant),
			eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
			eq(d1Schema.cacheLifecycle.cacheName, cacheName),
			eq(d1Schema.cacheLifecycle.generation, row.generation),
			eq(d1Schema.cacheLifecycle.managedGroupId, transition.groupId),
			eq(d1Schema.cacheLifecycle.managedPolicyId, row.policyId),
			eq(d1Schema.cacheLifecycle.state, 'active'),
			eq(d1Schema.cacheLifecycle.updateHold, true)
		);
		const detached = await this.context.d1
			.update(d1Schema.cacheLifecycle)
			.set({
				selectionState: 'detached',
				...(transition.targetAccess === 'private' && {
					access: 'private',
					readRevision: targetReadRevision
				}),
				updatedAt: isoTimestamp(new Date())
			})
			.where(d1Identity)
			.run();

		if (detached.meta.changes !== 1) {
			const current = await this.context.d1
				.select({
					groupId: d1Schema.cacheLifecycle.managedGroupId,
					policyRevision: d1Schema.cacheLifecycle.managedPolicyRevision,
					readRevision: d1Schema.cacheLifecycle.readRevision
				})
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
						eq(d1Schema.cacheLifecycle.cacheName, cacheName),
						eq(d1Schema.cacheLifecycle.generation, row.generation)
					)
				)
				.get();

			if (
				current?.groupId === transition.targetGroupId &&
				current.policyRevision === targetRevision &&
				current.readRevision === targetReadRevision
			) {
				return;
			}

			throw new ManagedCacheConflictError({ kind: 'named', name: cacheName });
		}

		const local = this.context.db
			.select()
			.from(schema.caches)
			.where(
				and(
					eq(schema.caches.kind, 'named'),
					eq(schema.caches.name, cacheName),
					eq(schema.caches.generation, row.generation),
					eq(schema.caches.managedPolicyId, row.policyId),
					eq(schema.caches.lifecycleState, 'active'),
					isNull(schema.caches.deletedAt)
				)
			)
			.get();

		if (local === undefined) {
			throw new ManagedCacheConflictError({ kind: 'named', name: cacheName });
		}

		const isSource =
			local.managedGroupId === transition.groupId &&
			local.managedPolicyRevision === row.sourceRevision &&
			local.access === transition.sourceAccess &&
			local.readRevision === targetReadRevision - 1 &&
			local.selectionState === 'source-active' &&
			local.updateHold;
		const isTarget =
			local.managedGroupId === transition.targetGroupId &&
			local.managedPolicyRevision === targetRevision &&
			local.access === transition.targetAccess &&
			local.readRevision === targetReadRevision &&
			local.selectionState === 'target-active' &&
			local.updateHold;

		if (!isSource && !isTarget) {
			throw new ManagedCacheConflictError({ kind: 'named', name: cacheName });
		}

		if (isSource) {
			this.context.db.transaction((tx) => {
				tx.update(schema.caches)
					.set({ selectionState: 'detached' })
					.where(
						and(
							eq(schema.caches.id, local.id),
							eq(schema.caches.selectionState, 'source-active'),
							eq(schema.caches.updateHold, true)
						)
					)
					.run();
				tx.update(schema.caches)
					.set({
						access: transition.targetAccess,
						readRevision: targetReadRevision,
						managedPolicyRevision: targetRevision,
						managedGroupId: transition.targetGroupId,
						selectionState: 'target-active'
					})
					.where(
						and(
							eq(schema.caches.id, local.id),
							eq(schema.caches.selectionState, 'detached'),
							eq(schema.caches.updateHold, true)
						)
					)
					.run();
			});

			const movedLocal = this.context.db
				.select({
					access: schema.caches.access,
					readRevision: schema.caches.readRevision,
					policyRevision: schema.caches.managedPolicyRevision,
					groupId: schema.caches.managedGroupId,
					selectionState: schema.caches.selectionState,
					updateHold: schema.caches.updateHold
				})
				.from(schema.caches)
				.where(eq(schema.caches.id, local.id))
				.get();

			if (
				movedLocal?.access !== transition.targetAccess ||
				movedLocal.readRevision !== targetReadRevision ||
				movedLocal.policyRevision !== targetRevision ||
				movedLocal.groupId !== transition.targetGroupId ||
				movedLocal.selectionState !== 'target-active' ||
				!movedLocal.updateHold
			) {
				throw new ManagedCacheConflictError({
					kind: 'named',
					name: cacheName
				});
			}
		}

		const workIdentity = d1TransitionCacheCondition(
			tenant,
			transition.id,
			cacheName
		);
		const detachedIdentity = and(
			d1Identity,
			eq(d1Schema.cacheLifecycle.selectionState, 'detached')
		);
		const pendingWorkIdentity = and(
			workIdentity,
			eq(d1Schema.managedGroupAccessTransitionCache.state, 'pending')
		);
		const movedAt = isoTimestamp(new Date());
		const updated = await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					access: transition.targetAccess,
					readRevision: targetReadRevision,
					managedPolicyRevision: targetRevision,
					managedGroupId: transition.targetGroupId,
					selectionState: 'target-active',
					updatedAt: movedAt
				})
				.where(detachedIdentity),
			this.context.d1
				.update(d1Schema.managedGroupAccessTransitionCache)
				.set({ state: 'moved' })
				.where(pendingWorkIdentity)
		]);

		if (updated.some((result) => result.meta.changes !== 1)) {
			const cacheIdentity = and(
				eq(d1Schema.cacheLifecycle.tenant, tenant),
				eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
				eq(d1Schema.cacheLifecycle.cacheName, cacheName),
				eq(d1Schema.cacheLifecycle.generation, row.generation)
			);
			const [current, work] = await Promise.all([
				this.context.d1
					.select({
						access: d1Schema.cacheLifecycle.access,
						readRevision: d1Schema.cacheLifecycle.readRevision,
						policyRevision: d1Schema.cacheLifecycle.managedPolicyRevision,
						groupId: d1Schema.cacheLifecycle.managedGroupId,
						selectionState: d1Schema.cacheLifecycle.selectionState,
						updateHold: d1Schema.cacheLifecycle.updateHold
					})
					.from(d1Schema.cacheLifecycle)
					.where(cacheIdentity)
					.get(),
				this.context.d1
					.select({ state: d1Schema.managedGroupAccessTransitionCache.state })
					.from(d1Schema.managedGroupAccessTransitionCache)
					.where(workIdentity)
					.get()
			]);

			if (
				current?.access === transition.targetAccess &&
				current.readRevision === targetReadRevision &&
				current.policyRevision === targetRevision &&
				current.groupId === transition.targetGroupId &&
				((current.selectionState === 'target-active' &&
					current.updateHold &&
					work?.state === 'moved') ||
					(current.selectionState === 'source-active' &&
						!current.updateHold &&
						work?.state === 'complete'))
			) {
				return;
			}

			throw new ManagedCacheConflictError({ kind: 'named', name: cacheName });
		}
	}

	private async moveNextGroupAccessCaches(
		transition: GroupAccessTransitionRow,
		limit: number
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const work = await this.context.d1
			.select({
				cacheName: d1Schema.managedGroupAccessTransitionCache.cacheName,
				generation: d1Schema.managedGroupAccessTransitionCache.generation,
				targetReadRevision:
					d1Schema.managedGroupAccessTransitionCache.targetReadRevision,
				policyId: d1Schema.managedGroupAccessTransitionCache.policyId
			})
			.from(d1Schema.managedGroupAccessTransitionCache)
			.where(
				and(
					eq(d1Schema.managedGroupAccessTransitionCache.tenant, tenant),
					eq(
						d1Schema.managedGroupAccessTransitionCache.transitionId,
						transition.id
					),
					eq(d1Schema.managedGroupAccessTransitionCache.state, 'pending')
				)
			)
			.orderBy(asc(d1Schema.managedGroupAccessTransitionCache.cacheName))
			.limit(Math.min(limit, groupAccessCacheBatchSize))
			.all();

		if (work.length === 0) {
			await this.setGroupAccessTransitionPhase(transition, 'switch-view');
			return false;
		}

		const revisionsByPolicy = new Map(
			groupAccessParticipants(transition).map(
				(
					participant
				): [
					ManagedPolicyId,
					{
						readonly source: ManagedPolicyRevision;
						readonly target: ManagedPolicyRevision;
					}
				] => [
					participant.policyId,
					{
						source: participant.sourceRevision,
						target: participant.targetRevision
					}
				]
			)
		);

		for (const item of work) {
			const current = await this.context.d1
				.select({
					policyId: d1Schema.cacheLifecycle.managedPolicyId
				})
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
						eq(d1Schema.cacheLifecycle.cacheName, item.cacheName),
						eq(d1Schema.cacheLifecycle.generation, item.generation),
						eq(d1Schema.cacheLifecycle.managedGroupId, transition.groupId),
						eq(d1Schema.cacheLifecycle.state, 'active')
					)
				)
				.get();
			const revisions = revisionsByPolicy.get(item.policyId);

			if (revisions === undefined || current?.policyId !== item.policyId) {
				throw new ManagedPolicyConflictError(item.policyId);
			}

			await this.moveGroupAccessCache(transition, {
				cacheName: item.cacheName,
				generation: item.generation,
				targetReadRevision: item.targetReadRevision,
				policyId: item.policyId,
				sourceRevision: revisions.source,
				pendingRevision: revisions.target
			});
		}

		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
		return true;
	}

	private async switchGroupAccessView(
		transition: GroupAccessTransitionRow
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const groups = await this.context.d1
			.select()
			.from(d1Schema.managedCacheGroup)
			.where(
				and(
					eq(d1Schema.managedCacheGroup.tenant, tenant),
					inArray(d1Schema.managedCacheGroup.id, [
						transition.groupId,
						transition.targetGroupId
					])
				)
			)
			.all();
		const source = groups.find((group) => group.id === transition.groupId);
		const target = groups.find(
			(group) => group.id === transition.targetGroupId
		);

		if (source === undefined || target === undefined) {
			throw new ManagedGroupNotFoundError(
				source === undefined ? transition.groupId : transition.targetGroupId
			);
		}

		const viewName = reuseViewNameSchema.parse(
			target.state === 'active' ? target.reuseViewName : source.reuseViewName
		);

		if (source.state !== 'retired' || target.state !== 'active') {
			const sourceCondition = and(
				eq(d1Schema.managedCacheGroup.tenant, tenant),
				eq(d1Schema.managedCacheGroup.id, transition.groupId),
				eq(d1Schema.managedCacheGroup.state, 'transitioning')
			);
			const targetCondition = and(
				eq(d1Schema.managedCacheGroup.tenant, tenant),
				eq(d1Schema.managedCacheGroup.id, transition.targetGroupId),
				eq(d1Schema.managedCacheGroup.state, 'transitioning')
			);
			const retiredViewName = reuseViewNameSchema.parse(
				`retired-${transition.id}`
			);
			const results = await this.context.d1.batch([
				this.context.d1
					.update(d1Schema.managedCacheGroup)
					.set({ state: 'retired', reuseViewName: retiredViewName })
					.where(sourceCondition),
				this.context.d1
					.update(d1Schema.managedCacheGroup)
					.set({ state: 'active', reuseViewName: viewName })
					.where(targetCondition)
			]);

			if (results.some((result) => result.meta.changes !== 1)) {
				throw new ManagedPolicyConflictError();
			}
		}

		this.reuseViews.setManagedView(viewName, {
			access: transition.targetAccess,
			selectors: [{ kind: 'managed-group', groupId: transition.targetGroupId }],
			priority: reuseViewPrioritySchema.parse(target.reuseViewPriority)
		});
		const updated = await this.context.d1
			.update(d1Schema.managedGroupAccessTransition)
			.set({
				status: 'finalising',
				phase: 'release-holds',
				updatedAt: isoTimestamp(new Date())
			})
			.where(
				and(
					eq(d1Schema.managedGroupAccessTransition.tenant, tenant),
					eq(d1Schema.managedGroupAccessTransition.id, transition.id),
					eq(d1Schema.managedGroupAccessTransition.phase, 'switch-view'),
					eq(d1Schema.managedGroupAccessTransition.status, 'running')
				)
			)
			.run();

		if (updated.meta.changes !== 1) {
			throw new ManagedPolicyConflictError();
		}
	}

	private async releaseNextGroupAccessHolds(
		transition: GroupAccessTransitionRow
	): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const work = await this.context.d1
			.select({
				cacheName: d1Schema.managedGroupAccessTransitionCache.cacheName,
				generation: d1Schema.managedGroupAccessTransitionCache.generation,
				policyId: d1Schema.managedGroupAccessTransitionCache.policyId
			})
			.from(d1Schema.managedGroupAccessTransitionCache)
			.where(
				and(
					eq(d1Schema.managedGroupAccessTransitionCache.tenant, tenant),
					eq(
						d1Schema.managedGroupAccessTransitionCache.transitionId,
						transition.id
					),
					eq(d1Schema.managedGroupAccessTransitionCache.state, 'moved')
				)
			)
			.orderBy(asc(d1Schema.managedGroupAccessTransitionCache.cacheName))
			.limit(groupAccessConditionBatchSize)
			.all();

		if (work.length === 0) {
			await this.setGroupAccessTransitionPhase(transition, 'activate-policies');
			return false;
		}

		this.context.db
			.update(schema.caches)
			.set({ selectionState: 'source-active', updateHold: false })
			.where(
				and(
					eq(schema.caches.access, transition.targetAccess),
					eq(schema.caches.managedGroupId, transition.targetGroupId),
					eq(schema.caches.selectionState, 'target-active'),
					eq(schema.caches.updateHold, true),
					localGroupCacheConditions(work)
				)
			)
			.run();
		const now = isoTimestamp(new Date());
		const heldCondition = and(
			eq(d1Schema.cacheLifecycle.tenant, tenant),
			eq(d1Schema.cacheLifecycle.managedGroupId, transition.targetGroupId),
			eq(d1Schema.cacheLifecycle.access, transition.targetAccess),
			eq(d1Schema.cacheLifecycle.selectionState, 'target-active'),
			eq(d1Schema.cacheLifecycle.updateHold, true),
			d1GroupCacheConditions(work)
		);
		const movedWorkCondition = and(
			eq(d1Schema.managedGroupAccessTransitionCache.tenant, tenant),
			eq(
				d1Schema.managedGroupAccessTransitionCache.transitionId,
				transition.id
			),
			inArray(
				d1Schema.managedGroupAccessTransitionCache.cacheName,
				work.map((cache) => cache.cacheName)
			),
			eq(d1Schema.managedGroupAccessTransitionCache.state, 'moved')
		);
		const results = await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					selectionState: 'source-active',
					updateHold: false,
					updatedAt: now
				})
				.where(heldCondition),
			this.context.d1
				.update(d1Schema.managedGroupAccessTransitionCache)
				.set({ state: 'complete' })
				.where(movedWorkCondition)
		]);

		if (results.some((result) => result.meta.changes === 0)) {
			throw new ManagedPolicyConflictError();
		}

		return true;
	}

	private async activateGroupAccessPolicies(
		transition: GroupAccessTransitionRow
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const participantIds = groupAccessParticipants(transition).map(
			(participant) => participant.policyId
		);
		const now = isoTimestamp(new Date());
		const familyCondition = and(
			eq(d1Schema.managedPolicyFamily.tenant, tenant),
			eq(d1Schema.managedPolicyFamily.status, 'updating'),
			inArray(d1Schema.managedPolicyFamily.id, participantIds),
			sql`exists (
				select 1 from ${d1Schema.managedPolicyRevision}
				where ${d1Schema.managedPolicyRevision.tenant} = ${tenant}
					and ${d1Schema.managedPolicyRevision.policyId} = ${d1Schema.managedPolicyFamily.id}
					and ${d1Schema.managedPolicyRevision.revision} = ${d1Schema.managedPolicyFamily.pendingRevision}
					and ${d1Schema.managedPolicyRevision.groupId} = ${transition.targetGroupId}
			)`
		);
		const transitionCondition = and(
			this.groupAccessTransitionCondition(transition.id),
			eq(d1Schema.managedGroupAccessTransition.phase, 'activate-policies'),
			eq(d1Schema.managedGroupAccessTransition.status, 'finalising')
		);
		const results = await this.context.d1.batch([
			this.context.d1
				.update(d1Schema.managedPolicyFamily)
				.set({
					status: 'active',
					currentRevision: sql`${d1Schema.managedPolicyFamily.pendingRevision}`,
					pendingRevision: sql`NULL`,
					updatedAt: now
				})
				.where(familyCondition),
			this.context.d1
				.update(d1Schema.managedGroupAccessTransition)
				.set({ status: 'complete', updatedAt: now })
				.where(transitionCondition)
		]);

		if (results.some((result) => result.meta.changes === 0)) {
			throw new ManagedPolicyConflictError();
		}
	}

	private async advanceGroupAccessTransition(limit: number): Promise<boolean> {
		const transition = await this.activeGroupAccessTransition();

		if (transition === undefined) {
			return false;
		}

		try {
			switch (transition.phase) {
				case 'cancel-creations': {
					if (!(await this.cancelNextCreatingGroupCache(transition))) {
						await this.setGroupAccessTransitionPhase(
							transition,
							'prepare-policies'
						);
					}
					break;
				}
				case 'prepare-policies': {
					await this.prepareNextGroupAccessPolicy(transition);
					break;
				}
				case 'capture-caches': {
					await this.captureGroupAccessCaches(transition);
					break;
				}
				case 'move-caches': {
					await this.moveNextGroupAccessCaches(transition, limit);
					break;
				}
				case 'switch-view': {
					await this.switchGroupAccessView(transition);
					break;
				}
				case 'release-holds': {
					await this.releaseNextGroupAccessHolds(transition);
					break;
				}
				case 'activate-policies': {
					await this.activateGroupAccessPolicies(transition);
					break;
				}
			}

			await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
			return true;
		} catch (error) {
			if (
				error instanceof ManagedCacheConflictError ||
				error instanceof ManagedPolicyConflictError ||
				error instanceof ManagedGroupNotFoundError
			) {
				await this.failGroupAccessTransition(transition);
			}

			throw error;
		}
	}

	private async beginPolicyConfigurationUpdate(
		policy: StoredPolicy,
		request: ManagedPolicyPutBody
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const nextRevision = managedPolicyRevisionSchema.parse(
			policy.family.currentRevision + 1
		);
		const now = isoTimestamp(new Date());
		const familyCondition = and(
			eq(d1Schema.managedPolicyFamily.tenant, tenant),
			eq(d1Schema.managedPolicyFamily.id, policy.family.id),
			eq(
				d1Schema.managedPolicyFamily.currentRevision,
				policy.family.currentRevision
			),
			eq(d1Schema.managedPolicyFamily.status, 'active')
		);
		const lifecycleCondition = and(
			eq(d1Schema.cacheLifecycle.tenant, tenant),
			eq(d1Schema.cacheLifecycle.managedPolicyId, policy.family.id),
			eq(d1Schema.cacheLifecycle.state, 'active')
		);
		await this.context.d1.batch([
			this.context.d1.insert(d1Schema.managedPolicyRevision).values({
				tenant,
				policyId: policy.family.id,
				revision: nextRevision,
				groupId: policy.group.id,
				access: policy.revision.access,
				priority: request.priority,
				defaultRootTtlSeconds:
					request.defaultRootRetention.kind === 'duration'
						? request.defaultRootRetention.seconds
						: sql`NULL`,
				graceSeconds: request.graceSeconds ?? sql`NULL`,
				maximumRootDurationSeconds: request.maximumRootDurationSeconds,
				allowPermanentRoots: request.allowPermanentRoots,
				creationLeaseSeconds: request.creationLeaseSeconds,
				provisionalLeaseSeconds: request.provisionalLeaseSeconds,
				activityLeaseSeconds: request.activityLeaseSeconds,
				maximumLiveCaches: request.maximumLiveCaches,
				createdAt: now
			}),
			this.context.d1
				.update(d1Schema.managedPolicyFamily)
				.set({
					status: 'updating',
					pendingRevision: nextRevision,
					updatedAt: now
				})
				.where(familyCondition),
			this.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({ updateHold: true, updatedAt: now })
				.where(lifecycleCondition)
		]);

		this.context.db
			.update(schema.caches)
			.set({ updateHold: true })
			.where(
				and(
					eq(schema.caches.managedPolicyId, policy.family.id),
					eq(schema.caches.lifecycleState, 'active')
				)
			)
			.run();
		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
	}

	private async resumePolicyConfigurationUpdate(
		policy: StoredPolicy
	): Promise<void> {
		const tenant = this.context.requireTenant();
		const now = isoTimestamp(new Date());

		await this.context.d1
			.update(d1Schema.managedPolicyFamily)
			.set({ status: 'updating', updatedAt: now })
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyFamily.id, policy.family.id),
					eq(d1Schema.managedPolicyFamily.status, 'update-failed'),
					isNotNull(d1Schema.managedPolicyFamily.pendingRevision)
				)
			)
			.run();
		await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
	}

	private async failPolicyConfigurationUpdate(
		policyId: ManagedPolicyId
	): Promise<void> {
		const tenant = this.context.requireTenant();

		await this.context.d1
			.update(d1Schema.managedPolicyFamily)
			.set({ status: 'update-failed', updatedAt: isoTimestamp(new Date()) })
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyFamily.id, policyId),
					eq(d1Schema.managedPolicyFamily.status, 'updating')
				)
			)
			.run();
	}

	private async advancePolicyConfigurationUpdate(
		limit: number
	): Promise<boolean> {
		if ((await this.activeGroupAccessTransition()) !== undefined) {
			return false;
		}

		const tenant = this.context.requireTenant();
		const family = await this.context.d1
			.select()
			.from(d1Schema.managedPolicyFamily)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					inArray(d1Schema.managedPolicyFamily.status, [
						'updating',
						'retiring'
					]),
					isNotNull(d1Schema.managedPolicyFamily.pendingRevision)
				)
			)
			.orderBy(asc(d1Schema.managedPolicyFamily.updatedAt))
			.limit(1)
			.get();

		const pendingRevision = family?.pendingRevision ?? undefined;

		if (family === undefined || pendingRevision === undefined) {
			return false;
		}

		try {
			const pending = await this.storedPolicyRevision(family, pendingRevision);
			const rows = await this.context.d1
				.select({
					cacheName: d1Schema.cacheLifecycle.cacheName,
					generation: d1Schema.cacheLifecycle.generation
				})
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.managedPolicyId, family.id),
						eq(d1Schema.cacheLifecycle.state, 'active'),
						eq(d1Schema.cacheLifecycle.updateHold, true),
						ne(
							d1Schema.cacheLifecycle.managedPolicyRevision,
							pending.revision.revision
						)
					)
				)
				.orderBy(asc(d1Schema.cacheLifecycle.cacheName))
				.limit(Math.min(limit, policyUpdateCacheBatchSize))
				.all();

			for (const row of rows) {
				const cacheName = cacheNameSchema.parse(row.cacheName);
				const local = this.context.db
					.select({ id: schema.caches.id })
					.from(schema.caches)
					.where(
						and(
							eq(schema.caches.kind, 'named'),
							eq(schema.caches.name, cacheName),
							eq(schema.caches.generation, row.generation),
							eq(schema.caches.managedPolicyId, family.id),
							eq(schema.caches.lifecycleState, 'active'),
							isNull(schema.caches.deletedAt)
						)
					)
					.get();

				if (local === undefined) {
					throw new ManagedCacheConflictError({
						kind: 'named',
						name: cacheName
					});
				}

				this.context.db
					.update(schema.caches)
					.set({
						priority: cachePrioritySchema.parse(pending.revision.priority),
						defaultRootTtlSeconds:
							pending.revision.defaultRootTtlSeconds === null
								? sql`NULL`
								: ttlSecondsSchema.parse(
										pending.revision.defaultRootTtlSeconds
									),
						graceSeconds:
							pending.revision.graceSeconds === null
								? sql`NULL`
								: graceSecondsSchema.parse(pending.revision.graceSeconds),
						managedPolicyRevision: pending.revision.revision,
						updateHold: true
					})
					.where(eq(schema.caches.id, local.id))
					.run();
				const changed = await this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({
						managedPolicyRevision: pending.revision.revision,
						updatedAt: isoTimestamp(new Date())
					})
					.where(
						and(
							eq(d1Schema.cacheLifecycle.tenant, tenant),
							eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
							eq(d1Schema.cacheLifecycle.cacheName, cacheName),
							eq(d1Schema.cacheLifecycle.generation, row.generation),
							eq(d1Schema.cacheLifecycle.managedPolicyId, family.id),
							eq(d1Schema.cacheLifecycle.updateHold, true)
						)
					)
					.run();

				if (changed.meta.changes !== 1) {
					throw new ManagedCacheConflictError({
						kind: 'named',
						name: cacheName
					});
				}
			}

			if (rows.length > 0) {
				await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
				return true;
			}

			const now = isoTimestamp(new Date());
			const lifecycleCondition = and(
				eq(d1Schema.cacheLifecycle.tenant, tenant),
				eq(d1Schema.cacheLifecycle.managedPolicyId, family.id),
				eq(
					d1Schema.cacheLifecycle.managedPolicyRevision,
					pending.revision.revision
				)
			);
			const familyCondition = and(
				eq(d1Schema.managedPolicyFamily.tenant, tenant),
				eq(d1Schema.managedPolicyFamily.id, family.id),
				eq(d1Schema.managedPolicyFamily.status, family.status),
				eq(
					d1Schema.managedPolicyFamily.pendingRevision,
					pending.revision.revision
				)
			);
			this.context.db
				.update(schema.caches)
				.set({ updateHold: false })
				.where(
					and(
						eq(schema.caches.managedPolicyId, family.id),
						eq(schema.caches.managedPolicyRevision, pending.revision.revision)
					)
				)
				.run();
			await this.context.d1.batch([
				this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ updateHold: false, updatedAt: now })
					.where(lifecycleCondition),
				this.context.d1
					.update(d1Schema.managedPolicyFamily)
					.set({
						status: family.status === 'retiring' ? 'retiring' : 'active',
						currentRevision: pending.revision.revision,
						pendingRevision: sql`NULL`,
						updatedAt: now
					})
					.where(familyCondition)
			]);
			return true;
		} catch (error) {
			await this.failPolicyConfigurationUpdate(family.id);
			throw error;
		}
	}

	private async finalisableFamily(): Promise<
		| {
				readonly id: ManagedPolicyId;
				readonly groupId: ManagedCacheGroupId;
				readonly reuseViewName: string;
		  }
		| undefined
	> {
		const tenant = this.context.requireTenant();
		const family = await this.context.d1
			.select({
				id: d1Schema.managedPolicyFamily.id,
				currentRevision: d1Schema.managedPolicyFamily.currentRevision
			})
			.from(d1Schema.managedPolicyFamily)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					eq(d1Schema.managedPolicyFamily.status, 'retiring'),
					sql`not exists (
						select 1 from ${d1Schema.cacheLifecycle}
						where ${d1Schema.cacheLifecycle.tenant} = ${tenant}
							and ${d1Schema.cacheLifecycle.managedPolicyId} = ${d1Schema.managedPolicyFamily.id}
							and ${d1Schema.cacheLifecycle.state} <> 'deleted'
					)`
				)
			)
			.orderBy(asc(d1Schema.managedPolicyFamily.updatedAt))
			.limit(1)
			.get();

		if (family === undefined) {
			return undefined;
		}

		const revision = await this.context.d1
			.select({ groupId: d1Schema.managedPolicyRevision.groupId })
			.from(d1Schema.managedPolicyRevision)
			.where(
				and(
					eq(d1Schema.managedPolicyRevision.tenant, tenant),
					eq(d1Schema.managedPolicyRevision.policyId, family.id),
					eq(d1Schema.managedPolicyRevision.revision, family.currentRevision)
				)
			)
			.get();

		if (revision === undefined) {
			throw new ManagedPolicyConflictError(family.id);
		}

		const group = await this.context.d1
			.select({ reuseViewName: d1Schema.managedCacheGroup.reuseViewName })
			.from(d1Schema.managedCacheGroup)
			.where(
				and(
					eq(d1Schema.managedCacheGroup.tenant, tenant),
					eq(d1Schema.managedCacheGroup.id, revision.groupId)
				)
			)
			.get();

		if (group === undefined) {
			throw new ManagedPolicyConflictError(family.id);
		}

		return {
			id: family.id,
			groupId: revision.groupId,
			reuseViewName: group.reuseViewName
		};
	}

	private async finaliseRetiringFamily(): Promise<boolean> {
		const tenant = this.context.requireTenant();
		const family = await this.finalisableFamily();

		if (family === undefined) {
			return false;
		}

		const revisionCondition = and(
			eq(d1Schema.managedPolicyRevision.tenant, tenant),
			eq(d1Schema.managedPolicyRevision.policyId, family.id)
		);
		const familyCondition = and(
			eq(d1Schema.managedPolicyFamily.tenant, tenant),
			eq(d1Schema.managedPolicyFamily.id, family.id),
			eq(d1Schema.managedPolicyFamily.status, 'retiring')
		);

		const remainingGroupRevision = await this.context.d1
			.select({ policyId: d1Schema.managedPolicyRevision.policyId })
			.from(d1Schema.managedPolicyRevision)
			.where(
				and(
					eq(d1Schema.managedPolicyRevision.tenant, tenant),
					eq(d1Schema.managedPolicyRevision.groupId, family.groupId),
					ne(d1Schema.managedPolicyRevision.policyId, family.id)
				)
			)
			.limit(1)
			.get();

		if (remainingGroupRevision === undefined) {
			this.reuseViews.removeManagedView(
				reuseViewNameSchema.parse(family.reuseViewName)
			);
		}

		const revisionDeletion = this.context.d1
			.delete(d1Schema.managedPolicyRevision)
			.where(revisionCondition);
		const familyDeletion = this.context.d1
			.delete(d1Schema.managedPolicyFamily)
			.where(familyCondition);

		if (remainingGroupRevision === undefined) {
			const groupCondition = and(
				eq(d1Schema.managedCacheGroup.tenant, tenant),
				eq(d1Schema.managedCacheGroup.id, family.groupId)
			);
			await this.context.d1.batch([
				revisionDeletion,
				familyDeletion,
				this.context.d1.delete(d1Schema.managedCacheGroup).where(groupCondition)
			]);
			return true;
		}

		await this.context.d1.batch([revisionDeletion, familyDeletion]);

		return true;
	}

	private async retireEligiblePolicyCaches(
		policyId: ManagedPolicyId,
		limit: number
	): Promise<number> {
		const now = isoTimestamp(new Date());
		const candidates = this.context.db
			.select({ id: schema.caches.id })
			.from(schema.caches)
			.where(this.retirementCondition(now, policyId))
			.limit(limit)
			.all();

		for (const row of candidates) {
			const cache = this.context.cacheRepository.resolvedForId(row.id);
			await this.cacheAdmin.tearDownCache(cache, internalOrigin);
		}

		return candidates.length;
	}

	async listPolicies(): Promise<{ policies: ManagedPolicySummary[] }> {
		const tenant = this.context.requireTenant();
		const families = await this.context.d1
			.select({ id: d1Schema.managedPolicyFamily.id })
			.from(d1Schema.managedPolicyFamily)
			.where(eq(d1Schema.managedPolicyFamily.tenant, tenant))
			.all();
		const policies = await Promise.all(
			families.map(async ({ id }) => {
				const policy = await this.storedPolicy(id);

				if (policy === undefined) {
					throw new ManagedPolicyConflictError(id);
				}

				return policySummary(policy);
			})
		);

		return {
			policies: policies.toSorted((left, right) =>
				left.id.localeCompare(right.id)
			)
		};
	}

	async putPolicy(
		request: ManagedPolicyPutBody
	): Promise<ManagedPolicySummary> {
		await this.context.requireRetentionAdministration();

		return this.context.criticalSection(async () => {
			const existing = await this.policyForRepository(request.repositoryId);

			if (existing !== undefined) {
				const summary = policySummary(existing);

				if (isSamePolicyRequest(summary, request)) {
					this.reconcileManagedView(existing);
					return summary;
				}

				if (
					(await this.latestGroupAccessTransition(existing.group.id)) !==
					undefined
				) {
					throw new ManagedPolicyConflictError(existing.family.id);
				}

				if (
					!isSamePolicyIdentity(summary, request) ||
					summary.configuration.access !== request.access ||
					existing.family.status === 'retiring'
				) {
					throw new ManagedPolicyConflictError(existing.family.id);
				}

				const pending = await this.pendingPolicyRevision(existing);

				if (pending === undefined) {
					if (existing.family.status !== 'active') {
						throw new ManagedPolicyConflictError(existing.family.id);
					}

					await this.beginPolicyConfigurationUpdate(existing, request);
				} else {
					if (!isSamePolicyRequest(policySummary(pending), request)) {
						throw new ManagedPolicyConflictError(existing.family.id);
					}

					if (existing.family.status === 'update-failed') {
						await this.resumePolicyConfigurationUpdate(existing);
					} else if (existing.family.status !== 'updating') {
						throw new ManagedPolicyConflictError(existing.family.id);
					}
				}

				await this.advancePolicyConfigurationUpdate(policyUpdateCacheBatchSize);
				const updated = await this.storedPolicy(existing.family.id);

				if (updated === undefined) {
					throw new ManagedPolicyConflictError(existing.family.id);
				}

				return policySummary(updated);
			}

			const tenant = this.context.requireTenant();
			const namespace =
				request.cacheNamespace ?? defaultNamespace(request.repositoryId);
			const existingNamespaces = await this.context.d1
				.select({
					id: d1Schema.managedPolicyFamily.id,
					value: d1Schema.managedPolicyFamily.cacheNamespace
				})
				.from(d1Schema.managedPolicyFamily)
				.where(eq(d1Schema.managedPolicyFamily.tenant, tenant))
				.all();
			const conflictingNamespace = existingNamespaces.find(
				(existing) =>
					namespace.startsWith(existing.value) ||
					existing.value.startsWith(namespace)
			);

			if (conflictingNamespace !== undefined) {
				throw new ManagedPolicyConflictError(conflictingNamespace.id);
			}

			const durableCacheInNamespace = await this.context.d1
				.select({ cacheName: d1Schema.cacheLifecycle.cacheName })
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.cacheKind, 'named'),
						eq(d1Schema.cacheLifecycle.managementKind, 'durable'),
						ne(d1Schema.cacheLifecycle.state, 'deleted'),
						sql`${d1Schema.cacheLifecycle.cacheName} GLOB ${`${namespace}*`}`
					)
				)
				.limit(1)
				.get();

			if (durableCacheInNamespace !== undefined) {
				throw new ManagedPolicyConflictError();
			}

			const groupForView = await this.context.d1
				.select()
				.from(d1Schema.managedCacheGroup)
				.where(
					and(
						eq(d1Schema.managedCacheGroup.tenant, tenant),
						eq(d1Schema.managedCacheGroup.reuseViewName, request.reuseViewName)
					)
				)
				.get();

			if (
				groupForView !== undefined &&
				(await this.latestGroupAccessTransition(groupForView.id)) !== undefined
			) {
				throw new ManagedPolicyConflictError();
			}

			if (groupForView !== undefined) {
				const policyCount = await this.context.d1
					.select({ value: count() })
					.from(d1Schema.managedPolicyFamily)
					.innerJoin(
						d1Schema.managedPolicyRevision,
						and(
							eq(
								d1Schema.managedPolicyRevision.tenant,
								d1Schema.managedPolicyFamily.tenant
							),
							eq(
								d1Schema.managedPolicyRevision.policyId,
								d1Schema.managedPolicyFamily.id
							),
							eq(
								d1Schema.managedPolicyRevision.revision,
								d1Schema.managedPolicyFamily.currentRevision
							)
						)
					)
					.where(
						and(
							eq(d1Schema.managedPolicyFamily.tenant, tenant),
							eq(d1Schema.managedPolicyRevision.groupId, groupForView.id)
						)
					)
					.get();

				if ((policyCount?.value ?? 0) >= maximumManagedPoliciesPerGroup) {
					throw new ManagedPolicyConflictError();
				}
			}

			if (
				groupForView !== undefined &&
				(groupForView.access !== request.access ||
					groupForView.reuseViewPriority !== request.reuseViewPriority)
			) {
				throw new ManagedPolicyConflictError();
			}

			if (
				groupForView === undefined &&
				this.reuseViews.resolve(request.reuseViewName) !== undefined
			) {
				throw new ManagedPolicyConflictError();
			}

			const now = isoTimestamp(new Date());
			const policyId =
				request.id ?? managedPolicyIdSchema.parse(crypto.randomUUID());
			const groupId =
				groupForView?.id ??
				request.groupId ??
				managedCacheGroupIdSchema.parse(crypto.randomUUID());

			if (
				groupForView !== undefined &&
				request.groupId !== undefined &&
				request.groupId !== groupForView.id
			) {
				throw new ManagedPolicyConflictError();
			}
			const revision = managedPolicyRevisionSchema.parse(1);
			const familyInsert = this.context.d1
				.insert(d1Schema.managedPolicyFamily)
				.values({
					tenant,
					id: policyId,
					ownerId: request.ownerId,
					repositoryId: request.repositoryId,
					cacheNamespace: namespace,
					status: 'active',
					currentRevision: revision,
					createdAt: now,
					updatedAt: now
				});
			const revisionInsert = this.context.d1
				.insert(d1Schema.managedPolicyRevision)
				.values({
					tenant,
					policyId,
					revision,
					groupId,
					access: request.access,
					priority: request.priority,
					defaultRootTtlSeconds:
						request.defaultRootRetention.kind === 'duration'
							? request.defaultRootRetention.seconds
							: sql`NULL`,
					graceSeconds: request.graceSeconds ?? sql`NULL`,
					maximumRootDurationSeconds: request.maximumRootDurationSeconds,
					allowPermanentRoots: request.allowPermanentRoots,
					creationLeaseSeconds: request.creationLeaseSeconds,
					provisionalLeaseSeconds: request.provisionalLeaseSeconds,
					activityLeaseSeconds: request.activityLeaseSeconds,
					maximumLiveCaches: request.maximumLiveCaches,
					createdAt: now
				});

			if (groupForView === undefined) {
				const groupInsert = this.context.d1
					.insert(d1Schema.managedCacheGroup)
					.values({
						tenant,
						id: groupId,
						access: request.access,
						reuseViewName: request.reuseViewName,
						reuseViewPriority: request.reuseViewPriority,
						createdAt: now
					});
				await this.context.d1.batch([
					groupInsert,
					familyInsert,
					revisionInsert
				]);
			} else {
				await this.context.d1.batch([familyInsert, revisionInsert]);
			}
			const created = await this.storedPolicy(policyId);

			if (created === undefined) {
				throw new ManagedPolicyConflictError(policyId);
			}

			this.reconcileManagedView(created);
			return policySummary(created);
		});
	}

	async retirePolicy(policyId: ManagedPolicyId): Promise<ManagedPolicySummary> {
		await this.context.requireRetentionAdministration();

		return this.context.criticalSection(async () => {
			const tenant = this.context.requireTenant();
			const policy = await this.storedPolicy(policyId);

			if (policy === undefined) {
				throw new ManagedPolicyConflictError(policyId);
			}

			const transition = await this.latestGroupAccessTransition(
				policy.group.id
			);

			if (transition !== undefined && transition.status !== 'complete') {
				throw new ManagedPolicyConflictError(policyId);
			}

			const now = isoTimestamp(new Date());
			const pendingRevision = policy.family.pendingRevision ?? undefined;
			const localPending =
				pendingRevision === undefined
					? undefined
					: this.context.db
							.select({ id: schema.caches.id })
							.from(schema.caches)
							.where(
								and(
									eq(schema.caches.managedPolicyId, policyId),
									eq(schema.caches.managedPolicyRevision, pendingRevision)
								)
							)
							.limit(1)
							.get();
			const cataloguePending =
				pendingRevision === undefined
					? undefined
					: await this.context.d1
							.select({ tenant: d1Schema.cacheLifecycle.tenant })
							.from(d1Schema.cacheLifecycle)
							.where(
								and(
									eq(d1Schema.cacheLifecycle.tenant, tenant),
									eq(d1Schema.cacheLifecycle.managedPolicyId, policyId),
									eq(
										d1Schema.cacheLifecycle.managedPolicyRevision,
										pendingRevision
									)
								)
							)
							.limit(1)
							.get();
			const requiresPendingRevisionCompletion =
				localPending !== undefined || cataloguePending !== undefined;

			if (policy.family.status === 'retiring') {
				if (requiresPendingRevisionCompletion) {
					await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());
					return policySummary(policy);
				}

				this.context.db
					.update(schema.caches)
					.set({ updateHold: false })
					.where(eq(schema.caches.managedPolicyId, policyId))
					.run();
				await this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ updateHold: false, updatedAt: now })
					.where(
						and(
							eq(d1Schema.cacheLifecycle.tenant, tenant),
							eq(d1Schema.cacheLifecycle.managedPolicyId, policyId)
						)
					)
					.run();
				return policySummary(policy);
			}

			const familyCondition = and(
				eq(d1Schema.managedPolicyFamily.tenant, tenant),
				eq(d1Schema.managedPolicyFamily.id, policyId),
				inArray(d1Schema.managedPolicyFamily.status, [
					'active',
					'updating',
					'update-failed'
				])
			);
			const lifecycleCondition = and(
				eq(d1Schema.cacheLifecycle.tenant, tenant),
				eq(d1Schema.cacheLifecycle.managedPolicyId, policyId)
			);

			if (requiresPendingRevisionCompletion) {
				const changed = await this.context.d1
					.update(d1Schema.managedPolicyFamily)
					.set({ status: 'retiring', updatedAt: now })
					.where(familyCondition)
					.run();

				if (changed.meta.changes !== 1) {
					throw new ManagedPolicyConflictError(policyId);
				}

				await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());

				const retiring = await this.storedPolicy(policyId);

				if (retiring === undefined) {
					throw new ManagedPolicyConflictError(policyId);
				}

				return policySummary(retiring);
			}

			this.context.db
				.update(schema.caches)
				.set({ updateHold: false })
				.where(eq(schema.caches.managedPolicyId, policyId))
				.run();
			const [changed] = await this.context.d1.batch([
				this.context.d1
					.update(d1Schema.managedPolicyFamily)
					.set({
						status: 'retiring',
						pendingRevision: sql`NULL`,
						updatedAt: now
					})
					.where(familyCondition),
				this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ updateHold: false, updatedAt: now })
					.where(lifecycleCondition)
			]);

			if (changed.meta.changes !== 1) {
				throw new ManagedPolicyConflictError(policyId);
			}

			await armAlarmNoLaterThan(this.context.ctx.storage, Date.now());

			const retiring = await this.storedPolicy(policyId);

			if (retiring === undefined) {
				throw new ManagedPolicyConflictError(policyId);
			}

			return policySummary(retiring);
		});
	}

	async setGroupAccess(
		groupId: ManagedCacheGroupId,
		access: CacheAccessMode
	): Promise<{ accepted: true }> {
		return this.context.criticalSection(async () => {
			const tenant = this.context.requireTenant();
			const group = await this.context.d1
				.select()
				.from(d1Schema.managedCacheGroup)
				.where(
					and(
						eq(d1Schema.managedCacheGroup.tenant, tenant),
						eq(d1Schema.managedCacheGroup.id, groupId)
					)
				)
				.get();

			if (group === undefined) {
				throw new ManagedGroupNotFoundError(groupId);
			}

			const transition = await this.latestGroupAccessTransition(groupId);

			if (transition !== undefined && transition.status !== 'complete') {
				if (transition.targetAccess !== access) {
					throw new ManagedPolicyConflictError();
				}
				await this.beginGroupAccessTransition(group, access);
				await this.advanceGroupAccessTransition(groupAccessCacheBatchSize);
				return { accepted: true };
			}

			if (group.access === access) {
				return { accepted: true };
			}

			await this.beginGroupAccessTransition(group, access);
			await this.advanceGroupAccessTransition(groupAccessCacheBatchSize);

			return { accepted: true };
		});
	}

	async provisionCache(
		cacheName: CacheName,
		claims: AccessClaims
	): Promise<ReturnType<CacheAdminService['cacheSummary']>> {
		const scope: CacheScope = { kind: 'named', name: cacheName };
		const grant = exactProvisionGrant(claims, scope);
		const policyId = managedPolicyIdSchema.parse(grant.managedPolicy);

		return this.context.criticalSection(async () => {
			const policy = await this.storedPolicy(policyId);

			if (
				policy?.family.status !== 'active' ||
				policy.group.state !== 'active'
			) {
				throw new ManagedCacheConflictError(scope);
			}

			const suffix = cacheName.slice(policy.family.cacheNamespace.length);

			if (
				!cacheName.startsWith(policy.family.cacheNamespace) ||
				!/^[1-9]\d*$/.test(suffix)
			) {
				throw new ManagedCacheConflictError(scope);
			}

			const tenant = this.context.requireTenant();
			const identity = cacheIdentityCondition(
				d1Schema.cacheLifecycle.cacheKind,
				d1Schema.cacheLifecycle.cacheName,
				scope
			);
			const lifecycle = await this.context.d1
				.select()
				.from(d1Schema.cacheLifecycle)
				.where(and(eq(d1Schema.cacheLifecycle.tenant, tenant), identity))
				.get();

			if (
				lifecycle !== undefined &&
				lifecycle.state !== 'deleted' &&
				(lifecycle.managementKind !== 'managed' ||
					lifecycle.managedPolicyId !== policyId)
			) {
				throw new ManagedCacheConflictError(scope);
			}

			if (lifecycle?.state === 'active') {
				return this.cacheAdmin.getCache(scope);
			}
			const isResumingCreation = lifecycle?.state === 'creating';
			const retired = isResumingCreation
				? 0
				: await this.retireEligiblePolicyCaches(policyId, 1);

			const live = await this.context.d1
				.select({ value: count() })
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.managedPolicyId, policyId),
						inArray(d1Schema.cacheLifecycle.state, [
							'creating',
							'active',
							'retiring'
						])
					)
				)
				.get();

			if (
				!isResumingCreation &&
				(live?.value ?? 0) >= policy.revision.maximumLiveCaches
			) {
				const nextEligible = this.context.db
					.select({ leaseExpiresAt: schema.caches.leaseExpiresAt })
					.from(schema.caches)
					.where(this.retirementEligibilityCondition(policyId))
					.orderBy(asc(schema.caches.leaseExpiresAt))
					.limit(1)
					.get();
				const nextCreation = await this.context.d1
					.select({
						creationExpiresAt: d1Schema.cacheLifecycle.creationExpiresAt
					})
					.from(d1Schema.cacheLifecycle)
					.where(
						and(
							eq(d1Schema.cacheLifecycle.tenant, tenant),
							eq(d1Schema.cacheLifecycle.managedPolicyId, policyId),
							eq(d1Schema.cacheLifecycle.state, 'creating'),
							isNotNull(d1Schema.cacheLifecycle.creationExpiresAt)
						)
					)
					.orderBy(asc(d1Schema.cacheLifecycle.creationExpiresAt))
					.limit(1)
					.get();
				const now = new Date();
				const retryFloor = atSeconds(now, 5);
				const eligibleRetry =
					nextEligible?.leaseExpiresAt === null ||
					nextEligible?.leaseExpiresAt === undefined
						? undefined
						: atSeconds(new Date(nextEligible.leaseExpiresAt), 5);
				const creationRetry =
					nextCreation?.creationExpiresAt === null ||
					nextCreation?.creationExpiresAt === undefined
						? undefined
						: new Date(nextCreation.creationExpiresAt);
				const nextAutomaticRetry = [eligibleRetry, creationRetry]
					.filter((candidate) => candidate !== undefined)
					.toSorted((left, right) => left.getTime() - right.getTime())
					.at(0);
				const automaticRetry =
					retired > 0
						? retryFloor
						: nextAutomaticRetry === undefined
							? undefined
							: new Date(
									Math.max(retryFloor.getTime(), nextAutomaticRetry.getTime())
								);
				throw new ManagedCacheCapacityError(
					automaticRetry === undefined
						? { kind: 'operator-action-required' }
						: {
								kind: 'temporarily-full',
								retryAt: isoTimestamp(automaticRetry)
							}
				);
			}

			const nowDate = new Date();
			const now = isoTimestamp(nowDate);
			const creationExpiresAt =
				lifecycle?.state === 'creating' && lifecycle.creationExpiresAt !== null
					? lifecycle.creationExpiresAt
					: isoTimestamp(
							atSeconds(nowDate, policy.revision.creationLeaseSeconds)
						);
			const generation = cacheGenerationSchema.parse(
				lifecycle === undefined
					? 1
					: lifecycle.state === 'deleted'
						? lifecycle.generation + 1
						: lifecycle.generation
			);
			const readRevision =
				lifecycle?.readRevision ?? cacheReadRevisionSchema.parse(1);
			const d1Values: typeof d1Schema.cacheLifecycle.$inferInsert = {
				tenant,
				cacheKind: 'named',
				cacheName,
				access: policy.revision.access,
				generation,
				readRevision,
				state: 'creating',
				creationExpiresAt,
				managementKind: 'managed',
				managedPolicyId: policyId,
				managedPolicyRevision: policy.revision.revision,
				managedGroupId: policy.group.id,
				leaseExpiresAt: undefined,
				selectionState: 'detached',
				deletedAt: undefined,
				updatedAt: now
			};

			if (lifecycle === undefined) {
				await this.context.d1
					.insert(d1Schema.cacheLifecycle)
					.values(d1Values)
					.run();
			} else {
				await this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({ ...d1Values, deletedAt: sql`NULL` })
					.where(and(eq(d1Schema.cacheLifecycle.tenant, tenant), identity))
					.run();
			}
			await armAlarmNoLaterThan(
				this.context.ctx.storage,
				new Date(creationExpiresAt).getTime()
			);

			let local = this.context.db
				.select()
				.from(schema.caches)
				.where(
					and(
						cacheIdentityCondition(
							schema.caches.kind,
							schema.caches.name,
							scope
						),
						isNull(schema.caches.deletedAt)
					)
				)
				.get();

			if (local !== undefined && local.managementKind !== 'managed') {
				throw new ManagedCacheConflictError(scope);
			}

			if (local === undefined) {
				this.context.cacheRepository.create(scope, {
					access: policy.revision.access,
					priority: cachePrioritySchema.parse(policy.revision.priority),
					generation,
					readRevision,
					defaultRootTtlSeconds:
						policy.revision.defaultRootTtlSeconds === null
							? undefined
							: ttlSecondsSchema.parse(policy.revision.defaultRootTtlSeconds),
					graceSeconds:
						policy.revision.graceSeconds === null
							? undefined
							: graceSecondsSchema.parse(policy.revision.graceSeconds),
					lifecycleState: 'creating',
					creationExpiresAt,
					management: {
						kind: 'managed',
						policyId,
						policyRevision: policy.revision.revision,
						groupId: policy.group.id
					}
				});
				local = this.context.db
					.select()
					.from(schema.caches)
					.where(
						and(
							cacheIdentityCondition(
								schema.caches.kind,
								schema.caches.name,
								scope
							),
							isNull(schema.caches.deletedAt)
						)
					)
					.get();
			}

			if (
				local?.managedPolicyId !== policyId ||
				local.managedPolicyRevision !== policy.revision.revision ||
				local.generation !== generation
			) {
				throw new ManagedCacheConflictError(scope);
			}

			const leaseExpiresAt = isoTimestamp(
				atSeconds(nowDate, policy.revision.provisionalLeaseSeconds)
			);
			const activationPayload: ManagedActivationRepairPayload = {
				cacheName,
				access: policy.revision.access,
				generation,
				readRevision,
				policyId,
				policyRevision: policy.revision.revision,
				groupId: policy.group.id,
				creationExpiresAt,
				leaseExpiresAt
			};
			const repairId = await beginManagedActivationRepair(
				this.context,
				activationPayload
			);
			this.context.db
				.update(schema.caches)
				.set({
					lifecycleState: 'active',
					creationExpiresAt: sql`NULL`,
					leaseExpiresAt,
					selectionState: 'source-active'
				})
				.where(eq(schema.caches.id, local.id))
				.run();
			try {
				const activated = await this.context.d1
					.update(d1Schema.cacheLifecycle)
					.set({
						state: 'active',
						creationExpiresAt: sql`NULL`,
						leaseExpiresAt,
						selectionState: 'source-active',
						updatedAt: isoTimestamp(new Date())
					})
					.where(
						and(
							eq(d1Schema.cacheLifecycle.tenant, tenant),
							identity,
							eq(d1Schema.cacheLifecycle.state, 'creating'),
							eq(d1Schema.cacheLifecycle.generation, generation),
							eq(d1Schema.cacheLifecycle.managedPolicyId, policyId),
							eq(
								d1Schema.cacheLifecycle.managedPolicyRevision,
								policy.revision.revision
							)
						)
					)
					.run();

				if (activated.meta.changes !== 1) {
					throw new ManagedCacheConflictError(scope);
				}
			} catch (error) {
				try {
					const outcome = await this.resolveManagedActivationRepair(
						repairId,
						JSON.stringify(activationPayload)
					);

					if (outcome === 'complete') {
						return this.cacheAdmin.getCache(scope);
					}
				} catch (repairError) {
					throw new ManagedActivationRepairDeferredError(repairId, {
						cause: repairError
					});
				}

				throw new ManagedCacheConflictError(scope, { cause: error });
			}
			await finishManagedActivationRepair(this.context, repairId, 'complete');

			return this.cacheAdmin.getCache(scope);
		});
	}

	async resolveManagedActivationRepair(
		id: string,
		payloadJson: string
	): Promise<'complete' | 'rolled-back'> {
		const parsed: unknown = JSON.parse(payloadJson);
		const payload = managedActivationRepairPayloadSchema.parse(parsed);
		const tenant = this.context.requireTenant();
		const scope: CacheScope = {
			kind: 'named',
			name: payload.cacheName
		};
		const identity = cacheIdentityCondition(
			d1Schema.cacheLifecycle.cacheKind,
			d1Schema.cacheLifecycle.cacheName,
			scope
		);
		const lifecycle = await this.context.d1
			.select()
			.from(d1Schema.cacheLifecycle)
			.where(and(eq(d1Schema.cacheLifecycle.tenant, tenant), identity))
			.get();
		const local = this.context.db
			.select()
			.from(schema.caches)
			.where(
				and(
					cacheIdentityCondition(schema.caches.kind, schema.caches.name, scope),
					isNull(schema.caches.deletedAt)
				)
			)
			.get();
		const isExactActiveLifecycle =
			lifecycle?.state === 'active' &&
			lifecycle.generation === payload.generation &&
			lifecycle.access === payload.access &&
			lifecycle.readRevision === payload.readRevision &&
			lifecycle.managedPolicyId === payload.policyId &&
			lifecycle.managedPolicyRevision === payload.policyRevision &&
			lifecycle.managedGroupId === payload.groupId;
		const isExactActiveLocal =
			local?.lifecycleState === 'active' &&
			local.generation === payload.generation &&
			local.access === payload.access &&
			local.readRevision === payload.readRevision &&
			local.managedPolicyId === payload.policyId &&
			local.managedPolicyRevision === payload.policyRevision &&
			local.managedGroupId === payload.groupId;
		const isExactLocalIdentity =
			local?.generation === payload.generation &&
			local.managedPolicyId === payload.policyId &&
			local.managedPolicyRevision === payload.policyRevision &&
			local.managedGroupId === payload.groupId;

		if (isExactActiveLifecycle && !isExactActiveLocal && isExactLocalIdentity) {
			this.context.db
				.update(schema.caches)
				.set({
					access: payload.access,
					readRevision: payload.readRevision,
					lifecycleState: 'active',
					creationExpiresAt: sql`NULL`,
					leaseExpiresAt: payload.leaseExpiresAt,
					selectionState: 'source-active'
				})
				.where(eq(schema.caches.id, local.id))
				.run();
			await finishManagedActivationRepair(this.context, id, 'complete');
			return 'complete';
		}

		if (isExactActiveLifecycle && isExactActiveLocal) {
			await finishManagedActivationRepair(this.context, id, 'complete');
			return 'complete';
		}

		const policy = await this.storedPolicy(payload.policyId);
		const canFinishActivation =
			isExactActiveLocal &&
			lifecycle?.state === 'creating' &&
			lifecycle.generation === payload.generation &&
			lifecycle.managedPolicyId === payload.policyId &&
			lifecycle.managedPolicyRevision === payload.policyRevision &&
			policy?.family.status === 'active' &&
			policy.revision.revision === payload.policyRevision;

		if (canFinishActivation) {
			const activated = await this.context.d1
				.update(d1Schema.cacheLifecycle)
				.set({
					state: 'active',
					access: payload.access,
					readRevision: payload.readRevision,
					creationExpiresAt: sql`NULL`,
					leaseExpiresAt: payload.leaseExpiresAt,
					selectionState: 'source-active',
					updatedAt: isoTimestamp(new Date())
				})
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						identity,
						eq(d1Schema.cacheLifecycle.state, 'creating'),
						eq(d1Schema.cacheLifecycle.generation, payload.generation),
						eq(d1Schema.cacheLifecycle.managedPolicyId, payload.policyId),
						eq(
							d1Schema.cacheLifecycle.managedPolicyRevision,
							payload.policyRevision
						)
					)
				)
				.run();

			if (activated.meta.changes !== 1) {
				throw new ManagedCacheConflictError(scope);
			}

			await finishManagedActivationRepair(this.context, id, 'complete');
			return 'complete';
		}

		if (
			local?.generation === payload.generation &&
			local.lifecycleState === 'active'
		) {
			this.context.db
				.update(schema.caches)
				.set({
					lifecycleState: 'creating',
					creationExpiresAt: payload.creationExpiresAt,
					leaseExpiresAt: sql`NULL`,
					selectionState: 'detached'
				})
				.where(
					and(
						eq(schema.caches.id, local.id),
						eq(schema.caches.generation, payload.generation)
					)
				)
				.run();
		}

		await finishManagedActivationRepair(this.context, id, 'rolled-back');
		return 'rolled-back';
	}

	hasEligibleRetirement(now: Date = new Date()): boolean {
		const timestamp = isoTimestamp(now);

		return (
			this.hasExpiredCreation(timestamp) ||
			this.context.db
				.select({ id: schema.caches.id })
				.from(schema.caches)
				.where(this.retirementCondition(timestamp))
				.limit(1)
				.get() !== undefined
		);
	}

	async hasLifecycleWork(now: Date = new Date()): Promise<boolean> {
		if ((await this.activeGroupAccessTransition()) !== undefined) {
			return true;
		}

		const tenant = this.context.requireTenant();
		const policyUpdate = await this.context.d1
			.select({ id: d1Schema.managedPolicyFamily.id })
			.from(d1Schema.managedPolicyFamily)
			.where(
				and(
					eq(d1Schema.managedPolicyFamily.tenant, tenant),
					inArray(d1Schema.managedPolicyFamily.status, [
						'updating',
						'retiring'
					]),
					isNotNull(d1Schema.managedPolicyFamily.pendingRevision)
				)
			)
			.limit(1)
			.get();

		if (policyUpdate !== undefined) {
			return true;
		}

		if (this.hasEligibleRetirement(now)) {
			return true;
		}

		if ((await this.finalisableFamily()) !== undefined) {
			return true;
		}

		return (
			(await this.context.d1
				.select({ tenant: d1Schema.cacheLifecycle.tenant })
				.from(d1Schema.cacheLifecycle)
				.where(
					and(
						eq(d1Schema.cacheLifecycle.tenant, tenant),
						eq(d1Schema.cacheLifecycle.managementKind, 'managed'),
						eq(d1Schema.cacheLifecycle.state, 'creating'),
						sql`${d1Schema.cacheLifecycle.creationExpiresAt} <= ${isoTimestamp(now)}`
					)
				)
				.limit(1)
				.get()) !== undefined
		);
	}

	async retireEligibleCaches(limit: number): Promise<number> {
		if (await this.advanceGroupAccessTransition(limit)) {
			return 1;
		}

		if (await this.advancePolicyConfigurationUpdate(limit)) {
			return 1;
		}

		if (await this.finaliseRetiringFamily()) {
			return 1;
		}

		const recovered = await this.recoverExpiredCreations(limit);
		const remaining = Math.max(0, limit - recovered);

		if (remaining === 0) {
			return recovered;
		}

		const now = isoTimestamp(new Date());
		const candidates = this.context.db
			.select({
				id: schema.caches.id,
				kind: schema.caches.kind,
				name: schema.caches.name,
				access: schema.caches.access,
				generation: schema.caches.generation,
				readRevision: schema.caches.readRevision
			})
			.from(schema.caches)
			.where(this.retirementCondition(now))
			.limit(remaining)
			.all();
		let retired = recovered;

		for (const row of candidates) {
			const cache = this.context.cacheRepository.resolvedForId(row.id);
			await this.cacheAdmin.tearDownCache(cache, internalOrigin);
			retired += 1;
		}

		return retired;
	}
}

async function activeManagedPolicyForCache(
	context: ServerContext,
	cache: ResolvedCache,
	inactivePolicy: 'reject' | 'skip' = 'reject'
): Promise<
	| {
			readonly local: typeof schema.caches.$inferSelect;
			readonly revision: PolicyRevisionRow;
	  }
	| undefined
> {
	const local = context.db
		.select()
		.from(schema.caches)
		.where(eq(schema.caches.id, cache.id))
		.get();

	if (local?.managementKind !== 'managed') {
		return undefined;
	}

	if (
		local.managedPolicyId === null ||
		local.managedPolicyRevision === null ||
		local.managedGroupId === null ||
		local.lifecycleState !== 'active'
	) {
		throw new ManagedCacheConflictError(cache.scope);
	}

	const tenant = context.requireTenant();
	const lifecycle = await context.d1
		.select({ generation: d1Schema.cacheLifecycle.generation })
		.from(d1Schema.cacheLifecycle)
		.where(
			and(
				eq(d1Schema.cacheLifecycle.tenant, tenant),
				cacheIdentityCondition(
					d1Schema.cacheLifecycle.cacheKind,
					d1Schema.cacheLifecycle.cacheName,
					cache.scope
				),
				eq(d1Schema.cacheLifecycle.generation, local.generation),
				eq(d1Schema.cacheLifecycle.state, 'active'),
				isNull(d1Schema.cacheLifecycle.deletedAt),
				eq(d1Schema.cacheLifecycle.managedPolicyId, local.managedPolicyId),
				eq(
					d1Schema.cacheLifecycle.managedPolicyRevision,
					local.managedPolicyRevision
				),
				eq(d1Schema.cacheLifecycle.managedGroupId, local.managedGroupId)
			)
		)
		.get();

	if (lifecycle === undefined) {
		throw new ManagedCacheConflictError(cache.scope);
	}

	const familyCondition = and(
		eq(d1Schema.managedPolicyFamily.tenant, tenant),
		eq(d1Schema.managedPolicyFamily.id, local.managedPolicyId)
	);
	const family = await context.d1
		.select({
			status: d1Schema.managedPolicyFamily.status,
			currentRevision: d1Schema.managedPolicyFamily.currentRevision
		})
		.from(d1Schema.managedPolicyFamily)
		.where(familyCondition)
		.get();
	const revisionCondition = and(
		eq(d1Schema.managedPolicyRevision.tenant, tenant),
		eq(d1Schema.managedPolicyRevision.policyId, local.managedPolicyId),
		eq(d1Schema.managedPolicyRevision.revision, local.managedPolicyRevision)
	);
	const revisionAndGroup = await context.d1
		.select({
			revision: d1Schema.managedPolicyRevision,
			groupState: d1Schema.managedCacheGroup.state
		})
		.from(d1Schema.managedPolicyRevision)
		.innerJoin(
			d1Schema.managedCacheGroup,
			and(
				eq(
					d1Schema.managedCacheGroup.tenant,
					d1Schema.managedPolicyRevision.tenant
				),
				eq(
					d1Schema.managedCacheGroup.id,
					d1Schema.managedPolicyRevision.groupId
				)
			)
		)
		.where(revisionCondition)
		.get();

	if (
		revisionAndGroup === undefined ||
		family?.currentRevision !== local.managedPolicyRevision
	) {
		throw new ManagedCacheConflictError(cache.scope);
	}

	if (family.status !== 'active' || revisionAndGroup.groupState !== 'active') {
		if (inactivePolicy === 'skip') {
			return undefined;
		}

		throw new ManagedCacheConflictError(cache.scope);
	}

	return { local, revision: revisionAndGroup.revision };
}

export async function assertManagedRootRetention(
	context: ServerContext,
	cache: ResolvedCache,
	request: RootRetentionRequest
): Promise<void> {
	const policy = await activeManagedPolicyForCache(context, cache);

	if (policy === undefined) {
		return;
	}

	const retention: RootRetentionRequest =
		request.kind === 'inherit'
			? policy.revision.defaultRootTtlSeconds === null
				? { kind: 'permanent' }
				: {
						kind: 'duration',
						seconds: ttlSecondsSchema.parse(
							policy.revision.defaultRootTtlSeconds
						)
					}
			: request;

	if (
		retention.kind === 'permanent'
			? policy.revision.allowPermanentRoots
			: retention.seconds <= policy.revision.maximumRootDurationSeconds
	) {
		return;
	}

	throw new ManagedCacheConflictError(cache.scope);
}

export async function assertManagedCacheWritable(
	context: ServerContext,
	cache: ResolvedCache
): Promise<void> {
	await activeManagedPolicyForCache(context, cache);
}

export async function renewManagedCacheLease(
	context: ServerContext,
	cache: ResolvedCache
): Promise<void> {
	const policy = await activeManagedPolicyForCache(context, cache, 'skip');

	if (policy === undefined) {
		return;
	}

	const now = new Date();
	const leaseExpiresAt = isoTimestamp(
		atSeconds(now, policy.revision.activityLeaseSeconds)
	);
	const tenant = context.requireTenant();
	const policyId = managedPolicyIdSchema.parse(policy.local.managedPolicyId);

	const renewed = await context.d1
		.update(d1Schema.cacheLifecycle)
		.set({ leaseExpiresAt, updatedAt: isoTimestamp(now) })
		.where(
			and(
				eq(d1Schema.cacheLifecycle.tenant, tenant),
				cacheIdentityCondition(
					d1Schema.cacheLifecycle.cacheKind,
					d1Schema.cacheLifecycle.cacheName,
					cache.scope
				),
				eq(d1Schema.cacheLifecycle.state, 'active'),
				eq(d1Schema.cacheLifecycle.managedPolicyId, policyId),
				eq(
					d1Schema.cacheLifecycle.managedPolicyRevision,
					policy.revision.revision
				),
				sql`exists (
					select 1 from ${d1Schema.managedPolicyFamily}
					where ${d1Schema.managedPolicyFamily.tenant} = ${tenant}
						and ${d1Schema.managedPolicyFamily.id} = ${policyId}
						and ${d1Schema.managedPolicyFamily.status} = 'active'
						and ${d1Schema.managedPolicyFamily.currentRevision} = ${policy.revision.revision}
				)`,
				sql`exists (
					select 1 from ${d1Schema.managedCacheGroup}
					where ${d1Schema.managedCacheGroup.tenant} = ${tenant}
						and ${d1Schema.managedCacheGroup.id} = ${policy.revision.groupId}
						and ${d1Schema.managedCacheGroup.state} = 'active'
				)`
			)
		)
		.run();

	if (renewed.meta.changes !== 1) {
		return;
	}

	context.db
		.update(schema.caches)
		.set({ leaseExpiresAt })
		.where(
			and(
				eq(schema.caches.id, cache.id),
				eq(schema.caches.lifecycleState, 'active'),
				eq(schema.caches.managedPolicyId, policyId),
				eq(schema.caches.managedPolicyRevision, policy.revision.revision)
			)
		)
		.run();
}
