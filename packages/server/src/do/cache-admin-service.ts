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
	narObjectKey,
	type RequestOrigin,
	requestOriginSchema
} from '../http/http.ts';
import { assertRetentionMigrationSettled } from '../migration/cache-retention.ts';

import { deleteObjects } from './bulk.ts';
import { type CacheRegistrationService } from './cache-registration-service.ts';
import { type ServerContext } from './context.ts';
import {
	type DeletionQueueService,
	maxFencedRetireRows,
	minimumStatementsPerTeardownChunk
} from './deletion-queue-service.ts';
import { jsonValueLists } from './json-list.ts';
import { maintenancePassStatements } from './maintenance-eligibility-service.ts';
import { type ReconcileQueueService } from './reconcile-queue-service.ts';
import { RetentionRuleService } from './retention-rule-service.ts';
// Bound each narinfo retirement pass so large caches release the input gate
// between R2 deletions and D1 edge updates, and so one pass fits the D1
// statements a single Worker invocation may run.

// Once the chunk empties the queue, the pass sweeps for revoked edges.
const revokedEdgeSweepStatementsPerPass = 1;

/**
 * The most paths one pass reads from the teardown queue.
 *
 * This caps the rows read, not the statements executed. The drain can retire
 * the entire page when its paths have no attestation references. Otherwise the
 * remaining D1 allowance can stop it earlier. The calculation reserves one
 * statement for the revoked-edge sweep.
 */
export const maxPathsTornDownPerRun =
	Math.floor(
		(maintenancePassStatements - revokedEdgeSweepStatementsPerPass) /
			minimumStatementsPerTeardownChunk
	) * maxFencedRetireRows;

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
					AND NOT EXISTS (SELECT 1 FROM pending_upload WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM pending_attestation WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM verification_cursor WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM narinfo_deletion WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_scan WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_frontier WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_mark WHERE cache_id = identity.id)
					AND NOT EXISTS (SELECT 1 FROM garbage_collection_tenant_run WHERE cache_id = identity.id)
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
	// The drain sizes its page from the current allowance and keeps one D1
	// statement for the sweep below. The binding enforces the invocation limit if
	// the page estimate drifts.
	//
	// After the queue becomes empty, sweep for reference edges left by an
	// interrupted deletion and queue them for the next pass. Check the queue after
	// the drain because the last full chunk may have emptied it. A missed sweep
	// would leave the storage and tenant charge in place indefinitely.
	private async drainTeardownChunk(
		cache: ResolvedCache,
		origin: RequestOrigin | undefined,
		limit: number
	): Promise<void> {
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

		await this.deletionQueue.retireTornDownNarInfos(cache, queued, origin);

		if (this.hasQueuedDeletions(cache)) {
			return;
		}

		await this.deletionQueue.queueRevokedCacheEdges(cache, limit);
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

		const pending = this.context.db
			.select({
				r2Key: schema.pendingUploads.r2Key,
				narHash: schema.pendingUploads.narHash
			})
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.cacheId, cache.id))
			.all();
		const pendingAttestations = this.context.db
			.select({ r2Key: schema.pendingAttestations.r2Key })
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.cacheId, cache.id))
			.all();

		await deleteObjects(
			this.context.env.BLOBS,
			pending
				.filter((upload) => upload.r2Key !== narObjectKey(upload.narHash))
				.map((upload) => upload.r2Key)
		);
		await deleteObjects(
			this.context.env.BLOBS,
			pendingAttestations.map((upload) => upload.r2Key)
		);

		// Remove every narinfo row in the same transaction that queues its
		// retirement. A later recommit creates a new generation that the queued
		// deletion cannot remove.
		this.context.db.transaction((tx) => {
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
			tx.delete(schema.pendingUploads)
				.where(eq(schema.pendingUploads.cacheId, cache.id))
				.run();
			tx.delete(schema.pendingAttestations)
				.where(eq(schema.pendingAttestations.cacheId, cache.id))
				.run();
			tx.delete(schema.managedCacheRetirements)
				.where(eq(schema.managedCacheRetirements.cacheId, cache.id))
				.run();
		});

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
							eligibleAfter: schema.managedCacheRetirements.eligibleAfter
						})
						.from(schema.managedCacheRetirements)
						.where(inArray(schema.managedCacheRetirements.cacheId, listedIds))
						.all()
				)
				.map((row) => [row.cacheId, row.eligibleAfter])
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
					retirementEligibleAfter: managed.get(row.id)
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
			if (
				configuration.defaultRootRetention.kind === 'duration' ||
				configuration.grace.kind === 'duration'
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
				...(configuration.grace.kind === 'duration' && {
					graceSeconds: configuration.grace.graceSeconds
				})
			});

			return this.cacheSummary(cache);
		});
	}

	async updateCache(
		scope: CacheScope,
		update: CacheUpdateBody
	): Promise<CacheSummary> {
		const cache = this.context.cacheRepository.require(scope);

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
			await this.context.criticalSection(() =>
				this.retentionRules.setRule(
					this.context.cacheRepository.require(scope),
					update.rootPrefix,
					update.retention
				)
			);

			return this.cacheSummary(cache);
		}

		if (update.kind === 'clear-root-ttl-override') {
			await this.context.criticalSection(() =>
				this.retentionRules.removeRule(
					this.context.cacheRepository.require(scope),
					update.rootPrefix
				)
			);

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
			await this.context.phases.refresh();
			const existing = this.context.cacheRepository.require(scope);
			if (
				existing.access !== update.access &&
				!(await this.context.phases.hasReached('contracted'))
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

	setRetireWhenEmpty(
		scope: Extract<CacheScope, { kind: 'named' }>,
		shouldRetireWhenEmpty: boolean
	): Promise<CacheSummary> {
		return this.context.criticalSection(() => {
			const cache = this.context.cacheRepository.require(scope);

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
					.values({ cacheId: cache.id, eligibleAfter })
					.onConflictDoUpdate({
						target: schema.managedCacheRetirements.cacheId,
						set: { eligibleAfter }
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
					lte(schema.managedCacheRetirements.eligibleAfter, now)
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

			if (claim.revocationStarted !== true) {
				if (
					!(await this.isManagedRetirementEligible(
						live,
						isoTimestamp(new Date())
					))
				) {
					await this.context.ctx.storage.delete(key);
					return;
				}

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
			.select({ eligibleAfter: schema.managedCacheRetirements.eligibleAfter })
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
				retirementEligibleAfter: retirement.eligibleAfter
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
				return undefined;
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

		return remaining.size > 0;
	}

	/**
	 * Revokes a cache's read authority, then removes its local state. Bounded
	 * alarm passes run by {@link resumeTeardownPass} retire published state.
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
		limit: number = maxPathsTornDownPerRun
	): Promise<void> {
		await this.context.criticalSection(async () => {
			await this.drainTeardownChunk(cache, origin, limit);

			// The queue, not the marker, decides when teardown is complete. The pass
			// leaves it empty only once the sweep has also found no revoked edge to
			// queue. A concurrent repeated deletion can safely enqueue the same
			// generation again.
			if (!this.hasQueuedDeletions(cache)) {
				await this.context.ctx.storage.delete(this.teardownKey(cache));
			}
		});
	}
}
