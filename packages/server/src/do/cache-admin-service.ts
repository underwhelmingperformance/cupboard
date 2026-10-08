import { rootLogger } from '@cupboard/logger';
import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	cacheGenerationSchema,
	type CacheName,
	cacheNameSchema,
	cachePrioritySchema,
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope
} from '@cupboard/nix-store/scalars';
import {
	type CacheCloseResponse,
	type CacheCreationDefaults,
	type CacheListEntry,
	type CacheListInput,
	cacheListPageSize,
	type CacheListResponse,
	type CachePutBody,
	type CacheRemoveResponse,
	type CacheSummary,
	type CacheUpdateBody
} from '@cupboard/protocol/caches';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	count,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	min,
	sql
} from 'drizzle-orm';
import { z } from 'zod';

import {
	type CacheId,
	cacheIdSchema,
	cacheScopeFromRow,
	type ResolvedCache
} from '../db/cache.ts';
import { type CacheLifecycleVersion } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	CacheAccessMigrationPendingError,
	CacheAlreadyExistsError,
	CacheListingProjectionPendingError,
	CacheNotEmptyError,
	CacheNotFoundError,
	CacheRetirementTtlRequiredError
} from '../errors.ts';
import {
	type RequestOrigin,
	requestOriginSchema,
	stagingPrefix
} from '../http/http.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';

import { drainObjectDeletionPages } from './bulk.ts';
import { CacheClosureService } from './cache-closure-service.ts';
import { CacheCreationDefaultsService } from './cache-creation-defaults-service.ts';
import {
	cacheLifecycleFilter,
	type CacheRegistrationService
} from './cache-registration-service.ts';
import { type ServerContext } from './context.ts';
import {
	type DeletionQueueService,
	maxFencedRetireRows,
	maxNarInfoDeletionsFlushedPerRun,
	narInfoRetirementSubrequests
} from './deletion-queue-service.ts';
import { jsonValueLists } from './json-list.ts';
import { maintenancePassSubrequests } from './maintenance-eligibility-service.ts';
import { concludePromotion } from './promotion-record.ts';
import { type ReconcileQueueService } from './reconcile-queue-service.ts';
import { RetentionRuleService } from './retention-rule-service.ts';
import { isRowBudgetExhausted } from './row-budget.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';
// Once the chunk empties the queue, the pass sweeps for revoked edges.
const revokedEdgeSweepSubrequestsPerPass = 1;
const stagingCleanupSubrequestsPerPass = 1;

/**
 * The most paths one pass reads from the teardown queue.
 *
 * This caps the rows read. The drain can retire the entire page when its paths
 * have no attestation references. Otherwise the remaining subrequests can
 * stop it earlier. The calculation reserves calls for the revoked-edge
 * sweep and, when staging work exists, at least one staging deletion.
 */
export function maxPathsTornDownPerRun(
	subrequestAllowance: number,
	hasStagingCleanup = false
): number {
	return Math.min(
		maxNarInfoDeletionsFlushedPerRun,
		Math.floor(
			(maintenancePassSubrequests(subrequestAllowance) -
				revokedEdgeSweepSubrequestsPerPass -
				(hasStagingCleanup ? stagingCleanupSubrequestsPerPass : 0)) /
				(1 + narInfoRetirementSubrequests(maxFencedRetireRows))
		) * maxFencedRetireRows
	);
}

// Each cache being torn down has its own durable marker because several cache
// deletion queues can be active at once. The complete suffix is the cache name,
// so names containing colons remain unambiguous.
export const teardownEntryPrefix = 'maintenance:teardown:';
const teardownCursorKey = 'maintenance:teardown-cursor';
const teardownMarkerSchema = z.union([
	requestOriginSchema,
	z.object({ origin: requestOriginSchema.optional() })
]);

export const managedRetirementEntryPrefix = 'maintenance:managed-retirement:';
const managedRetirementCursorKey = 'maintenance:managed-retirement-cursor';
const managedRetirementClaimSchema = z.object({
	cacheId: cacheIdSchema,
	scope: cacheScopeSchema,
	generation: cacheGenerationSchema,
	origin: requestOriginSchema.optional(),
	revocationStarted: z.boolean().optional()
});
type ManagedRetirementClaim = z.infer<typeof managedRetirementClaimSchema>;

export class CacheAdminService {
	private readonly retentionRules: RetentionRuleService;

	constructor(
		private readonly context: ServerContext,
		private readonly registration: CacheRegistrationService,
		private readonly deletionQueue: DeletionQueueService,
		private readonly reconcileQueue: Pick<
			ReconcileQueueService,
			'hasPendingForCache'
		>
	) {
		this.retentionRules = new RetentionRuleService(context);
	}

	private teardownKey(cache: ResolvedCache): string {
		return `${teardownEntryPrefix}${String(cache.id)}`;
	}

	private async teardownEntryAfter(
		cursor: string | undefined
	): Promise<[string, unknown] | undefined> {
		const entries = await this.context.ctx.storage.list({
			prefix: teardownEntryPrefix,
			limit: 1,
			...(cursor !== undefined && { startAfter: cursor })
		});
		return entries.entries().next().value;
	}

