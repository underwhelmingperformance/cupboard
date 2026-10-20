import { type Logger } from '@cupboard/logger';
import {
	type RootName,
	storePathBasenameSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	publicationStagingKey,
	publicationStagingPrefix
} from '@cupboard/protocol/publication';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { pushIdSchema, uploadIdSchema } from '@cupboard/protocol/upload';
import { type PushId } from '@cupboard/protocol/upload';
import {
	and,
	asc,
	eq,
	getTableName,
	gt,
	inArray,
	lt,
	lte,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

import { type PushCredentialIssuer } from '../blob/push-credential.ts';
import { wellFormedPushId } from '../blob/push-id.ts';
import { type CacheId, type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import {
	GarbageCollectionBarrierMissingError,
	GarbageCollectionMarksBeforeSeedError,
	PushIdSigningKeyMissingError,
	StoredReferencesInvalidError,
	StoredReferencesJsonMalformedError,
	StoredReferencesNotArrayError,
	TenantNotConfiguredError
} from '../errors.ts';
import {
	narObjectKey,
	type R2ObjectKey,
	r2ObjectKeySchema,
	type RequestOrigin,
	stagingKeyPushSegment,
	stagingPrefix
} from '../http/http.ts';

import { deleteObjects, maxOutgoingConnections } from './bulk.ts';
import { type CacheAdminService } from './cache-admin-service.ts';
import {
	type GarbageCollectionOutcome,
	type GarbageCollectionTarget,
	type SchemaDatabase,
	type ServerContext
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import {
	GarbageCollectionInputs,
	type ScanDecision
} from './garbage-collection-inputs.ts';
import {
	jsonRowLists,
	type JsonValueList,
	jsonValueLists
} from './json-list.ts';
import { type RetentionService } from './retention-service.ts';
import { isRowBudgetExhausted } from './row-budget.ts';

/**
The items one phase step reads before the pass consults its row budget.

The budget decides how much of a backlog one invocation clears. A step
always runs whole, so this decides only by how much a step can overshoot
the budget: a larger step spends fewer statements per item and overshoots
by more.

Do not size a step from the rows the budget has left. A row is not an
item: each phase spends several rows per item it reads, by a factor that
differs per phase, so a step sized that way spends a multiple of the
budget.
*/
export const phaseStepSize = 128;

// The roots one expiry step inspects. A step size like `phaseStepSize`; the
// row budget decides how many steps a pass runs.
export const maxRootsExpiredPerRun = 32;

/**
Reachability comes from retention targets, grace entries and the references
of reachable narinfo rows. Seed queries and expected barrier trigger names
share this list, so adding a seed source also requires its write barrier.
*/
const reachabilitySources = [
	{
		role: 'seed',
		phase: 'roots',
		table: schema.retentionRootTargets,
		cacheId: schema.retentionRootTargets.cacheId,
		storePathHash: schema.retentionRootTargets.storePathHash
	},
	{
		role: 'seed',
		phase: 'grace',
		table: schema.retentionGrace,
		cacheId: schema.retentionGrace.cacheId,
		storePathHash: schema.retentionGrace.storePathHash
	},
	{
		role: 'edge',
		table: schema.narInfos
	}
] as const;

type SeedSource = Extract<
	(typeof reachabilitySources)[number],
	{ role: 'seed' }
>;

// The seed phases of the scan, in the order the scan runs them.
const seedSources: readonly SeedSource[] = reachabilitySources.filter(
	(source): source is SeedSource => source.role === 'seed'
);

const barrierTriggerPrefix = 'garbage_collection_barrier_';

/**
The expected write-barrier triggers and the tables they protect.
*/
export const barrierTriggers: readonly {
	readonly name: string;
	readonly table: string;
}[] = reachabilitySources.flatMap((source) => {
	const table = getTableName(source.table);

	return (['insert', 'update'] as const).map((statement) => ({
		name: `${barrierTriggerPrefix}${table}_${statement}`,
		table
	}));
});

const inputTriggerPrefix = 'garbage_collection_input_';

/**
The triggers that mark the collection inputs of a cache as changed, and
the tables that they watch. Migration 0078 creates them.

While one of them is missing, writes to its table set no flag. A migration
that restores a missing input trigger must therefore also set
`inputs_changed` on every row of `garbage_collection_input`.
*/
export const inputTriggers: readonly {
	readonly name: string;
	readonly table: string;
}[] = (
	[
		['cache_identity', 'insert'],
		['cache_identity', 'grace_managed'],
		['cache_identity', 'undelete'],
		['cache_close_event', 'insert'],
		['narinfo', 'insert'],
		['narinfo', 'update'],
		['narinfo', 'delete'],
		['retention_root_target', 'insert'],
		['retention_root_target', 'update'],
		['retention_root_target', 'delete'],
		['retention_grace', 'insert'],
		['retention_grace', 'update'],
		['retention_grace', 'delete'],
		['pending_upload', 'update'],
		['pending_upload', 'delete']
	] as const
).map(([table, event]) => ({
	name: `${inputTriggerPrefix}${table}_${event}`,
	table
}));

const graceProjectionTriggerPrefix = 'retention_grace_by_deadline_';

/**
The triggers that keep `retention_grace_by_deadline` equal to
`retention_grace`. The skip decision reads grace deadlines from the
projection, and the maintenance wake reads them from `retention_grace`. If
the two disagree, a grace deadline can wake the tenant on every cron without
starting a scan.
*/
export const graceProjectionTriggers: readonly {
	readonly name: string;
	readonly table: string;
}[] = (['insert', 'update', 'delete'] as const).map((event) => ({
	name: `${graceProjectionTriggerPrefix}${event}`,
	table: 'retention_grace'
}));

/**
Every trigger that collection depends on. Without the barrier triggers, a
scan can delete reachable paths. Without the input triggers, a pass can
skip a cache whose inputs have changed.
*/
export const collectionTriggers: readonly {
	readonly name: string;
	readonly table: string;
}[] = [...barrierTriggers, ...inputTriggers, ...graceProjectionTriggers];

/**
Builds one ordered page of targets for roots that have just expired. The
query must include every root from the expiry pass so its ordering and limit
apply to the complete target set. Splitting the roots across queries would
give each subset its own page and could omit targets from the first global
page.

The parameter test imports this builder and inspects the statement it makes.
*/
export function expiredRootTargetSelect(
	database: SchemaDatabase,
	cacheId: CacheId,
	rootNames: JsonValueList<RootName>,
	limit: number
) {
	return database
		.select({
			rootName: schema.retentionRootTargets.rootName,
			storePathHash: schema.retentionRootTargets.storePathHash
		})
		.from(schema.retentionRootTargets)
		.where(
			and(
				eq(schema.retentionRootTargets.cacheId, cacheId),
				inArray(schema.retentionRootTargets.rootName, rootNames)
			)
		)
		.orderBy(
			asc(schema.retentionRootTargets.rootName),
			asc(schema.retentionRootTargets.storePathHash)
		)
		.limit(limit + 1);
}

// Delete at most one R2 batch from each pending table. Deleted rows disappear
// from the next indexed expiry query, so the existing alarm continuation drains
// the remainder without a separate cursor.
export const maxPendingRowsDeletedPerRun = 1000;

interface UnreachableCollection {
	readonly rootsExpired: number;
	readonly rootTargetsExpired: number;
	readonly pathsCollected: number;
	readonly hasMoreExpiredRoots: boolean;
	readonly hasMoreWork: boolean;
}

interface ExpiredRowCollection {
	readonly pendingUploadsDeleted: number;
	readonly pendingAttestationsDeleted: number;
	readonly hasMorePendingRows: boolean;
	readonly hasMoreWork: boolean;
	readonly stagingKeys: readonly R2ObjectKey[];
}

interface VisitedCache {
	readonly cache: ResolvedCache;
	readonly retirementRecheck?: {
		readonly incarnation: string;
		readonly revision: number;
	};
	readonly rootsExpired: number;
	readonly pathsCollected: number;
	readonly hasMoreExpiredRoots: boolean;
	readonly wasScanned: boolean;
	// Whether the scan of this cache, or the cleaning of its close history, has
	// more work.
	readonly hasMoreScanWork: boolean;
	// Whether this pass completed a scan of the cache and no write changed its
	// inputs during the scan, or the cache needs no scan.
	readonly isGraphCurrent: boolean;
	// When the minimum interval allows a scan that the cache needs.
	readonly scanAllowedAt?: IsoTimestamp;
}

interface ReachabilityCollection {
	// The caches that the pass looked at, in order, scanned or not.
	readonly visited: readonly VisitedCache[];
	// Whether the target has more work: a scan in progress, or a later cache
	// of a tenant-wide collection.
	readonly hasMoreWork: boolean;
}

interface ExpiredRefreshFamilyCollection {
	readonly familiesDeleted: number;
	readonly hasMoreWork: boolean;
	readonly membersDeleted: number;
}

// An upload credential can write any key below `staging/<pushId>/`, including
// keys without pending rows. Preserve young objects because their row may not
// exist in the snapshot yet. Pending-row reaping owns tracked keys, and the R2
// lifecycle rule removes anything this bounded orphan scan does not reach.
const orphanStagingGraceMs = 15 * 60 * 1000;

// R2 limits one list page to 1,000 keys.
const orphanListPageSize = 1000;

// Bound each orphan scan. Later collections and the R2 lifecycle rule remove
// any remaining objects.
const maxOrphanReclaim = 1000;

// R2 listing itself consumes a subrequest even when every object is tracked or
// too young to reclaim. Stop before one maintenance pass can scan an unbounded
// staging namespace; later passes and the lifecycle rule provide recovery.
export const maxOrphanListPages = maxOutgoingConnections;

const orphanStagingResumeStorageKey = 'maintenance:orphan-staging-resume-key';

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

interface StagingCollectionBudget {
	pages: number;
	keys: number;
}
interface OrphanStagingScan {
	readonly keys: R2ObjectKey[];
	// Undefined when the scan reached the end of the prefix, so the next scan
	// starts again from the beginning.
	readonly resumeAfter: string | undefined;
	readonly wasCapped: boolean;
}

// Every tenant lists the same `staging/` prefix, and a staging key does not
// contain the tenant. Only the push ID's HMAC shows which tenant staged the
// object, so this tenant deletes only keys under its own push IDs. Expiry
// does not matter: an expired push ID still belongs to its tenant.
class StagingKeyOwnership {
	private issuer: PushCredentialIssuer | undefined;
	private readonly owned = new Map<PushId, Promise<boolean>>();

	constructor(private readonly resolveIssuer: () => PushCredentialIssuer) {}

	isOwn(key: string): Promise<boolean> {
		const segment = stagingKeyPushSegment(key);
		const pushId =
			segment === undefined ? undefined : wellFormedPushId(segment);

		if (pushId === undefined) {
			return Promise.resolve(false);
		}

		const known = this.owned.get(pushId);

		if (known !== undefined) {
			return known;
		}

		this.issuer ??= this.resolveIssuer();
		const owned = this.issuer.isIssuedToTenant(pushId);
		this.owned.set(pushId, owned);

		return owned;
	}
}

import { CacheClosureService } from './cache-closure-service.ts';

export class GarbageCollectionService {
	private readonly inputs: GarbageCollectionInputs;

	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService,
		private readonly retention: RetentionService,
		private readonly cacheAdmin: Pick<
			CacheAdminService,
			'scheduleManagedRetirement'
		>
	) {
		this.inputs = new GarbageCollectionInputs(context);
	}

	private clearScan(cache: ResolvedCache): void {
		this.context.db.transaction((tx) => {
			tx.delete(schema.garbageCollectionFrontier)
				.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
				.run();
			tx.delete(schema.garbageCollectionMarks)
				.where(eq(schema.garbageCollectionMarks.cacheId, cache.id))
				.run();
			tx.delete(schema.garbageCollectionScans)
				.where(eq(schema.garbageCollectionScans.cacheId, cache.id))
				.run();
		});
	}

	private startScan(cache: ResolvedCache): void {
		this.context.db
			.insert(schema.garbageCollectionScans)
			.values({
				cacheId: cache.id,
				phase: 'expire-roots',
				cursor: '',
				referenceCursor: -1,
				allowEmptyCollection: false
			})
			.run();
	}

	private scanRow(
		cache: ResolvedCache
	): typeof schema.garbageCollectionScans.$inferSelect | undefined {
		return this.context.db
			.select()
			.from(schema.garbageCollectionScans)
			.where(eq(schema.garbageCollectionScans.cacheId, cache.id))
			.get();
	}

	private scan(
		cache: ResolvedCache
	): typeof schema.garbageCollectionScans.$inferSelect {
		const stored = this.scanRow(cache);

		if (stored !== undefined) {
			return stored;
		}

		this.startScan(cache);
		const started = this.scanRow(cache);

		if (started === undefined) {
			throw new Error('garbage-collection scan did not persist');
		}

		return started;
	}

	private updateScan(
		cache: ResolvedCache,
		set: Partial<
			Pick<
				typeof schema.garbageCollectionScans.$inferInsert,
				'phase' | 'cursor' | 'referenceCursor' | 'allowEmptyCollection'
			>
		> & {
			readonly markStorePathHash?: StorePathHash | SQL;
		}
	): void {
		this.context.db
			.update(schema.garbageCollectionScans)
			.set(set)
			.where(eq(schema.garbageCollectionScans.cacheId, cache.id))
			.run();
	}

	private expireRoots(
		cache: ResolvedCache,
		now: IsoTimestamp
	): {
		rootsExpired: number;
		rootsInspected: number;
		rootTargetsExpired: number;
		hasMoreExpiredRoots: boolean;
	} {
		const rootPage = maxRootsExpiredPerRun;
		const closure = new CacheClosureService(this.context);
		const hasMoreClosedRoots = closure.materialiseRoots(cache, rootPage);

		// Expire roots even when no unreachable path is collected. Permanent roots
		// have a null expiry and cannot match this query.
		//
		const expiredRootCandidates = this.context.db
			.select({
				name: schema.retentionRoots.name,
				expiresAt: schema.retentionRoots.expiresAt,
				closeGraceUntil: schema.retentionRoots.closeGraceUntil,
				retentionEpoch: schema.retentionRoots.retentionEpoch
			})
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cacheId, cache.id),
					lte(schema.retentionRoots.expiresAt, now)
				)
			)
			.orderBy(
				asc(schema.retentionRoots.expiresAt),
				asc(schema.retentionRoots.name)
			)
			.limit(rootPage + 1)
			.all();
		const expiredRoots = expiredRootCandidates.slice(0, rootPage);
		const expiredRootNames = expiredRoots.map((root) => root.name);
		const expiryByRoot = new Map(
			expiredRoots.flatMap((root) =>
				root.expiresAt === null ? [] : [[root.name, root.expiresAt] as const]
			)
		);

		const closeGraceByRoot = new Map(
			expiredRoots.flatMap((root) =>
				root.closeGraceUntil === null
					? []
					: [
							[
								root.name,
								{
									retentionEpoch: root.retentionEpoch,
									retainUntil: root.closeGraceUntil
								}
							] as const
						]
			)
		);
		const targetPage = phaseStepSize;

		// Anchor each target's grace period to the root's recorded expiry. Using the
		// collection time would extend retention whenever collection runs late.
		const expiredRootTargetCandidates = jsonValueLists(
			expiredRootNames
		).flatMap((names) =>
			expiredRootTargetSelect(
				this.context.db,
				cache.id,
				names,
				targetPage
			).all()
		);
		const expiredRootTargets = expiredRootTargetCandidates.slice(0, targetPage);
		let rootsExpired = 0;

		this.context.db.transaction((tx) => {
			// Add the grace deadline and remove the root target atomically. A crash
			// between separate operations could leave the path with no retention source.
			// A collection pass sweeps every cache, so the cache comes from stored
			// state rather than from the request.
			this.retention.applyGraceTransitions(
				cache,
				expiredRootTargets.flatMap((target) => {
					if (closeGraceByRoot.has(target.rootName)) {
						return [];
					}
					const anchorIso = expiryByRoot.get(target.rootName);

					return anchorIso === undefined
						? []
						: { storePathHash: target.storePathHash, anchorIso };
				}),
				tx
			);

			for (const target of expiredRootTargets) {
				const deadline = closeGraceByRoot.get(target.rootName);
				if (deadline !== undefined) {
					this.retention.extendClosedRootGraceDeadlines(
						cache,
						[target.storePathHash],
						deadline,
						tx
					);
				}
			}
			for (const targets of jsonRowLists(expiredRootTargets)) {
				tx.delete(schema.retentionRootTargets)
					.where(
						and(
							eq(schema.retentionRootTargets.cacheId, cache.id),
							targets.matches({
								rootName: schema.retentionRootTargets.rootName,
								storePathHash: schema.retentionRootTargets.storePathHash
							})
						)
					)
					.run();
			}

			if (expiredRootNames.length === 0) {
				return;
			}

			const remainingRoots = new Set<RootName>();

			for (const rootName of expiredRootNames) {
				const remaining = tx
					.select({ storePathHash: schema.retentionRootTargets.storePathHash })
					.from(schema.retentionRootTargets)
					.where(
						and(
							eq(schema.retentionRootTargets.cacheId, cache.id),
							eq(schema.retentionRootTargets.rootName, rootName)
						)
					)
					.limit(1)
					.get();

				if (remaining !== undefined) {
					remainingRoots.add(rootName);
				}
			}
			const completedRoots = expiredRootNames.filter(
				(rootName) => !remainingRoots.has(rootName)
			);

			for (const names of jsonValueLists(completedRoots)) {
				tx.delete(schema.retentionRoots)
					.where(
						and(
							eq(schema.retentionRoots.cacheId, cache.id),
							inArray(schema.retentionRoots.name, names)
						)
					)
					.run();
			}

			rootsExpired = completedRoots.length;
		});

		// An event on a page that the cursor has passed can lose its last root
		// in this step.
		if (rootsExpired > 0) {
			closure.restartHistory(cache);
		}

		const hasMoreHistory = closure.cleanHistory(cache, rootPage);
		const hasMoreExpiredRoots =
			hasMoreClosedRoots ||
			hasMoreHistory ||
			expiredRootCandidates.length > expiredRoots.length ||
			expiredRoots.length > rootsExpired;

		return {
			rootsExpired,
			rootsInspected: expiredRoots.length,
			rootTargetsExpired: expiredRootTargets.length,
			hasMoreExpiredRoots
		};
	}

	private insertFrontier(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): void {
		for (const hashes of jsonValueLists(storePathHashes)) {
			this.context.db
				.insert(schema.garbageCollectionFrontier)
				.select(hashes.insertSource([sql`${cache.id}`, hashes.element()]))
				.onConflictDoNothing()
				.run();
		}
	}

	// Several roots can retain the same path. Select distinct hashes so each
	// path consumes only one place in the frontier page.
	private advanceSeed(
		cache: ResolvedCache,
		source: SeedSource,
		cursor: string
	): void {
		const page = phaseStepSize;
		const rows = this.context.db
			.selectDistinct({ storePathHash: source.storePathHash })
			.from(source.table)
			.where(
				and(
					eq(source.cacheId, cache.id),
					sql`${source.storePathHash} > ${cursor}`
				)
			)
			.orderBy(asc(source.storePathHash))
			.limit(page + 1)
			.all();
		const batch = rows.slice(0, page);

		this.insertFrontier(
			cache,
			batch.map((row) => row.storePathHash)
		);

		if (rows.length > batch.length) {
			this.updateScan(cache, {
				cursor: batch.at(-1)?.storePathHash ?? cursor
			});

			return;
		}

		const next = seedSources[seedSources.indexOf(source) + 1];

		this.updateScan(cache, { phase: next?.phase ?? 'mark', cursor: '' });
	}

	private existingMarks(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[]
	): ReadonlySet<StorePathHash> {
		const marks = new Set<StorePathHash>();

		for (const hashes of jsonValueLists(storePathHashes)) {
			const rows = this.context.db
				.select({ storePathHash: schema.garbageCollectionMarks.storePathHash })
				.from(schema.garbageCollectionMarks)
				.where(
					and(
						eq(schema.garbageCollectionMarks.cacheId, cache.id),
						inArray(schema.garbageCollectionMarks.storePathHash, hashes)
					)
				)
				.all();

			for (const row of rows) {
				marks.add(row.storePathHash);
			}
		}

		return marks;
	}

	private referenceHash(
		storePathHash: StorePathHash,
		reference: unknown
	): StorePathHash {
		try {
			const basename = storePathBasenameSchema.parse(reference);
			const separator = basename.indexOf('-');

			return storePathHashSchema.parse(basename.slice(0, separator));
		} catch (error) {
			throw new StoredReferencesInvalidError(
				storePathHash,
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	private validateReferencesContainer(
		cache: ResolvedCache,
		storePathHash: StorePathHash
	): void {
		const shape = this.context.db
			.select({
				referencesValid: sql<number>`json_valid(${schema.narInfos.referencesJson})`,
				referencesType: sql<string | null>`CASE
					WHEN json_valid(${schema.narInfos.referencesJson})
					THEN json_type(${schema.narInfos.referencesJson})
				END`
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (
			shape === undefined ||
			(shape.referencesValid === 1 && shape.referencesType === 'array')
		) {
			return;
		}

		if (shape.referencesValid !== 1) {
			throw new StoredReferencesJsonMalformedError(storePathHash);
		}

		throw new StoredReferencesNotArrayError(storePathHash);
	}

	/**
	Walks the frontier until the budget is spent or the mark completes.

	Each iteration is one step: it pops a path from the frontier and marks it,
	or it walks a step of one path's references. The budget is consulted after
	a step, so the first one always runs.

	The path being walked and the reference cursor are kept in local
	variables. Nothing else writes the scan row while the pass runs, so they
	stay equal to what the row holds.
	*/
	private advanceMark(
		cache: ResolvedCache,
		scan: typeof schema.garbageCollectionScans.$inferSelect
	): { readonly complete: boolean } {
		let pending = scan.markStorePathHash ?? undefined;
		let referenceCursor = scan.referenceCursor;

		for (;;) {
			let storePathHash: StorePathHash;

			if (pending === undefined) {
				const frontier = this.context.db
					.select({
						storePathHash: schema.garbageCollectionFrontier.storePathHash
					})
					.from(schema.garbageCollectionFrontier)
					.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
					.orderBy(asc(schema.garbageCollectionFrontier.storePathHash))
					.limit(1)
					.get();

				if (frontier === undefined) {
					return { complete: this.finishMark(cache, scan) };
				}

				const row = this.context.db
					.select({ storePathHash: schema.narInfos.storePathHash })
					.from(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							eq(schema.narInfos.storePathHash, frontier.storePathHash)
						)
					)
					.get();

				this.context.db.transaction((tx) => {
					tx.delete(schema.garbageCollectionFrontier)
						.where(
							and(
								eq(schema.garbageCollectionFrontier.cacheId, cache.id),
								eq(
									schema.garbageCollectionFrontier.storePathHash,
									frontier.storePathHash
								)
							)
						)
						.run();
					tx.insert(schema.garbageCollectionMarks)
						.values({
							cacheId: cache.id,
							storePathHash: frontier.storePathHash
						})
						.onConflictDoNothing()
						.run();

					if (row !== undefined) {
						tx.update(schema.garbageCollectionScans)
							.set({
								markStorePathHash: row.storePathHash,
								referenceCursor: -1
							})
							.where(eq(schema.garbageCollectionScans.cacheId, cache.id))
							.run();
					}
				});

				if (row === undefined) {
					if (isRowBudgetExhausted()) {
						return { complete: false };
					}

					continue;
				}

				storePathHash = row.storePathHash;
				referenceCursor = -1;

				if (isRowBudgetExhausted()) {
					return { complete: false };
				}
			} else {
				storePathHash = pending;
			}

			this.validateReferencesContainer(cache, storePathHash);

			const page = phaseStepSize;

			// A new reference source also needs barrier triggers. Otherwise writes
			// to it after marking could make paths reachable without re-queuing them.
			const references = this.context.db.all<{
				referenceIndex: number;
				reference: unknown;
			}>(sql`
				SELECT CAST(json_each.key AS INTEGER) AS referenceIndex,
				       json_each.value AS reference
				FROM ${schema.narInfos}, json_each(${schema.narInfos.referencesJson})
				WHERE ${schema.narInfos.cacheId} = ${cache.id}
				  AND ${schema.narInfos.storePathHash} = ${storePathHash}
				  AND CAST(json_each.key AS INTEGER) > ${referenceCursor}
				ORDER BY CAST(json_each.key AS INTEGER)
				LIMIT ${page + 1}
			`);
			const batch = references.slice(0, page);
			const hashes = batch.map(({ reference }) =>
				this.referenceHash(storePathHash, reference)
			);
			const marked = this.existingMarks(cache, hashes);

			this.insertFrontier(
				cache,
				hashes.filter((hash) => hash !== storePathHash && !marked.has(hash))
			);

			if (references.length > batch.length) {
				this.updateScan(cache, {
					referenceCursor: batch.at(-1)?.referenceIndex ?? referenceCursor
				});

				return { complete: false };
			}

			this.updateScan(cache, {
				markStorePathHash: sql`null`,
				referenceCursor: -1
			});
			pending = undefined;
			referenceCursor = -1;

			if (isRowBudgetExhausted()) {
				return { complete: false };
			}
		}
	}

	private hasRetainedPath(cache: ResolvedCache): boolean {
		return (
			this.context.db
				.select({ one: sql`1` })
				.from(schema.narInfos)
				.innerJoin(
					schema.garbageCollectionMarks,
					and(
						eq(schema.garbageCollectionMarks.cacheId, schema.narInfos.cacheId),
						eq(
							schema.garbageCollectionMarks.storePathHash,
							schema.narInfos.storePathHash
						)
					)
				)
				.where(eq(schema.narInfos.cacheId, cache.id))
				.limit(1)
				.get() !== undefined
		);
	}

	/**
	An empty cursor means collection has not started. Preserve a non-empty
	cursor when returning from marking so collection resumes after the last
	scanned hash and does not repeat the empty-cache guard.
	*/
	private finishMark(
		cache: ResolvedCache,
		scan: typeof schema.garbageCollectionScans.$inferSelect
	): boolean {
		if (
			scan.cursor === '' &&
			!scan.allowEmptyCollection &&
			!this.hasRetainedPath(cache)
		) {
			this.clearScan(cache);
			return true;
		}

		this.updateScan(cache, { phase: 'collect' });
		return false;
	}

	private hasQueuedPaths(cache: ResolvedCache): boolean {
		return (
			this.context.db
				.select({ one: sql`1` })
				.from(schema.garbageCollectionFrontier)
				.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
				.limit(1)
				.get() !== undefined
		);
	}

	// A mark for the narinfo row considered by the outer query.
	private markedPath(cache: ResolvedCache) {
		return this.context.db
			.select({ one: sql`1` })
			.from(schema.garbageCollectionMarks)
			.where(
				and(
					eq(schema.garbageCollectionMarks.cacheId, cache.id),
					eq(
						schema.garbageCollectionMarks.storePathHash,
						schema.narInfos.storePathHash
					)
				)
			);
	}

	/**
	An upload still in flight for the path the outer statement is looking at.

	`pending` and `committing` are live commit states: verification may still
	settle them, so a path with such an upload is not collectable.

	`pending_upload_gc_path_idx` covers `(cache, json_extract(metadata_json,
	'$.storePathHash'), verdict)`. Migration 0032 creates it and `schema.ts`
	does not declare it, so Drizzle gives no warning when this predicate stops
	matching the index expression.
	*/
	private inFlightUpload(cache: ResolvedCache) {
		const reservedVerdict = or(
			eq(schema.pendingUploads.verdict, 'committing'),
			eq(schema.pendingUploads.verdict, 'pending')
		);
		const uploadPath = sql`json_extract(${schema.pendingUploads.metadataJson}, '$.storePathHash')`;

		return this.context.db
			.select({ one: sql`1` })
			.from(schema.pendingUploads)
			.where(
				and(
					eq(schema.pendingUploads.cacheId, cache.id),
					reservedVerdict,
					eq(uploadPath, schema.narInfos.storePathHash)
				)
			);
	}

	/**
	Collects the unreachable paths of one step.

	The step reads a page and deletes from that page. A delete that searched
	for collectable paths itself would scan past every marked path until it
	found its limit, however far that is.
	*/
	private advanceCollect(
		cache: ResolvedCache,
		now: IsoTimestamp,
		cursor: string
	): {
		readonly pathsCollected: number;
		readonly complete: boolean;
	} {
		const page = phaseStepSize;
		const rows = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, cache.id),
					sql`${schema.narInfos.storePathHash} > ${cursor}`
				)
			)
			.orderBy(asc(schema.narInfos.storePathHash))
			.limit(page + 1)
			.all();
		const batch = rows.slice(0, page);
		let pathsCollected = 0;

		for (const paths of jsonRowLists(batch)) {
			const unmarked = notExists(this.markedPath(cache));
			const settled = notExists(this.inFlightUpload(cache));
			// Unprocessed frontier rows can reference a candidate for deletion.
			// Keep this condition even if the caller changes the phase order.
			const markIsCurrent = notExists(
				this.context.db
					.select({ one: sql`1` })
					.from(schema.garbageCollectionFrontier)
					.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
			);

			// Queue exactly the paths the delete removed, so a path kept by the mark
			// or by an upload in flight is never queued for deletion.
			this.context.db.transaction((tx) => {
				const collected = tx
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cacheId, cache.id),
							paths.matches({
								storePathHash: schema.narInfos.storePathHash,
								generation: schema.narInfos.generation
							}),
							unmarked,
							settled,
							markIsCurrent
						)
					)
					.returning({
						storePathHash: schema.narInfos.storePathHash,
						narHash: schema.narInfos.narHash,
						generation: schema.narInfos.generation
					})
					.all();

				this.deletionQueue.enqueueNarInfoDeletions(tx, cache, collected, now);
				pathsCollected += collected.length;
			});
		}

		if (rows.length > batch.length) {
			this.updateScan(cache, {
				cursor: batch.at(-1)?.storePathHash ?? cursor
			});
		} else {
			this.clearScan(cache);
		}

		return { pathsCollected, complete: rows.length <= batch.length };
	}

	// Deletes one step of the grace deadlines that have passed and reports
	// whether any remain.
	private expireGraceStep(
		cache: ResolvedCache,
		now: IsoTimestamp
	): { readonly hasMoreDeadlines: boolean } {
		const page = phaseStepSize;
		const due = this.context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cacheId, cache.id),
					lte(schema.retentionGrace.retainUntil, now)
				)
			)
			.orderBy(asc(schema.retentionGrace.storePathHash))
			.limit(page);
		const expired = this.context.db
			.delete(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cacheId, cache.id),
					inArray(schema.retentionGrace.storePathHash, due)
				)
			)
			.returning({ storePathHash: schema.retentionGrace.storePathHash })
			.all();

		if (expired.length < page) {
			return { hasMoreDeadlines: false };
		}

		const remaining = this.context.db
			.select({ one: sql`1` })
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cacheId, cache.id),
					lte(schema.retentionGrace.retainUntil, now)
				)
			)
			.limit(1)
			.get();

		return { hasMoreDeadlines: remaining !== undefined };
	}

	/**
	SQLite drops a table's triggers when a migration rebuilds it. Do not
	collect against marks, or decide that a cache needs no scan, until every
	collection trigger is restored.
	*/
	private assertTriggersPresent(): void {
		const present = new Set(
			this.context.db
				.all<{ name: string }>(
					sql`SELECT name FROM sqlite_master
					    WHERE type = 'trigger'
					      AND (name GLOB ${`${barrierTriggerPrefix}*`}
					        OR name GLOB ${`${inputTriggerPrefix}*`}
					        OR name GLOB ${`${graceProjectionTriggerPrefix}*`})`
				)
				.map((row) => row.name)
		);
		const missing = collectionTriggers
			.map((trigger) => trigger.name)
			.filter((name) => !present.has(name));

		if (missing.length > 0) {
			throw new GarbageCollectionBarrierMissingError(missing);
		}
	}

	/**
	Advances the collection scan of one cache. Clears the input flag of the
	cache when a new scan starts and after the scan's own writes.
	
	This method must stay synchronous. No request can write while it runs, so
	every write to an input table during the call is the scan's own, which the
	scan already accounts for. The explicit return type makes an `async`
	version fail to compile.
	*/
	private collectUnreachable(
		cache: ResolvedCache,
		now: IsoTimestamp
	): UnreachableCollection {
		const isStartingScan = this.scanRow(cache) === undefined;
		const scan = this.scan(cache);

		// A pass that skipped the cache can leave the close-history cursor in
		// the middle of the events. The scan's root expiry must read the events
		// from the first one, or it misses an event that a removed root needed.
		if (isStartingScan) {
			this.inputs.clearChanged(cache);
			new CacheClosureService(this.context).restartHistory(cache);
		}

		const isClearOnEntry =
			isStartingScan || this.inputs.state(cache)?.inputsChanged === false;
		const advanced = this.advanceScan(cache, now, scan);
		const hasMoreWork = this.scanRow(cache) !== undefined;

		if (isClearOnEntry && this.inputs.state(cache)?.inputsChanged === true) {
			this.inputs.clearChanged(cache);
		}

		if (!hasMoreWork) {
			this.inputs.recordCompletion(cache, now);
		}

		return { ...advanced, hasMoreWork };
	}

	/**
	Advances one cache's collection scan until the invocation's row budget is
	spent, leaving the phase it stopped in recorded for the next invocation.
	
	The phases draw on one budget in sequence, so an expensive early phase can
	leave a later one nothing to spend. That does not starve the later phase,
	because the input of each phase drains within a scan: a root expires once,
	a grace row is deleted as it is processed, the seed set is fixed when the
	scan starts, the mark frontier shrinks as paths are marked, and a collected
	path is deleted. The expensive phase is therefore cheap on the next
	invocation, which follows immediately because the pass re-arms its alarm
	while work remains.
	*/
	private advanceScan(
		cache: ResolvedCache,
		now: IsoTimestamp,
		started: typeof schema.garbageCollectionScans.$inferSelect
	): Omit<UnreachableCollection, 'hasMoreWork'> {
		let rootsExpired = 0;
		let rootTargetsExpired = 0;
		let pathsCollected = 0;
		let hasMoreExpiredRoots = false;
		let scan: typeof schema.garbageCollectionScans.$inferSelect | undefined =
			started;

		while (scan !== undefined) {
			if (scan.phase === 'expire-roots') {
				const expired = this.expireRoots(cache, now);
				rootsExpired += expired.rootsExpired;
				rootTargetsExpired += expired.rootTargetsExpired;
				// Report what the last step saw, not what any step saw: a later step
				// can finish the roots an earlier one left behind.
				hasMoreExpiredRoots = expired.hasMoreExpiredRoots;
				this.updateScan(cache, {
					allowEmptyCollection:
						scan.allowEmptyCollection ||
						expired.rootsExpired > 0 ||
						this.cacheGraceManaged(cache),
					...(!expired.hasMoreExpiredRoots && { phase: 'expire-grace' })
				});

				if (isRowBudgetExhausted()) {
					break;
				}

				scan = this.scanRow(cache);
				continue;
			}

			if (scan.phase === 'expire-grace') {
				const expired = this.expireGraceStep(cache, now);

				// Emptying the frontier is safe only before the seed phases. No path
				// is marked yet, so every entry comes from a root-target or grace
				// barrier, and the seed phases queue those paths again. Refuse if a
				// mark exists, because a later phase order could then lose a path.
				if (!expired.hasMoreDeadlines) {
					this.assertNoMarks(cache);
					this.context.db
						.delete(schema.garbageCollectionFrontier)
						.where(eq(schema.garbageCollectionFrontier.cacheId, cache.id))
						.run();
				}

				this.updateScan(cache, {
					allowEmptyCollection:
						scan.allowEmptyCollection || this.cacheGraceManaged(cache),
					...(!expired.hasMoreDeadlines && { phase: 'roots' })
				});

				if (isRowBudgetExhausted()) {
					break;
				}

				scan = this.scanRow(cache);
				continue;
			}

			const { phase } = scan;
			const seedSource = seedSources.find(
				(candidate) => candidate.phase === phase
			);

			if (seedSource !== undefined) {
				this.advanceSeed(cache, seedSource, scan.cursor);

				if (isRowBudgetExhausted()) {
					break;
				}

				scan = this.scanRow(cache);
				continue;
			}

			if (scan.phase === 'mark') {
				const marked = this.advanceMark(cache, scan);

				if (marked.complete || isRowBudgetExhausted()) {
					break;
				}

				scan = this.scanRow(cache);
				continue;
			}

			// Preserve the collection cursor while following newly queued references.
			if (this.hasQueuedPaths(cache)) {
				this.updateScan(cache, { phase: 'mark' });

				if (isRowBudgetExhausted()) {
					break;
				}

				scan = this.scanRow(cache);
				continue;
			}

			const collected = this.advanceCollect(cache, now, scan.cursor);
			pathsCollected += collected.pathsCollected;

			if (collected.complete || isRowBudgetExhausted()) {
				break;
			}

			scan = this.scanRow(cache);
		}

		return {
			rootsExpired,
			rootTargetsExpired,
			pathsCollected,
			hasMoreExpiredRoots
		};
	}

	private cacheGraceManaged(cache: ResolvedCache): boolean {
		const row = this.context.db
			.select({ graceManaged: schema.cacheIdentities.graceManaged })
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.id, cache.id))
			.get();

		return row?.graceManaged ?? false;
	}

	// Pending rows own their staging keys. The orphan scan must not delete those
	// objects even when the rows appear after its R2 listing began.
	private trackedStagingKeys(keys: readonly string[]): ReadonlySet<string> {
		const tracked = new Set<string>();
		const uniqueKeys = [...new Set(keys)].map((key) =>
			r2ObjectKeySchema.parse(key)
		);

		for (const keys of jsonValueLists(uniqueKeys)) {
			const uploadMatches = this.context.db
				.select({ r2Key: schema.pendingUploads.r2Key })
				.from(schema.pendingUploads)
				.where(
					and(
						inArray(schema.pendingUploads.r2Key, keys),
						sql`(${schema.pendingUploads.recoveryDeadline} IS NULL OR ${schema.pendingUploads.recoveryDeadline} > ${new Date().toISOString()})`
					)
				)
				.all();
			const attestationMatches = this.context.db
				.select({ r2Key: schema.pendingAttestations.r2Key })
				.from(schema.pendingAttestations)
				.where(inArray(schema.pendingAttestations.r2Key, keys))
				.all();

			for (const match of [...uploadMatches, ...attestationMatches]) {
				tracked.add(match.r2Key);
			}
		}

		const operationIds = keys.flatMap((key) => {
			if (!key.startsWith(publicationStagingPrefix)) {
				return [];
			}
			const parsed = uploadIdSchema.safeParse(
				key.split('/', 4)[3]?.replace(/\.nar\.zst$/u, '')
			);
			return parsed.success ? parsed.data : [];
		});
		for (const page of jsonValueLists(operationIds)) {
			const operations = this.context.db
				.select()
				.from(schema.publicationOperations)
				.where(
					and(
						inArray(schema.publicationOperations.id, page),
						eq(schema.publicationOperations.state, 'accepted'),
						sql`${schema.publicationOperations.recoveryDeadline} > ${new Date().toISOString()}`
					)
				)
				.all();
			for (const operation of operations) {
				const key = publicationStagingKey(
					this.context.requireTenant(),
					pushIdSchema.parse(operation.pushId),
					operation.id
				);
				if (keys.includes(key)) {
					tracked.add(key);
				}
			}
		}

		return tracked;
	}

	// Require both an absent pending row and an age beyond the upload grace. The
	// age check protects an in-flight upload whose row was missing from the snapshot.
	private isReclaimableOrphan(
		object: R2Object,
		tracked: ReadonlySet<string>,
		orphanBefore: number
	): boolean {
		return !tracked.has(object.key) && object.uploaded.getTime() < orphanBefore;
	}

	private async orphanStagingResumeKey(
		prefix: string
	): Promise<string | undefined> {
		const stored = await this.context.ctx.storage.get(
			prefix === stagingPrefix
				? orphanStagingResumeStorageKey
				: `${orphanStagingResumeStorageKey}:v2`
		);

		return typeof stored === 'string' ? stored : undefined;
	}

	private async saveOrphanStagingResumeKey(
		resumeAfter: string | undefined,
		prefix: string
	): Promise<void> {
		if (resumeAfter === undefined) {
			await this.context.ctx.storage.delete(
				prefix === stagingPrefix
					? orphanStagingResumeStorageKey
					: `${orphanStagingResumeStorageKey}:v2`
			);
			return;
		}

		await this.context.ctx.storage.put(
			prefix === stagingPrefix
				? orphanStagingResumeStorageKey
				: `${orphanStagingResumeStorageKey}:v2`,
			resumeAfter
		);
	}

	// List staging objects from the stored resume key until the object or page
	// cap is reached. Load tracked rows only after finding an object, so an empty
	// staging prefix reads no rows. Later passes and the lifecycle rule handle
	// the remainder.
	private async collectOrphanStagingKeys(
		orphanBefore: number,
		prefix: string,
		budget: StagingCollectionBudget
	): Promise<OrphanStagingScan> {
		const keys: R2ObjectKey[] = [];
		const ownership = new StagingKeyOwnership(() =>
			this.context.pushCredentials()
		);
		const startAfter = await this.orphanStagingResumeKey(prefix);
		let resumeAfter = startAfter;
		let cursor: string | undefined;

		do {
			const listed = await this.context.env.BLOBS.list({
				prefix,
				limit: orphanListPageSize,
				...(cursor === undefined ? { startAfter } : { cursor })
			});
			budget.pages -= 1;
			const tracked = this.trackedStagingKeys(
				listed.objects.map((object) => object.key)
			);

			for (const object of listed.objects) {
				if (budget.keys === 0) {
					return { keys, resumeAfter, wasCapped: true };
				}

				if (
					this.isReclaimableOrphan(object, tracked, orphanBefore) &&
					(prefix === stagingPrefix
						? await ownership.isOwn(object.key)
						: !(await this.hasPublicationLease(object.key)))
				) {
					keys.push(r2ObjectKeySchema.parse(object.key));
					budget.keys -= 1;
				}

				resumeAfter = object.key;
			}

			cursor = listed.truncated ? listed.cursor : undefined;

			if (cursor !== undefined && budget.pages === 0) {
				return { keys, resumeAfter, wasCapped: true };
			}
		} while (cursor !== undefined);

		return { keys, resumeAfter: undefined, wasCapped: false };
	}

	private async hasPublicationLease(key: string): Promise<boolean> {
		const segment = key.split('/', 3)[2];
		if (segment === undefined) {
			return false;
		}
		const push = wellFormedPushId(segment);
		return (
			push !== undefined && (await this.context.pushCredentials().verify(push))
		);
	}

	private async reclaimOrphanStaging(
		logger: Logger,
		now: Date,
		prefix: string,
		budget: StagingCollectionBudget
	): Promise<number> {
		if (budget.pages === 0 || budget.keys === 0) {
			return 0;
		}
		const orphanBefore = now.getTime() - orphanStagingGraceMs;
		let scan: OrphanStagingScan;

		try {
			scan = await this.collectOrphanStagingKeys(
				orphanBefore,
				prefix === publicationStagingPrefix
					? `${prefix}${this.context.requireTenant()}/`
					: prefix,
				budget
			);
		} catch (error) {
			if (
				!(error instanceof TenantNotConfiguredError) &&
				!(error instanceof PushIdSigningKeyMissingError)
			) {
				throw error;
			}

			// Without the issuer, the scan cannot tell which keys belong to this
			// tenant. Skip the scan so the rest of the pass still completes.
			logger.warn('orphan staging scan cannot check push ID ownership', {
				error
			});

			return 0;
		}

		const { keys, resumeAfter, wasCapped } = scan;

		if (keys.length > 0) {
			await this.context.criticalSection(async () => {
				const owned = this.trackedStagingKeys(keys);
				await deleteObjects(
					this.context.env.BLOBS,
					keys.filter((key) => !owned.has(key))
				);
			});
		}
		await this.saveOrphanStagingResumeKey(resumeAfter, prefix);

		if (wasCapped) {
			logger.debug('orphan staging scan hit the per-run cap', {
				reclaimed: keys.length
			});
		}

		return keys.length;
	}

	private tenantCollectionCache(): ResolvedCache | undefined {
		const current = this.context.db
			.select({ cache: schema.garbageCollectionTenantRuns.cacheId })
			.from(schema.garbageCollectionTenantRuns)
			.where(eq(schema.garbageCollectionTenantRuns.id, 1))
			.get();

		if (current !== undefined) {
			return this.context.cacheRepository.resolvedForId(current.cache);
		}

		// nextCacheIdentity visits only larger identities. Start in the
		// same order so no cache is skipped.
		const first = this.context.db
			.select({ cache: schema.garbageCollectionInputs.cacheId })
			.from(schema.garbageCollectionInputs)
			.orderBy(asc(schema.garbageCollectionInputs.cacheId))
			.limit(1)
			.get();

		if (first === undefined) {
			return undefined;
		}

		const cache = this.context.cacheRepository.resolvedForId(first.cache);

		this.context.db
			.insert(schema.garbageCollectionTenantRuns)
			.values({
				id: 1,
				cacheId: cache.id
			})
			.run();

		return cache;
	}

	private nextCacheIdentity(after: ResolvedCache): ResolvedCache | undefined {
		const row = this.context.db
			.select({ cache: schema.garbageCollectionInputs.cacheId })
			.from(schema.garbageCollectionInputs)
			.where(gt(schema.garbageCollectionInputs.cacheId, after.id))
			.orderBy(asc(schema.garbageCollectionInputs.cacheId))
			.limit(1)
			.get();

		return row === undefined
			? undefined
			: this.context.cacheRepository.resolvedForId(row.cache);
	}

	private saveTenantCollection(next: ResolvedCache | undefined): void {
		if (next === undefined) {
			this.context.db
				.delete(schema.garbageCollectionTenantRuns)
				.where(eq(schema.garbageCollectionTenantRuns.id, 1))
				.run();
			return;
		}

		this.context.db
			.update(schema.garbageCollectionTenantRuns)
			.set({ cacheId: next.id })
			.where(eq(schema.garbageCollectionTenantRuns.id, 1))
			.run();
	}

	private collectRefreshCredentialMaintenance(now: IsoTimestamp): boolean {
		for (const table of [
			schema.legacyRefreshTokenMembers,
			schema.legacyRefreshTokenFamilies,
			schema.legacyRefreshTokens
		]) {
			this.context.db.run(
				sql`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY id LIMIT ${phaseStepSize})`
			);
		}
		this.context.db
			.run(sql`UPDATE refresh_session_member SET successor_envelope = NULL, successor_expires_at = NULL
			WHERE id IN (SELECT id FROM refresh_session_member INDEXED BY refresh_session_member_successor_expiry_idx
			WHERE successor_expires_at IS NOT NULL AND successor_expires_at < ${now}
			ORDER BY successor_expires_at, id LIMIT ${phaseStepSize})`);
		return (
			this.context.db.all<{ present: number }>(
				sql`SELECT 1 AS present FROM refresh_token_member LIMIT 1`
			).length > 0 ||
			this.context.db.all<{ present: number }>(
				sql`SELECT 1 AS present FROM refresh_token_family LIMIT 1`
			).length > 0 ||
			this.context.db.all<{ present: number }>(
				sql`SELECT 1 AS present FROM refresh_token LIMIT 1`
			).length > 0 ||
			this.context.db.all<{ present: number }>(
				sql`SELECT 1 AS present FROM refresh_session_member INDEXED BY refresh_session_member_successor_expiry_idx WHERE successor_expires_at IS NOT NULL AND successor_expires_at < ${now} LIMIT 1`
			).length > 0
		);
	}

	private collectExpiredSubjectNonces(now: IsoTimestamp): boolean {
		const expired = this.context.db
			.select({ nonce: schema.consumedSubjectNonces.nonce })
			.from(schema.consumedSubjectNonces)
			.where(lte(schema.consumedSubjectNonces.expiresAt, now))
			.orderBy(asc(schema.consumedSubjectNonces.expiresAt))
			.limit(phaseStepSize);
		const deleted = this.context.db
			.delete(schema.consumedSubjectNonces)
			.where(inArray(schema.consumedSubjectNonces.nonce, expired))
			.returning({ nonce: schema.consumedSubjectNonces.nonce })
			.all();

		return deleted.length === phaseStepSize;
	}

	/**
	Deletes expired refresh-token families a step at a time until the budget is
	spent or none is left. A family row is deleted only after its last member,
	so a partly deleted family is found again by the next pass without a
	cursor.
	*/
	private collectExpiredRefreshFamilies(
		now: IsoTimestamp
	): ExpiredRefreshFamilyCollection {
		let familiesDeleted = 0;
		let membersDeleted = 0;

		for (;;) {
			const step = this.collectExpiredRefreshFamilyStep(now);
			familiesDeleted += step.familiesDeleted;
			membersDeleted += step.membersDeleted;

			if (!step.hasMoreWork || isRowBudgetExhausted()) {
				return {
					familiesDeleted,
					membersDeleted,
					hasMoreWork: step.hasMoreWork
				};
			}
		}
	}

	// A family can hold more members than one step deletes. Delete a step's worth
	// from the oldest expired family and keep the family until every member is
	// gone.
	private collectExpiredRefreshFamilyStep(
		now: IsoTimestamp
	): ExpiredRefreshFamilyCollection {
		const page = phaseStepSize;

		return this.context.db.transaction((transaction) => {
			const family = transaction
				.select({ id: schema.refreshTokenFamilies.id })
				.from(schema.refreshTokenFamilies)
				.where(lte(schema.refreshTokenFamilies.expiresAt, now))
				.orderBy(
					asc(schema.refreshTokenFamilies.expiresAt),
					asc(schema.refreshTokenFamilies.id)
				)
				.limit(1)
				.get();

			if (family === undefined) {
				return { familiesDeleted: 0, hasMoreWork: false, membersDeleted: 0 };
			}

			const candidates = transaction
				.select({ id: schema.refreshTokenMembers.id })
				.from(schema.refreshTokenMembers)
				.where(eq(schema.refreshTokenMembers.familyId, family.id))
				.orderBy(
					asc(schema.refreshTokenMembers.generation),
					asc(schema.refreshTokenMembers.id)
				)
				.limit(page + 1)
				.all();

			if (candidates.length > 0) {
				const members = transaction
					.select({ id: schema.refreshTokenMembers.id })
					.from(schema.refreshTokenMembers)
					.where(eq(schema.refreshTokenMembers.familyId, family.id))
					.orderBy(
						asc(schema.refreshTokenMembers.generation),
						asc(schema.refreshTokenMembers.id)
					)
					.limit(page);

				transaction
					.delete(schema.refreshTokenMembers)
					.where(inArray(schema.refreshTokenMembers.id, members))
					.run();
			}

			if (candidates.length > page) {
				return { familiesDeleted: 0, hasMoreWork: true, membersDeleted: page };
			}

			transaction
				.delete(schema.refreshTokenFamilies)
				.where(eq(schema.refreshTokenFamilies.id, family.id))
				.run();

			const next = transaction
				.select({ id: schema.refreshTokenFamilies.id })
				.from(schema.refreshTokenFamilies)
				.where(lte(schema.refreshTokenFamilies.expiresAt, now))
				.limit(1)
				.get();

			return {
				familiesDeleted: 1,
				hasMoreWork: next !== undefined,
				membersDeleted: candidates.length
			};
		});
	}

	private collectExpiredRows(
		log: Logger,
		now: IsoTimestamp
	): ExpiredRowCollection {
		const hasMoreRefreshCredentialMaintenance =
			this.collectRefreshCredentialMaintenance(now);
		const expiredRefreshFamilies = this.collectExpiredRefreshFamilies(now);
		const hasMoreExpiredSubjectNonces = this.collectExpiredSubjectNonces(now);

		if (expiredRefreshFamilies.hasMoreWork) {
			log.warn(
				'refresh-token family backlog remains after bounded collection',
				{
					membersDeleted: expiredRefreshFamilies.membersDeleted,
					familiesDeleted: expiredRefreshFamilies.familiesDeleted
				}
			);
		}

		// `pending` and `committing` are live commit states, even after expiry;
		// verification may still resume them. Reap only uploads without a verdict
		// and terminal `servable`, `mismatch`, or `over-quota` uploads.
		const expiredUploads = this.context.db.all<
			Pick<
				typeof schema.pendingUploads.$inferSelect,
				'id' | 'narHash' | 'r2Key'
			>
		>(
			sql`DELETE FROM pending_upload
			    WHERE id IN (
			      SELECT id FROM pending_upload INDEXED BY pending_upload_terminal_expires_at_idx
			      WHERE expires_at < ${now}
			        AND (verdict IS NULL OR verdict = 'servable' OR verdict = 'mismatch' OR verdict = 'over-quota')
			      ORDER BY expires_at, id
			      LIMIT ${maxPendingRowsDeletedPerRun}
			    )
			    RETURNING id, nar_hash AS narHash, r2_key AS r2Key`
		);
		const dueAttestations = this.context.db
			.select({ id: schema.pendingAttestations.id })
			.from(schema.pendingAttestations)
			.where(lt(schema.pendingAttestations.expiresAt, now))
			.orderBy(asc(schema.pendingAttestations.expiresAt))
			.limit(maxPendingRowsDeletedPerRun);
		const expiredAttestations = this.context.db
			.delete(schema.pendingAttestations)
			.where(inArray(schema.pendingAttestations.id, dueAttestations))
			.returning({ r2Key: schema.pendingAttestations.r2Key })
			.all();
		// A step that filled its page may have left more behind. The alarm runs
		// the next one, which stops when it finds nothing.
		const hasMorePendingRows =
			expiredUploads.length === maxPendingRowsDeletedPerRun ||
			expiredAttestations.length === maxPendingRowsDeletedPerRun;

		if (hasMorePendingRows) {
			log.warn('pending staging backlog remains after bounded collection', {
				uploadsDeleted: expiredUploads.length,
				attestationsDeleted: expiredAttestations.length
			});
		}

		// Delete only private staging objects here. A reuse upload points at the
		// shared canonical NAR, whose lifetime is owned by the global reaper.
		const stagingKeys = [
			...expiredUploads
				.filter((upload) => upload.r2Key !== narObjectKey(upload.narHash))
				.map((upload) => upload.r2Key),
			...expiredAttestations.map((upload) => upload.r2Key)
		];

		return {
			pendingUploadsDeleted: expiredUploads.length,
			pendingAttestationsDeleted: expiredAttestations.length,
			hasMorePendingRows,
			hasMoreWork:
				hasMoreRefreshCredentialMaintenance ||
				expiredRefreshFamilies.hasMoreWork ||
				hasMoreExpiredSubjectNonces ||
				hasMorePendingRows,
			stagingKeys
		};
	}

	/**
	Advances the scan of one cache if it has a scan in progress, or needs a
	new one and the minimum interval allows it, and reads its
	managed-retirement state.
	
	A scan also deletes close events that no root or pending upload of an
	older retention epoch needs any more. Such an upload can expire after the
	scan completes, and deleting an expired terminal upload does not set the
	flag. A cache that is not scanned therefore still has one
	page of its close history cleaned, and a full page counts as more work,
	so that its managed retirement can complete.
	*/
	private visitCache(cache: ResolvedCache, now: IsoTimestamp): VisitedCache {
		const decision =
			this.scanRow(cache) === undefined
				? this.inputs.scanDecision(cache, now)
				: 'due';
		const isDue = decision === 'due';
		const hasMoreHistory =
			!isDue &&
			new CacheClosureService(this.context).cleanHistory(
				cache,
				maxRootsExpiredPerRun
			);
		const collected = isDue
			? this.collectUnreachable(cache, now)
			: {
					rootsExpired: 0,
					pathsCollected: 0,
					hasMoreExpiredRoots: false,
					hasMoreWork: false
				};
		const retirementRecheck = this.context.db
			.select({
				incarnation: schema.managedCacheRetirements.incarnation,
				revision: schema.managedCacheRetirements.revision
			})
			.from(schema.managedCacheRetirements)
			.where(
				and(
					eq(schema.managedCacheRetirements.cacheId, cache.id),
					lte(schema.managedCacheRetirements.eligibleAfter, now)
				)
			)
			.get();
		const hasMoreScanWork = collected.hasMoreWork || hasMoreHistory;
		const afterVisit = isDue
			? this.decisionAfterScan(cache, collected.hasMoreWork)
			: decision;

		if (decision === 'current' && !hasMoreHistory) {
			this.inputs.forgetIfDeleted(cache);
		}

		return {
			cache,
			...(retirementRecheck !== undefined && { retirementRecheck }),
			rootsExpired: collected.rootsExpired,
			pathsCollected: collected.pathsCollected,
			hasMoreExpiredRoots: collected.hasMoreExpiredRoots,
			wasScanned: isDue,
			hasMoreScanWork,
			isGraphCurrent: !hasMoreScanWork && afterVisit === 'current',
			...(afterVisit === 'waiting' && {
				scanAllowedAt: this.inputs.scanAllowedAt(cache)
			})
		};
	}

	private assertNoMarks(cache: ResolvedCache): void {
		const mark = this.context.db
			.select({ storePathHash: schema.garbageCollectionMarks.storePathHash })
			.from(schema.garbageCollectionMarks)
			.where(eq(schema.garbageCollectionMarks.cacheId, cache.id))
			.limit(1)
			.get();

		if (mark !== undefined) {
			throw new GarbageCollectionMarksBeforeSeedError(cache.id);
		}
	}

	// A write between two invocations of a scan leaves the input flag set, so
	// the completed scan does not reflect the cache's current inputs.
	private decisionAfterScan(
		cache: ResolvedCache,
		hasMoreWork: boolean
	): ScanDecision {
		if (hasMoreWork) {
			return 'due';
		}

		return this.inputs.state(cache)?.inputsChanged === false
			? 'current'
			: 'waiting';
	}

	private collectReachability(
		target: GarbageCollectionTarget,
		now: IsoTimestamp
	): ReachabilityCollection {
		this.assertTriggersPresent();

		if (target.scope === 'cache') {
			const visit = this.visitCache(target.cache, now);

			return { visited: [visit], hasMoreWork: visit.hasMoreScanWork };
		}

		const visited: VisitedCache[] = [];
		let cache = this.tenantCollectionCache();

		while (cache !== undefined) {
			const visit = this.visitCache(cache, now);

			visited.push(visit);

			if (visit.hasMoreScanWork) {
				return { visited, hasMoreWork: true };
			}

			const next = this.nextCacheIdentity(cache);

			this.saveTenantCollection(next);

			if (next === undefined || visit.wasScanned || isRowBudgetExhausted()) {
				return { visited, hasMoreWork: next !== undefined };
			}

			cache = next;
		}

		return { visited, hasMoreWork: false };
	}

	// R2 narinfo keys do not include the narinfo generation. Keep the gate
	// between the live-generation check and object deletion so a recommit
	// cannot replace the object while an older queued deletion is in progress.
	private flushNarInfoDeletions(
		purgeOrigin: RequestOrigin | undefined,
		afterFlush: () => Promise<void> = () => Promise.resolve()
	): Promise<number> {
		return this.context.criticalSection(async () => {
			const deleted =
				await this.deletionQueue.flushQueuedNarInfoDeletions(purgeOrigin);

			await afterFlush();

			return deleted;
		});
	}

	// Delete R2 objects outside the critical section. The orphan scan then reads
	// current pending rows and applies the age fence, so a concurrent upload is
	// not mistaken for an orphan. A failed first delete must not discard the
	// collection counters or prevent that reconciliation.
	private async deleteStagingObjects(
		log: Logger,
		stagingKeys: readonly R2ObjectKey[]
	): Promise<void> {
		try {
			await deleteObjects(this.context.env.BLOBS, stagingKeys);
		} catch (error) {
			log.warn(
				'staging object deletion failed; orphan reconciliation will retry it',
				{
					error,
					stagedKeys: stagingKeys.length
				}
			);
		}
	}

	/**
	Runs the bounded deletes of a pass without its reachability scan: expired
	rows, the narinfo deletion queue, and the staging objects of the deleted
	uploads. The alarm runs this when a pending upload that deferred a
	narinfo deletion expires, because that deletion is the only work due.
	Orphan staging reconciliation lists R2, and every full pass runs it, so
	this does not.
	*/
	async collectExpiredRowsWithoutScan(
		logger: Logger,
		purgeOrigin?: RequestOrigin
	): Promise<GarbageCollectionOutcome> {
		const log = logger.with({ job: 'garbage-collection' });
		const expired = this.collectExpiredRows(log, isoTimestamp(new Date()));
		const narInfosDeleted = await this.flushNarInfoDeletions(purgeOrigin);

		await this.deleteStagingObjects(log, expired.stagingKeys);

		return {
			retirementRechecks: [],
			pendingUploadsDeleted: expired.pendingUploadsDeleted,
			pendingAttestationsDeleted: expired.pendingAttestationsDeleted,
			rootsExpired: 0,
			pathsCollected: 0,
			hasMoreExpiredRoots: false,
			hasMoreWork: expired.hasMoreWork,
			narInfosDeleted,
			orphanStagingDeleted: 0
		};
	}

	async collectGarbage(
		logger: Logger,
		target: GarbageCollectionTarget,
		purgeOrigin?: RequestOrigin
	): Promise<GarbageCollectionOutcome> {
		const cache = target.scope === 'cache' ? target.cache : undefined;
		const log = logger.with({
			job: 'garbage-collection',
			...(cache !== undefined && { cache: cache.scope })
		});
		const startedAt = new Date();
		const now = isoTimestamp(startedAt);
		const expired = this.collectExpiredRows(log, now);
		const { visited, hasMoreWork } = this.collectReachability(target, now);
		const narInfosDeleted = await this.flushNarInfoDeletions(
			purgeOrigin,
			async () => {
				for (const visit of visited) {
					if (!visit.hasMoreScanWork) {
						await this.cacheAdmin.scheduleManagedRetirement(
							visit.cache,
							purgeOrigin
						);
					}
				}
			}
		);

		await this.deleteStagingObjects(log, expired.stagingKeys);

		const budget: StagingCollectionBudget = {
			pages: maxOrphanListPages,
			keys: maxOrphanReclaim
		};
		const rotationKey = 'maintenance:orphan-staging-next-namespace';
		const hasV2First =
			(await this.context.ctx.storage.get(rotationKey)) === true;
		const prefixes = hasV2First
			? [publicationStagingPrefix, stagingPrefix]
			: [stagingPrefix, publicationStagingPrefix];
		let orphanStagingDeleted = 0;
		for (const prefix of prefixes) {
			orphanStagingDeleted += await this.reclaimOrphanStaging(
				log,
				startedAt,
				prefix,
				budget
			);
		}
		await this.context.ctx.storage.put(rotationKey, !hasV2First);

		return {
			retirementRechecks: visited.flatMap(
				({ cache, retirementRecheck, isGraphCurrent, scanAllowedAt }) =>
					retirementRecheck === undefined
						? []
						: {
								cacheId: cache.id,
								...retirementRecheck,
								cacheGraphComplete: isGraphCurrent,
								...(scanAllowedAt !== undefined && { scanAllowedAt }),
								pendingExpiryBacklog: expired.hasMorePendingRows
							}
			),
			pendingUploadsDeleted: expired.pendingUploadsDeleted,
			pendingAttestationsDeleted: expired.pendingAttestationsDeleted,
			rootsExpired: sum(visited.map((visit) => visit.rootsExpired)),
			pathsCollected: sum(visited.map((visit) => visit.pathsCollected)),
			hasMoreExpiredRoots: visited.some((visit) => visit.hasMoreExpiredRoots),
			hasMoreWork: expired.hasMoreWork || hasMoreWork,
			narInfosDeleted,
			orphanStagingDeleted
		};
	}

	/**
	Makes the next pass start a new scan of each cache of the target, whatever
	its inputs and however recently it was scanned. A scan in progress is
	discarded, because it may have marked a path before a later change
	released the path, and that scan would keep the path.
	*/
	requestScan(target: GarbageCollectionTarget): void {
		if (target.scope === 'cache') {
			this.clearScan(target.cache);
			this.inputs.requestScan(target.cache.id);
			return;
		}

		this.context.db.transaction((tx) => {
			tx.delete(schema.garbageCollectionFrontier).run();
			tx.delete(schema.garbageCollectionMarks).run();
			tx.delete(schema.garbageCollectionScans).run();
			tx.delete(schema.garbageCollectionTenantRuns).run();
		});
		this.inputs.requestScan();
	}
}