	private hasQueuedDeletions(cache: ResolvedCache): boolean {
		const row = this.context.db
			.select({ cacheId: schema.narInfoDeletions.cacheId })
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cacheId, cache.id))
			.limit(1)
			.get();

		return row !== undefined;
	}

	private hasStagingCleanup(cache: ResolvedCache): boolean {
		return (
			this.context.db
				.select({ cacheId: schema.stagingCleanup.cacheId })
				.from(schema.stagingCleanup)
				.where(eq(schema.stagingCleanup.cacheId, cache.id))
				.limit(1)
				.get() !== undefined
		);
	}

	private durableTeardownCacheId(): CacheId | undefined {
		return this.context.db
			.select({ cacheId: schema.cacheTeardowns.cacheId })
			.from(schema.cacheTeardowns)
			.orderBy(schema.cacheTeardowns.cacheId)
			.limit(1)
			.get()?.cacheId;
	}

	private async recoverTeardownMarker(): Promise<
		{ cache: ResolvedCache; origin: undefined } | undefined
	> {
		const cacheId = this.durableTeardownCacheId();
		if (cacheId === undefined) {
			return undefined;
		}

		const cache = this.context.cacheRepository.resolvedForId(cacheId);
		await this.context.ctx.storage.put(this.teardownKey(cache), {});
		await this.context.ctx.storage.put(
			teardownCursorKey,
			this.teardownKey(cache)
		);
		return { cache, origin: undefined };
	}

	private drainStagingCleanup(cache: ResolvedCache): Promise<number> {
		return drainObjectDeletionPages(
			this.context.env.BLOBS,
			{
				read: (limit) =>
					this.context.db
						.select({ r2Key: schema.stagingCleanup.r2Key })
						.from(schema.stagingCleanup)
						.where(eq(schema.stagingCleanup.cacheId, cache.id))
						.orderBy(schema.stagingCleanup.r2Key)
						.limit(limit)
						.all()
						.map((entry) => entry.r2Key),
				acknowledge: (keys) => {
					for (const list of jsonValueLists(keys)) {
						this.context.db
							.delete(schema.stagingCleanup)
							.where(
								and(
									eq(schema.stagingCleanup.cacheId, cache.id),
									inArray(schema.stagingCleanup.r2Key, list)
								)
							)
							.run();
					}
				}
			},
			() => !isRowBudgetExhausted()
		);
	}

	private managedRetirementKey(cacheId: CacheId): string {
		return `${managedRetirementEntryPrefix}${String(cacheId)}`;
	}

	private async managedRetirementEntryAfter(
		cursor: string | undefined
	): Promise<[string, unknown] | undefined> {
		const entries = await this.context.ctx.storage.list({
			prefix: managedRetirementEntryPrefix,
			limit: 1,
			...(cursor !== undefined && { startAfter: cursor })
		});

		return entries.entries().next().value;
	}

	private async claimManagedRetirementEntry(): Promise<
		[string, unknown] | undefined
	> {
		let cursor = await this.context.ctx.storage.get<string>(
			managedRetirementCursorKey
		);
		let isWrapped = false;

		for (;;) {
			const entry = await this.managedRetirementEntryAfter(cursor);
			if (entry !== undefined) {
				await this.context.ctx.storage.put(
					managedRetirementCursorKey,
					entry[0]
				);
				return entry;
			}

			if (cursor !== undefined && !isWrapped) {
				cursor = undefined;
				isWrapped = true;
				continue;
			}

			await this.context.ctx.storage.delete(managedRetirementCursorKey);
			return undefined;
		}
	}

	private async isManagedRetirementEligible(
		cache: ResolvedCache,
		now: IsoTimestamp
	): Promise<boolean> {
		const row = this.context.db
			.all<{ id: number }>(
				sql`
				SELECT identity.id
				FROM cache_identity AS identity
				INNER JOIN managed_cache_retirement AS managed
					ON managed.cache_id = identity.id
				WHERE identity.id = ${cache.id}
					AND identity.deleted_at IS NULL
					AND identity.generation = ${cache.generation}
					AND managed.eligible_after <= ${now}
					AND NOT EXISTS (SELECT 1 FROM narinfo WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM retention_root WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM retention_root_target WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM retention_grace WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM cache_close_event WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM pending_upload WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM pending_attestation WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM verification_cursor WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM narinfo_deletion WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_scan WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_frontier WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_mark WHERE cache_id = identity.id)
					AND (managed.retirement_started_at IS NOT NULL
						OR NOT EXISTS (SELECT 1 FROM garbage_collection_tenant_run WHERE cache_id = identity.id))
				LIMIT 1
			`
			)
			.at(0);

		if (row === undefined) {
			return false;
		}

		return !(await this.reconcileQueue.hasPendingForCache(cache.id));
	}

	// The caller holds the input gate. The retirement service applies the
	// generation fence that protects a recommitted path.
	//
	// The drain sizes its page from the current allowance and keeps one D1 call
	// for the sweep below. The bounded binding enforces the slice if the page
	// estimate drifts.
	//
	// After the queue becomes empty, sweep for reference edges left by an
	// interrupted deletion and queue them for the next pass. Check the queue after
	// the drain because the last full chunk may have emptied it. A missed sweep
	// would leave the storage and tenant charge in place indefinitely.
	private async drainTeardownChunk(
		cache: ResolvedCache,
		origin: RequestOrigin | undefined,
		limit: number
	): Promise<boolean> {
		const queued = this.context.db
			.select({
				storePathHash: schema.narInfoDeletions.storePathHash,
				generation: schema.narInfoDeletions.generation,
				narHash: schema.narInfoDeletions.narHash
			})
			.from(schema.narInfoDeletions)
			.where(eq(schema.narInfoDeletions.cacheId, cache.id))
			.limit(limit)
			.all();

		// The cache is going away, so no new generation of its paths needs the
		// queued edges for inheritance.
		await this.deletionQueue.retireTornDownNarInfos(
			cache,
			queued,
			origin,
			false
		);

		if (this.hasQueuedDeletions(cache) || !hasSubrequestsFor(1)) {
			return false;
		}

		await this.deletionQueue.queueRevokedCacheEdges(cache, limit);
		return true;
	}

	// Canonical UTC timestamps sort chronologically as strings.
	private earliestLiveGraceDeadline(
		cache: ResolvedCache
	): IsoTimestamp | undefined {
		const now = isoTimestamp(new Date());
		const row = this.context.db
			.select({ earliest: min(schema.retentionGrace.retainUntil) })
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cacheId, cache.id),
					gt(schema.retentionGrace.retainUntil, now)
				)
			)
			.get();

		return row?.earliest ?? undefined;
	}

	// The previous build keyed the marker by the stored name. Read such a marker
	// back through the identity and rewrite it under the id so a teardown in
	// progress across the deploy finishes. A marker that names no deleted cache
	// has nothing left to retire and is removed.
	private async adoptLegacyTeardownMarker(
		key: string,
		suffix: string,
		origin: string
	): Promise<ResolvedCache | undefined> {
		const name = cacheNameSchema.safeParse(
			suffix.startsWith('private/') ? suffix.slice('private/'.length) : suffix
		);
		const scope: CacheScope | undefined =
			suffix === ''
				? { kind: 'default' }
				: name.success
					? { kind: 'named', name: name.data }
					: undefined;
		const cache =
			scope === undefined
				? undefined
				: this.context.cacheRepository.lastDeleted(scope);
		await this.context.ctx.storage.delete(key);
		if (cache !== undefined) {
			await this.context.ctx.storage.put(this.teardownKey(cache), origin);
		}
		return cache;
	}

	private async tearDownCacheInSection(
		cache: ResolvedCache,
		origin?: RequestOrigin
	): Promise<void> {
		if (this.context.cacheRepository.resolve(cache.scope)?.id !== cache.id) {
			throw new CacheNotFoundError(cache.scope);
		}

		await this.deletionQueue.revokeCacheGenerationAndClearCredential(cache);

		const now = isoTimestamp(new Date());

		// Remove every narinfo row in the same transaction that queues its
		// retirement. A later recommit creates a new generation that the queued
		// deletion cannot remove.
		const removedUploads = this.context.db.transaction((tx) => {
			tx.insert(schema.cacheTeardowns)
				.values({ cacheId: cache.id })
				.onConflictDoNothing()
				.run();
			for (const table of [schema.pendingUploads, schema.pendingAttestations]) {
				tx.run(sql`INSERT INTO staging_cleanup (cache_id, r2_key)
					SELECT cache_id, r2_key FROM ${table}
					WHERE cache_id = ${cache.id}
						AND substr(r2_key, 1, ${stagingPrefix.length}) = ${stagingPrefix}
					ON CONFLICT (cache_id, r2_key) DO NOTHING`);
			}
			tx.run(
				sql`INSERT INTO narinfo_deletion (cache_id, store_path_hash, nar_hash, generation, created_at)
						SELECT cache_id, store_path_hash, nar_hash, generation, ${now}
						FROM narinfo WHERE cache_id = ${cache.id}
						ON CONFLICT (cache_id, store_path_hash, generation)
						DO UPDATE SET nar_hash = excluded.nar_hash, created_at = excluded.created_at`
			);
			tx.delete(schema.narInfos)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
			tx.delete(schema.verificationCursor)
				.where(eq(schema.verificationCursor.cacheId, cache.id))
				.run();
			tx.delete(schema.retentionRootTargets)
				.where(eq(schema.retentionRootTargets.cacheId, cache.id))
				.run();
			tx.delete(schema.retentionRoots)
				.where(eq(schema.retentionRoots.cacheId, cache.id))
				.run();
			// Deleting the cache is the only transition out of grace-managed state;
			// released paths receive no grace deadline.
			tx.delete(schema.retentionGrace)
				.where(eq(schema.retentionGrace.cacheId, cache.id))
				.run();
			tx.update(schema.cacheIdentities)
				.set({ deletedAt: now })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();
			// A policy scoped to the cache would match nothing once the cache is
			// gone, and its `cache_id` would refer to a deleted identity.
			tx.delete(schema.legacyRetentionPolicies)
				.where(eq(schema.legacyRetentionPolicies.cacheId, cache.id))
				.run();
			// Remove in-flight uploads so a later commit cannot recreate the cache.
			const removed = tx
				.delete(schema.pendingUploads)
				.where(eq(schema.pendingUploads.cacheId, cache.id))
				.returning()
				.all();
			tx.delete(schema.pendingAttestations)
				.where(eq(schema.pendingAttestations.cacheId, cache.id))
				.run();
			tx.delete(schema.managedCacheRetirements)
				.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
				.run();
			tx.delete(schema.garbageCollectionTenantRuns)
				.where(eq(schema.garbageCollectionTenantRuns.cacheId, cache.id))
				.run();

			return removed;
		});

		for (const upload of removedUploads) {
			if (upload.verdict === 'pending' || upload.verdict === 'committing') {
				await concludePromotion(this.context.d1, upload, {
					logger: rootLogger(),
					outcome: 'absent'
				});
			}
		}

		await this.context.ctx.storage.put(this.teardownKey(cache), origin ?? {});
		await this.context.ctx.storage.setAlarm(Date.now());
	}

	cacheInfoBody(scope: CacheScope): string {
		const cache = this.context.cacheRepository.require(scope);
		const row = this.context.db
			.select({ priority: schema.cacheIdentities.priority })
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.id, cache.id))
			.get();

		if (row === undefined) {
			throw new CacheNotFoundError(scope);
		}

		const info = new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.hasMassQuery,
			cachePrioritySchema.parse(row.priority)
		);

		return info.render();
	}

	listCaches(input: CacheListInput = {}): CacheListResponse {
		const projection = this.context.db
			.select({
				narinfoComplete: schema.cacheListingProjectionMigration.narinfoComplete,
				graceComplete: schema.cacheListingProjectionMigration.graceComplete
			})
			.from(schema.cacheListingProjectionMigration)
			.where(eq(schema.cacheListingProjectionMigration.id, 1))
			.get();
		if (projection?.narinfoComplete !== true || !projection.graceComplete) {
			throw new CacheListingProjectionPendingError();
		}

		const limit = Math.min(input.limit ?? cacheListPageSize, cacheListPageSize);
		const afterId =
			input.cursor === undefined || input.namePrefix !== undefined
				? undefined
				: cacheIdSchema.parse(Number(input.cursor));
		const afterName =
			input.cursor === undefined || input.namePrefix === undefined
				? undefined
				: cacheNameSchema.parse(input.cursor);
		const namePrefixCondition =
			input.namePrefix === undefined
				? undefined
				: and(
						eq(schema.cacheIdentities.kind, 'named'),
						sql`${schema.cacheIdentities.name} >= ${input.namePrefix}`,
						sql`${schema.cacheIdentities.name} < ${`${input.namePrefix}\u{10FFFF}`}`,
						afterName === undefined
							? undefined
							: sql`${schema.cacheIdentities.name} > ${afterName}`
					);
		const registeredRows = this.context.db
			.select()
			.from(schema.cacheIdentities)
			.where(
				and(
					isNull(schema.cacheIdentities.deletedAt),
					afterId === undefined
						? undefined
						: gt(schema.cacheIdentities.id, afterId),
					namePrefixCondition
				)
			)
			.orderBy(
				asc(
					input.namePrefix === undefined
						? schema.cacheIdentities.id
						: schema.cacheIdentities.name
				)
			)
			.limit(limit + 1)
			.all();
		const registered = registeredRows.slice(0, limit);
		const cacheIds = registered.map((row) => row.id);

		if (cacheIds.length === 0) {
			return { caches: [] };
		}

		const counts = new Map(
			jsonValueLists(cacheIds)
				.flatMap((listedIds) =>
					this.context.db
						.select({
							cacheId: schema.cacheNarInfoCounts.cacheId,
							count: schema.cacheNarInfoCounts.count
						})
						.from(schema.cacheNarInfoCounts)
						.where(inArray(schema.cacheNarInfoCounts.cacheId, listedIds))
						.all()
				)
				.map((row) => [row.cacheId, row.count])
		);
		const managed = new Map(
			jsonValueLists(cacheIds)
				.flatMap((listedIds) =>
					this.context.db
						.select({
							cacheId: schema.managedCacheRetirements.cacheId,
							retirementStartedAt:
								schema.managedCacheRetirements.retirementStartedAt,
							eligibleAfter: schema.managedCacheRetirements.eligibleAfter
						})
						.from(schema.managedCacheRetirements)
						.where(inArray(schema.managedCacheRetirements.cacheId, listedIds))
						.all()
				)
				.map((row) => [row.cacheId, row])
		);
		const now = isoTimestamp(new Date());
		const earliestDeadlines = new Map<CacheId, IsoTimestamp>();
		const deadlineRows = jsonValueLists(cacheIds).flatMap((listedIds) => {
			const earliest = sql<IsoTimestamp | null>`(
				select ${schema.retentionGraceByDeadline.retainUntil}
				from ${schema.retentionGraceByDeadline}
				where ${schema.retentionGraceByDeadline.cacheId} = ${schema.cacheIdentities.id}
					and ${schema.retentionGraceByDeadline.retainUntil} > ${now}
				order by ${schema.retentionGraceByDeadline.retainUntil}
				limit 1
			)`;

			return this.context.db
				.select({ cacheId: schema.cacheIdentities.id, earliest })
				.from(schema.cacheIdentities)
				.where(inArray(schema.cacheIdentities.id, listedIds))
				.all();
		});

		for (const row of deadlineRows) {
			if (row.earliest === null) {
				continue;
			}

			earliestDeadlines.set(row.cacheId, row.earliest);
		}
		const caches = registered.map((row): CacheListEntry => {
			const earliestGraceDeadline = earliestDeadlines.get(row.id);
			const retirementStartedAt =
				managed.get(row.id)?.retirementStartedAt ?? undefined;

			return {
				scope: cacheScopeFromRow({ kind: row.kind, name: row.name }),
				access: row.access,
				priority: cachePrioritySchema.parse(row.priority),
				storePaths: counts.get(row.id) ?? 0,
				defaultRootRetention:
					row.defaultRootTtlSeconds === null
						? { kind: 'permanent' }
						: {
								kind: 'duration',
								seconds: row.defaultRootTtlSeconds
							},
				grace:
					row.graceSeconds === null
						? { kind: 'none' }
						: {
								kind: 'duration',
								graceSeconds: row.graceSeconds
							},
				graceManaged: row.graceManaged,
				...(managed.has(row.id) && {
					retireWhenEmpty: true,
					retirementEligibleAfter: managed.get(row.id)?.eligibleAfter,
					...(retirementStartedAt !== undefined && { retirementStartedAt })
				}),
				...(earliestGraceDeadline !== undefined && {
					earliestGraceDeadline
				})
			};
		});
		const last = registered.at(-1);

		return {
			caches,
			...(registeredRows.length > limit &&
				last !== undefined && {
					cursor:
						input.namePrefix === undefined
							? String(last.id)
							: cacheNameSchema.parse(last.name)
				})
		};
	}

	getCache(scope: CacheScope): CacheSummary {
		const cache = this.context.cacheRepository.require(scope);

		return this.cacheSummary(cache);
	}

	async createCache(
		scope: CacheScope,
		configuration: CachePutBody
	): Promise<CacheSummary> {
		return this.context.criticalSection(async () => {
			const grace = configuration.grace ?? this.creationDefaults().grace;
			if (
				configuration.defaultRootRetention.kind === 'duration' ||
				grace.kind === 'duration'
			) {
				assertRetentionMigrationSettled(this.context.db);
			}

			if (this.context.cacheRepository.resolve(scope) !== undefined) {
				throw new CacheAlreadyExistsError(scope);
			}

			const cache = await this.registration.createInSection(scope, {
				access: configuration.access,
				priority: configuration.priority,
				...(configuration.defaultRootRetention.kind === 'duration' && {
					defaultRootTtlSeconds: configuration.defaultRootRetention.seconds
				}),
				...(grace.kind === 'duration' && {
					graceSeconds: grace.graceSeconds
				})
			});

			return this.cacheSummary(cache);
		});
	}

	creationDefaults(): CacheCreationDefaults {
		return new CacheCreationDefaultsService(this.context).get();
	}

	setCreationDefaults(
		configuration: CacheCreationDefaults
	): Promise<CacheCreationDefaults> {
		return new CacheCreationDefaultsService(this.context).set(configuration);
	}

	async updateCache(
		scope: CacheScope,
		update: CacheUpdateBody
	): Promise<CacheSummary> {
		const cache = this.context.cacheRepository.require(scope);

		if (update.kind !== 'priority' && update.kind !== 'access') {
			new CacheClosureService(this.context).assertWritable(cache);
		}

		if (update.kind !== 'priority' && update.kind !== 'access') {
			assertRetentionMigrationSettled(this.context.db);
		}

		if (update.kind === 'priority') {
			this.context.db
				.update(schema.cacheIdentities)
				.set({ priority: update.priority })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();

			return this.cacheSummary(cache);
		}

		if (update.kind === 'set-default-root-ttl') {
			return this.context.criticalSection(() => {
				const current = this.context.cacheRepository.require(scope);
				new CacheClosureService(this.context).assertWritable(current);
				this.context.db.transaction((tx) => {
					tx.update(schema.cacheIdentities)
						.set({
							defaultRootTtlSeconds:
								update.retention.kind === 'duration'
									? update.retention.seconds
									: sql`NULL`
						})
						.where(eq(schema.cacheIdentities.id, current.id))
						.run();
					if (update.retention.kind === 'permanent') {
						tx.delete(schema.managedCacheRetirements)
							.where(eq(schema.managedCacheRetirements.cacheId, current.id))
							.run();
					}
				});
				return Promise.resolve(this.cacheSummary(current));
			});
		}

		if (update.kind === 'set-root-ttl-override') {
			await this.context.criticalSection(() => {
				const current = this.context.cacheRepository.require(scope);
				new CacheClosureService(this.context).assertWritable(current);
				return this.retentionRules.setRule(
					current,
					update.rootPrefix,
					update.retention
				);
			});

			return this.cacheSummary(cache);
		}

		if (update.kind === 'clear-root-ttl-override') {
			await this.context.criticalSection(() => {
				const current = this.context.cacheRepository.require(scope);
				new CacheClosureService(this.context).assertWritable(current);
				return this.retentionRules.removeRule(current, update.rootPrefix);
			});

			return this.cacheSummary(cache);
		}

		if (update.kind === 'set-grace') {
			this.context.db
				.update(schema.cacheIdentities)
				.set({ graceSeconds: update.graceSeconds })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();

			return this.cacheSummary(cache);
		}

		if (update.kind === 'clear-grace') {
			this.context.db
				.update(schema.cacheIdentities)
				.set({ graceSeconds: sql`NULL` })
				.where(eq(schema.cacheIdentities.id, cache.id))
				.run();

			return this.cacheSummary(cache);
		}

		return this.context.criticalSection(async () => {
			await this.context.transitions.refresh();
			const existing = this.context.cacheRepository.require(scope);
			if (
				existing.access !== update.access &&
				!(await this.context.transitions.hasReached(
					'cache-identity',
					'complete'
				))
			) {
				throw new CacheAccessMigrationPendingError();
			}

			let updated: ResolvedCache;
			let version: CacheLifecycleVersion;

			if (update.access === 'private') {
				version = await this.registration.recordLifecycle({
					scope,
					access: update.access
				});
				updated = this.context.cacheRepository.setAccess(
					existing,
					update.access
				);
			} else {
				updated = this.context.cacheRepository.setAccess(
					existing,
					update.access
				);
				version = await this.registration.recordLifecycle(updated);
				await this.registration.clearReadCredential(updated.scope);
			}

			const cache = this.context.cacheRepository.stampGeneration(
				updated,
				version.generation
			);

			return this.cacheSummary(cache);
		});
	}

	async closeCache(
		scope: Extract<CacheScope, { kind: 'named' }>
	): Promise<CacheCloseResponse> {
		return this.context.criticalSection<CacheCloseResponse>(() => {
			const cache = this.context.cacheRepository.resolve(scope);
			if (cache === undefined) {
				return Promise.resolve({ scope, closed: false });
			}
			assertRetentionMigrationSettled(this.context.db);
			const current = this.context.db
				.select()
				.from(schema.managedCacheRetirements)
				.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
				.get();
			if (
				current?.retirementStartedAt !== null &&
				current?.retirementStartedAt !== undefined
			) {
				return Promise.resolve({
					scope,
					closed: true,
					retirementStartedAt: current.retirementStartedAt
				});
			}
			const closedAt = isoTimestamp(new Date());
			const graceSeconds =
				this.context.db
					.select({ graceSeconds: schema.cacheIdentities.graceSeconds })
					.from(schema.cacheIdentities)
					.where(eq(schema.cacheIdentities.id, cache.id))
					.get()?.graceSeconds ?? 0;
			const graceUntil = isoTimestamp(
				new Date(Date.parse(closedAt) + graceSeconds * 1000)
			);
			this.context.db.transaction((tx) => {
				const updated = tx
					.update(schema.cacheIdentities)
					.set({
						retentionEpoch: sql`${schema.cacheIdentities.retentionEpoch} + 1`,
						graceManaged: true
					})
					.where(eq(schema.cacheIdentities.id, cache.id))
					.returning({ epoch: schema.cacheIdentities.retentionEpoch })
					.get();
				tx.insert(schema.cacheCloseEvents)
					.values({
						cacheId: cache.id,
						epoch: updated.epoch,
						closedAt,
						graceUntil
					})
					.run();
				tx.insert(schema.managedCacheRetirements)
					.values({
						cacheId: cache.id,
						retirementStartedAt: closedAt,
						eligibleAfter: closedAt,
						nextCheckAt: closedAt,
						incarnation: crypto.randomUUID()
					})
					.onConflictDoUpdate({
						target: schema.managedCacheRetirements.cacheId,
						set: {
							retirementStartedAt: closedAt,
							eligibleAfter: closedAt,
							nextCheckAt: closedAt,
							revision: sql`${schema.managedCacheRetirements.revision} + 1`
						}
					})
					.run();
			});
			return Promise.resolve({
				scope,
				closed: true,
				retirementStartedAt: closedAt
			});
		});
	}

	async reopenCache(
		scope: Extract<CacheScope, { kind: 'named' }>
	): Promise<CacheSummary> {
		return this.context.criticalSection(() => {
			const cache = this.context.cacheRepository.require(scope);
			this.context.db
				.delete(schema.managedCacheRetirements)
				.where(
					and(
						eq(schema.managedCacheRetirements.cacheId, cache.id),
						sql`${schema.managedCacheRetirements.retirementStartedAt} IS NOT NULL`
					)
				)
				.run();
			return Promise.resolve(this.cacheSummary(cache));
		});
	}

	setRetireWhenEmpty(
		scope: Extract<CacheScope, { kind: 'named' }>,
		shouldRetireWhenEmpty: boolean
	): Promise<CacheSummary> {
		return this.context.criticalSection(() => {
			const cache = this.context.cacheRepository.require(scope);
			new CacheClosureService(this.context).assertWritable(cache);

			if (shouldRetireWhenEmpty) {
				const configuration = this.context.db
					.select({
						defaultRootTtlSeconds: schema.cacheIdentities.defaultRootTtlSeconds
					})
					.from(schema.cacheIdentities)
					.where(eq(schema.cacheIdentities.id, cache.id))
					.get();
				const ttlSeconds = configuration?.defaultRootTtlSeconds;
				if (ttlSeconds === null || ttlSeconds === undefined) {
					throw new CacheRetirementTtlRequiredError();
				}

				const eligibleAfter = isoTimestamp(
					new Date(Date.now() + ttlSeconds * 1000)
				);
				this.context.db
					.insert(schema.managedCacheRetirements)
					.values({
						cacheId: cache.id,
						eligibleAfter,
						incarnation: crypto.randomUUID(),
						nextCheckAt: eligibleAfter
					})
					.onConflictDoUpdate({
						target: schema.managedCacheRetirements.cacheId,
						set: {
							eligibleAfter,
							nextCheckAt: eligibleAfter,
							revision: sql`${schema.managedCacheRetirements.revision} + 1`
						}
					})
					.run();
			} else {
				this.context.db
					.delete(schema.managedCacheRetirements)
					.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
					.run();
			}

			return Promise.resolve(this.cacheSummary(cache));
		});
	}

	async scheduleManagedRetirement(
		cache: ResolvedCache,
		origin?: RequestOrigin
	): Promise<void> {
		const live = this.context.cacheRepository.resolve(cache.scope);
		if (
			live?.id !== cache.id ||
			live.generation !== cache.generation ||
			!isSameCacheScope(live.scope, cache.scope)
		) {
			return;
		}

		const now = isoTimestamp(new Date());
		const due = this.context.db
			.select({ cacheId: schema.managedCacheRetirements.cacheId })
			.from(schema.managedCacheRetirements)
			.where(
				and(
					eq(schema.managedCacheRetirements.cacheId, cache.id),
					lte(schema.managedCacheRetirements.nextCheckAt, now)
				)
			)
			.get();
		if (due === undefined || this.hasQueuedDeletions(cache)) {
			return;
		}

		const key = this.managedRetirementKey(cache.id);
		const existing = managedRetirementClaimSchema.safeParse(
			await this.context.ctx.storage.get(key)
		);
		const hasCurrentClaim =
			existing.success &&
			existing.data.cacheId === cache.id &&
			existing.data.generation === cache.generation &&
			isSameCacheScope(existing.data.scope, cache.scope);
		if (!hasCurrentClaim) {
			const claim: ManagedRetirementClaim = {
				cacheId: cache.id,
				scope: cache.scope,
				generation: cache.generation,
				...(origin !== undefined && { origin })
			};
			await this.context.ctx.storage.put(key, claim);
		}

		await this.context.ctx.storage.setAlarm(Date.now());
	}

	async hasPendingManagedRetirement(): Promise<boolean> {
		const entries = await this.context.ctx.storage.list({
			prefix: managedRetirementEntryPrefix,
			limit: 1
		});
		if (entries.size > 0) {
			return true;
		}

		await this.context.ctx.storage.delete(managedRetirementCursorKey);
		return false;
	}

	async resumeManagedRetirement(): Promise<void> {
		const entry = await this.claimManagedRetirementEntry();
		if (entry === undefined) {
			return;
		}

		const [key, stored] = entry;
		const parsed = managedRetirementClaimSchema.safeParse(stored);
		if (
			!parsed.success ||
			key !== this.managedRetirementKey(parsed.data.cacheId)
		) {
			await this.context.ctx.storage.delete(key);
			return;
		}

		await this.context.criticalSection(async () => {
			const claim = parsed.data;
			const identity = this.context.db
				.select({
					id: schema.cacheIdentities.id,
					generation: schema.cacheIdentities.generation,
					deletedAt: schema.cacheIdentities.deletedAt
				})
				.from(schema.cacheIdentities)
				.where(eq(schema.cacheIdentities.id, claim.cacheId))
				.get();
			if (identity?.generation !== claim.generation) {
				await this.context.ctx.storage.delete(key);
				return;
			}

			const cache = this.context.cacheRepository.resolvedForId(identity.id);
			if (!isSameCacheScope(cache.scope, claim.scope)) {
				await this.context.ctx.storage.delete(key);
				return;
			}

			if (identity.deletedAt !== null) {
				await this.context.ctx.storage.put(
					this.teardownKey(cache),
					claim.origin ?? {}
				);
				await this.context.ctx.storage.setAlarm(Date.now());
				await this.context.ctx.storage.delete(key);
				return;
			}

			const live = this.context.cacheRepository.resolve(claim.scope);
			if (live?.id !== claim.cacheId || live.generation !== claim.generation) {
				await this.context.ctx.storage.delete(key);
				return;
			}

			const lifecycle =
				claim.revocationStarted === true
					? await this.context.d1
							.select({ deletedAt: d1Schema.cacheLifecycle.deletedAt })
							.from(d1Schema.cacheLifecycle)
							.where(
								cacheLifecycleFilter(this.context.requireTenant(), claim.scope)
							)
							.get()
					: undefined;
			if (
				typeof lifecycle?.deletedAt !== 'string' &&
				!(await this.isManagedRetirementEligible(
					live,
					isoTimestamp(new Date())
				))
			) {
				await this.context.ctx.storage.delete(key);
				return;
			}

			if (claim.revocationStarted !== true) {
				await this.context.ctx.storage.put(key, {
					...claim,
					revocationStarted: true
				} satisfies ManagedRetirementClaim);
			}

			await this.tearDownCacheInSection(live, claim.origin);
			await this.context.ctx.storage.delete(key);
		});
	}

	async removeCache(
		name: CacheName,
		shouldForce: boolean,
		origin: RequestOrigin
	): Promise<CacheRemoveResponse> {
		const scope: CacheScope = { kind: 'named', name };
		return this.context.criticalSection(async () => {
			const cache = this.context.cacheRepository.resolve(scope);
			const committedCount =
				cache === undefined ? 0 : this.cacheStorePathCount(cache);

			if (!shouldForce && committedCount > 0) {
				throw new CacheNotEmptyError(scope);
			}

			if (cache !== undefined) {
				await this.tearDownCacheInSection(cache, origin);
			}

			return {
				scope,
				removed: cache !== undefined,
				storePathsRemoved: committedCount
			};
		});
	}

	cacheStorePathCount(cache: ResolvedCache): number {
		const result = this.context.db
			.select({ count: count() })
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();

		return result?.count ?? 0;
	}

	cacheSummary(cache: ResolvedCache): CacheSummary {
		const row = this.context.db
			.select()
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.id, cache.id))
			.get();

		if (row === undefined) {
			throw new CacheNotFoundError(cache.scope);
		}

		const rootRetentionOverrides = [
			...this.retentionRules.listForRuleSet(row.rootRetentionRuleSetId)
		];
		const earliest = this.earliestLiveGraceDeadline(cache);
		const retirement = this.context.db
			.select({
				eligibleAfter: schema.managedCacheRetirements.eligibleAfter,
				retirementStartedAt: schema.managedCacheRetirements.retirementStartedAt
			})
			.from(schema.managedCacheRetirements)
			.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
			.get();

		return {
			scope: cache.scope,
			access: cache.access,
			priority: cachePrioritySchema.parse(row.priority),
			storePaths: this.cacheStorePathCount(cache),
			defaultRootRetention:
				row.defaultRootTtlSeconds === null
					? { kind: 'permanent' }
					: { kind: 'duration', seconds: row.defaultRootTtlSeconds },
			grace:
				row.graceSeconds === null
					? { kind: 'none' }
					: { kind: 'duration', graceSeconds: row.graceSeconds },
			rootRetentionOverrides,
			graceManaged: row.graceManaged,
			...(retirement !== undefined && {
				retireWhenEmpty: true,
				retirementEligibleAfter: retirement.eligibleAfter,
				...(retirement.retirementStartedAt !== null && {
					retirementStartedAt: retirement.retirementStartedAt
				})
			}),
			...(earliest !== undefined && { earliestGraceDeadline: earliest })
		};
	}

	resolveCache(scope: CacheScope): ResolvedCache | undefined {
		return this.context.cacheRepository.resolve(scope);
	}

	requireCache(scope: CacheScope): ResolvedCache {
		return this.context.cacheRepository.require(scope);
	}

	// Claim one cache marker per alarm so several large teardowns make progress
	// independently.
	async claimTeardown(): Promise<
		{ cache: ResolvedCache; origin: RequestOrigin | undefined } | undefined
	> {
		let cursor = await this.context.ctx.storage.get<string>(teardownCursorKey);
		let isWrapped = false;
		for (;;) {
			const entry = await this.teardownEntryAfter(cursor);

			if (entry === undefined) {
				if (cursor !== undefined && !isWrapped) {
					cursor = undefined;
					isWrapped = true;
					continue;
				}
				await this.context.ctx.storage.delete(teardownCursorKey);
				return this.recoverTeardownMarker();
			}

			const [key, storedMarker] = entry;
			const marker = teardownMarkerSchema.safeParse(storedMarker);
			if (!marker.success) {
				await this.context.ctx.storage.delete(key);
				cursor = key;
				continue;
			}
			const origin =
				typeof marker.data === 'string' ? marker.data : marker.data.origin;
			const suffix = key.slice(teardownEntryPrefix.length);
			const cacheId = cacheIdSchema.safeParse(Number(suffix));
			if (cacheId.success) {
				const cache = this.context.cacheRepository.resolvedForId(cacheId.data);
				await this.context.ctx.storage.put(teardownCursorKey, key);
				return { cache, origin };
			}

			if (origin === undefined) {
				await this.context.ctx.storage.delete(key);
				cursor = key;
				continue;
			}

			const cache = await this.adoptLegacyTeardownMarker(key, suffix, origin);
			if (cache !== undefined) {
				await this.context.ctx.storage.put(
					teardownCursorKey,
					this.teardownKey(cache)
				);
				return { cache, origin };
			}
			cursor = key;
		}
	}

	async hasPendingTeardown(): Promise<boolean> {
		const remaining = await this.context.ctx.storage.list({
			prefix: teardownEntryPrefix,
			limit: 1
		});

		return remaining.size > 0 || this.durableTeardownCacheId() !== undefined;
	}

	/**
	 * Revokes a cache's read authority, then removes its local state. Bounded
	 * alarm passes run by {@link resumeTeardownPass} remove staging objects and
	 * retire published state.
	 *
	 * Revocation advances the generation, records deletion and clears the cache
	 * credential in one D1 transaction. Reads then exclude earlier generations
	 * while cleanup continues.
	 *
	 * The normal path runs two D1 statements in one batch, independently of the
	 * number of committed paths. A missing lifecycle row needs an additional
	 * lookup and insert batch. The teardown marker also starts the sweep for
	 * edges left by an interrupted earlier deletion.
	 *
	 * The deletion queue is durable, so garbage collection can resume it after a
	 * crash before the alarm marker is written. The blob reaper later collects
	 * unreferenced canonical objects.
	 */
	tearDownCache(cache: ResolvedCache, origin: RequestOrigin): Promise<void> {
		return this.context.criticalSection(() =>
			this.tearDownCacheInSection(cache, origin)
		);
	}

	// Retire one more chunk from an alarm. The caller re-arms the alarm while any
	// cache marker remains.
	async resumeTeardownPass(
		cache: ResolvedCache,
		origin: RequestOrigin | undefined,
		limit: number = maxPathsTornDownPerRun(
			this.context.subrequestsPerInvocation,
			this.hasStagingCleanup(cache)
		)
	): Promise<void> {
		await this.context.criticalSection(async () => {
			const hasSweptEdges = await this.drainTeardownChunk(cache, origin, limit);
			await this.drainStagingCleanup(cache);

			// The queue, not the marker, decides when teardown is complete. The pass
			// leaves it empty only once the sweep has also found no revoked edge to
			// queue. A concurrent repeated deletion can safely enqueue the same
			// generation again.
			const hasMoreHistory = new CacheClosureService(this.context).cleanHistory(
				cache,
				limit
			);
			if (
				!hasSweptEdges ||
				hasMoreHistory ||
				this.hasQueuedDeletions(cache) ||
				this.hasStagingCleanup(cache)
			) {
				return;
			}

			await this.context.ctx.storage.delete([
				this.teardownKey(cache),
				this.managedRetirementKey(cache.id)
			]);
			this.context.db
				.delete(schema.cacheTeardowns)
				.where(eq(schema.cacheTeardowns.cacheId, cache.id))
				.run();
		});
	}
}
