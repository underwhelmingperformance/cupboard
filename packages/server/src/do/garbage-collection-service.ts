import { type Logger } from '@cupboard/logger';
import {
	type RootName,
	type StoredCache,
	storePathBasenameSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	lt,
	lte,
	notExists,
	or,
	type SQL,
	sql
} from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import {
	StoredReferencesInvalidError,
	StoredReferencesJsonMalformedError,
	StoredReferencesNotArrayError
} from '../errors.ts';
import {
	narObjectKey,
	type R2ObjectKey,
	r2ObjectKeySchema,
	type RequestOrigin,
	stagingPrefix
} from '../http/http.ts';

import { deleteObjects, maxOutgoingConnections } from './bulk.ts';
import {
	type GarbageCollectionOutcome,
	type SchemaDatabase,
	type ServerContext
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import {
	jsonRowLists,
	type JsonValueList,
	jsonValueLists
} from './json-list.ts';
import { type RetentionService } from './retention-service.ts';
import { isRowBudgetExhausted } from './row-budget.ts';

/**
 * The items one phase step reads before the pass consults its row budget.
 *
 * This is a step size and not a cap. A pass runs a step, asks the budget, and
 * runs another, so the budget decides how much of a backlog one invocation
 * clears and this decides only how far a step can carry it past that point.
 * Any value from one upward reaches the same total, because a step always runs
 * whole and the pass records where it stopped. A larger value spends fewer
 * statements for the same rows and overshoots the budget by more.
 *
 * Do not size a step from the rows the budget has left. That makes a row an
 * item: a fresh invocation reads a step of `rowsPerInvocation` items and then
 * spends several rows processing each one, by a factor that differs per phase.
 */
export const phaseGranule = 128;

// The roots one expiry step inspects. This is a step size like `phaseGranule`
// and it is chosen: `expiredRootTargetSelect` binds the root list as one JSON
// parameter, so the statement's parameter count does not follow this value,
// and the row budget decides how many steps a pass runs. It is a second step
// size only because the expiry phase reads every root it selects in one query,
// and nothing stops it being raised to `phaseGranule`.
export const maxRootsExpiredPerRun = 32;

/**
 * Builds one ordered page of targets for roots that have just expired. The
 * query must include every root from the expiry pass so its ordering and limit
 * apply to the complete target set. Splitting the roots across queries would
 * give each subset its own page and could omit targets from the first global
 * page.
 *
 * The parameter test imports this builder and inspects the statement it makes.
 */
export function expiredRootTargetSelect(
	database: SchemaDatabase,
	cache: StoredCache,
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
				eq(schema.retentionRootTargets.cache, cache),
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

export class GarbageCollectionService {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: DeletionQueueService,
		private readonly retention: RetentionService
	) {}

	private currentRevision(cache: StoredCache): number {
		this.context.db
			.insert(schema.garbageCollectionRevisions)
			.values({ cache, revision: 0 })
			.onConflictDoNothing()
			.run();

		return (
			this.context.db
				.select({ revision: schema.garbageCollectionRevisions.revision })
				.from(schema.garbageCollectionRevisions)
				.where(eq(schema.garbageCollectionRevisions.cache, cache))
				.get()?.revision ?? 0
		);
	}

	private clearScan(cache: StoredCache): void {
		this.context.db.transaction((tx) => {
			tx.delete(schema.garbageCollectionFrontier)
				.where(eq(schema.garbageCollectionFrontier.cache, cache))
				.run();
			tx.delete(schema.garbageCollectionMarks)
				.where(eq(schema.garbageCollectionMarks.cache, cache))
				.run();
			tx.delete(schema.garbageCollectionScans)
				.where(eq(schema.garbageCollectionScans.cache, cache))
				.run();
		});
	}

	private resetScan(cache: StoredCache, revision: number): void {
		this.context.db.transaction((tx) => {
			tx.delete(schema.garbageCollectionFrontier)
				.where(eq(schema.garbageCollectionFrontier.cache, cache))
				.run();
			tx.delete(schema.garbageCollectionMarks)
				.where(eq(schema.garbageCollectionMarks.cache, cache))
				.run();
			tx.insert(schema.garbageCollectionScans)
				.values({
					cache,
					revision,
					phase: 'expire-roots',
					cursor: '',
					referenceCursor: -1,
					allowEmptyCollection: false
				})
				.onConflictDoUpdate({
					target: schema.garbageCollectionScans.cache,
					set: {
						revision,
						phase: 'expire-roots',
						cursor: '',
						markStorePathHash: sql`null`,
						referenceCursor: -1,
						allowEmptyCollection: false
					}
				})
				.run();
		});
	}

	private scanRow(
		cache: StoredCache
	): typeof schema.garbageCollectionScans.$inferSelect | undefined {
		return this.context.db
			.select()
			.from(schema.garbageCollectionScans)
			.where(eq(schema.garbageCollectionScans.cache, cache))
			.get();
	}

	/**
	 * Reads the scan, restarting it when the cache changed under it.
	 *
	 * The revision comparison costs two statements beyond the scan row itself,
	 * and it can only tell a pass something at its start: a cache's revision
	 * changes through triggers on `narinfo`, `retention_root`,
	 * `retention_root_target` and `retention_grace`, and within one invocation
	 * the only writer of those tables is the pass itself, which adopts its own
	 * revision as it goes. A pass therefore compares once and reads the row with
	 * {@link scanRow} after that.
	 */
	private scan(
		cache: StoredCache
	): typeof schema.garbageCollectionScans.$inferSelect {
		const revision = this.currentRevision(cache);
		const stored = this.scanRow(cache);

		if (stored?.revision !== revision) {
			this.resetScan(cache, revision);
			const reset = this.scanRow(cache);

			if (reset === undefined) {
				throw new Error('garbage-collection scan reset did not persist');
			}

			return reset;
		}

		return stored;
	}

	private updateScan(
		cache: StoredCache,
		set: Partial<
			Pick<
				typeof schema.garbageCollectionScans.$inferInsert,
				| 'phase'
				| 'cursor'
				| 'referenceCursor'
				| 'allowEmptyCollection'
				| 'revision'
			>
		> & {
			readonly markStorePathHash?: StorePathHash | SQL;
		}
	): void {
		this.context.db
			.update(schema.garbageCollectionScans)
			.set(set)
			.where(eq(schema.garbageCollectionScans.cache, cache))
			.run();
	}

	private synchroniseScanRevision(cache: StoredCache): void {
		this.updateScan(cache, { revision: this.currentRevision(cache) });
	}

	private expireRoots(
		cache: StoredCache,
		now: IsoTimestamp
	): {
		rootsExpired: number;
		rootsInspected: number;
		rootTargetsExpired: number;
		hasMoreExpiredRoots: boolean;
	} {
		const rootPage = maxRootsExpiredPerRun;

		// Expire roots even when no unreachable path is collected. Permanent roots
		// have a null expiry and cannot match this query.
		const expiredRootCandidates = this.context.db
			.select({
				name: schema.retentionRoots.name,
				expiresAt: schema.retentionRoots.expiresAt
			})
			.from(schema.retentionRoots)
			.where(
				and(
					eq(schema.retentionRoots.cache, cache),
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

		const targetPage = phaseGranule;

		// Anchor each target's grace period to the root's recorded expiry. Using the
		// collection time would extend retention whenever collection runs late.
		const expiredRootTargetCandidates = jsonValueLists(
			expiredRootNames
		).flatMap((names) =>
			expiredRootTargetSelect(this.context.db, cache, names, targetPage).all()
		);
		const expiredRootTargets = expiredRootTargetCandidates.slice(0, targetPage);
		let rootsExpired = 0;

		this.context.db.transaction((tx) => {
			// Add the grace deadline and remove the root target atomically. A crash
			// between separate operations could leave the path with no retention source.
			this.retention.applyGraceTransitions(
				cache,
				expiredRootTargets.flatMap((target) => {
					const anchorIso = expiryByRoot.get(target.rootName);

					return anchorIso === undefined
						? []
						: [{ storePathHash: target.storePathHash, anchorIso }];
				}),
				tx
			);

			for (const targets of jsonRowLists(expiredRootTargets)) {
				tx.delete(schema.retentionRootTargets)
					.where(
						and(
							eq(schema.retentionRootTargets.cache, cache),
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
							eq(schema.retentionRootTargets.cache, cache),
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
							eq(schema.retentionRoots.cache, cache),
							inArray(schema.retentionRoots.name, names)
						)
					)
					.run();
			}

			rootsExpired = completedRoots.length;
		});
		const hasMoreExpiredRoots =
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
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): void {
		for (const hashes of jsonValueLists(storePathHashes)) {
			this.context.db
				.insert(schema.garbageCollectionFrontier)
				.select(
					hashes.insertSource([sql`${cache}`, sql`null`, hashes.element()])
				)
				.onConflictDoNothing()
				.run();
		}
	}

	private advanceSeed(
		cache: StoredCache,
		phase: 'roots' | 'grace',
		cursor: string
	): void {
		const page = phaseGranule;
		const rows =
			phase === 'roots'
				? this.context.db
						.selectDistinct({
							storePathHash: schema.retentionRootTargets.storePathHash
						})
						.from(schema.retentionRootTargets)
						.where(
							and(
								eq(schema.retentionRootTargets.cache, cache),
								sql`${schema.retentionRootTargets.storePathHash} > ${cursor}`
							)
						)
						.orderBy(asc(schema.retentionRootTargets.storePathHash))
						.limit(page + 1)
						.all()
				: this.context.db
						.select({ storePathHash: schema.retentionGrace.storePathHash })
						.from(schema.retentionGrace)
						.where(
							and(
								eq(schema.retentionGrace.cache, cache),
								sql`${schema.retentionGrace.storePathHash} > ${cursor}`
							)
						)
						.orderBy(asc(schema.retentionGrace.storePathHash))
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

		this.updateScan(cache, {
			phase: phase === 'roots' ? 'grace' : 'mark',
			cursor: ''
		});
	}

	private existingMarks(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): ReadonlySet<StorePathHash> {
		const marks = new Set<StorePathHash>();

		for (const hashes of jsonValueLists(storePathHashes)) {
			const rows = this.context.db
				.select({ storePathHash: schema.garbageCollectionMarks.storePathHash })
				.from(schema.garbageCollectionMarks)
				.where(
					and(
						eq(schema.garbageCollectionMarks.cache, cache),
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
		cache: StoredCache,
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
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (shape === undefined) {
			return;
		}

		if (shape.referencesValid === 1 && shape.referencesType === 'array') {
			return;
		}

		if (shape.referencesValid !== 1) {
			throw new StoredReferencesJsonMalformedError(storePathHash);
		}

		throw new StoredReferencesNotArrayError(storePathHash);
	}

	/**
	 * Walks the frontier until the budget is spent or the mark completes.
	 *
	 * Each iteration is one step: it pops a path from the frontier and marks it,
	 * or it walks a step of one path's references. The budget is consulted after
	 * a step, so the first one always runs.
	 *
	 * The walk carries the path it is on and how far into its references it has
	 * reached, rather than reading them back from the scan row each step. It
	 * wrote them itself, and nothing else can write them while a synchronous
	 * pass holds the object.
	 */
	private advanceMark(
		cache: StoredCache,
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
					.where(eq(schema.garbageCollectionFrontier.cache, cache))
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
							eq(schema.narInfos.cache, cache),
							eq(schema.narInfos.storePathHash, frontier.storePathHash)
						)
					)
					.get();

				this.context.db.transaction((tx) => {
					tx.delete(schema.garbageCollectionFrontier)
						.where(
							and(
								eq(schema.garbageCollectionFrontier.cache, cache),
								eq(
									schema.garbageCollectionFrontier.storePathHash,
									frontier.storePathHash
								)
							)
						)
						.run();
					tx.insert(schema.garbageCollectionMarks)
						.values({ cache, storePathHash: frontier.storePathHash })
						.onConflictDoNothing()
						.run();

					if (row !== undefined) {
						tx.update(schema.garbageCollectionScans)
							.set({
								markStorePathHash: row.storePathHash,
								referenceCursor: -1
							})
							.where(eq(schema.garbageCollectionScans.cache, cache))
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

			const page = phaseGranule;

			const references = this.context.db.all<{
				referenceIndex: number;
				reference: unknown;
			}>(sql`
				SELECT CAST(json_each.key AS INTEGER) AS referenceIndex,
				       json_each.value AS reference
				FROM ${schema.narInfos}, json_each(${schema.narInfos.referencesJson})
				WHERE ${schema.narInfos.cache} = ${cache}
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

	private finishMark(
		cache: StoredCache,
		scan: typeof schema.garbageCollectionScans.$inferSelect
	): boolean {
		const retained = this.context.db
			.select({ storePathHash: schema.narInfos.storePathHash })
			.from(schema.narInfos)
			.innerJoin(
				schema.garbageCollectionMarks,
				and(
					eq(schema.garbageCollectionMarks.cache, schema.narInfos.cache),
					eq(
						schema.garbageCollectionMarks.storePathHash,
						schema.narInfos.storePathHash
					)
				)
			)
			.where(eq(schema.narInfos.cache, cache))
			.limit(1)
			.get();

		if (retained === undefined && !scan.allowEmptyCollection) {
			this.clearScan(cache);
			return true;
		}

		this.updateScan(cache, { phase: 'collect', cursor: '' });
		return false;
	}

	// A mark for the path the outer statement is looking at.
	private markedPath(cache: StoredCache) {
		return this.context.db
			.select({ one: sql`1` })
			.from(schema.garbageCollectionMarks)
			.where(
				and(
					eq(schema.garbageCollectionMarks.cache, cache),
					eq(
						schema.garbageCollectionMarks.storePathHash,
						schema.narInfos.storePathHash
					)
				)
			);
	}

	/**
	 * An upload still in flight for the path the outer statement is looking at.
	 *
	 * `pending` and `committing` are live commit states: verification may still
	 * settle them, so a path with such an upload is not collectable. The
	 * `pending_upload_gc_path_idx` index covers the cache, the store-path hash
	 * in the metadata and the verdict, so this subquery checks one path without
	 * scanning the in-flight set. Migration 0032 creates it and `schema.ts` does
	 * not declare it.
	 */
	private inFlightUpload(cache: StoredCache) {
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
					eq(schema.pendingUploads.cache, cache),
					reservedVerdict,
					eq(uploadPath, schema.narInfos.storePathHash)
				)
			);
	}

	/**
	 * Collects the unreachable paths of one step.
	 *
	 * The step reads a page of paths to bound what it examines, then deletes the
	 * collectable ones in a single statement: a path survives when it is marked
	 * or an upload is in flight for it, and both are conditions the delete can
	 * express. Reading the page first is what bounds the step: a delete that
	 * searched for collectable paths itself would scan the table until it found
	 * them, however far that is.
	 */
	private advanceCollect(
		cache: StoredCache,
		now: IsoTimestamp,
		cursor: string
	): {
		readonly pathsCollected: number;
		readonly complete: boolean;
	} {
		const page = phaseGranule;
		const rows = this.context.db
			.select({
				storePathHash: schema.narInfos.storePathHash,
				narHash: schema.narInfos.narHash,
				generation: schema.narInfos.generation
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
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

			// Queue exactly the paths the delete removed, so a path kept by the mark
			// or by an upload in flight is never queued for deletion.
			this.context.db.transaction((tx) => {
				const collected = tx
					.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							paths.matches({
								storePathHash: schema.narInfos.storePathHash,
								generation: schema.narInfos.generation
							}),
							unmarked,
							settled
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
			this.synchroniseScanRevision(cache);
		} else {
			this.clearScan(cache);
		}

		return { pathsCollected, complete: rows.length <= batch.length };
	}

	/**
	 * Deletes one step of the deadlines that have passed.
	 *
	 * The delete names its rows through a subquery over the same table, and that
	 * subquery carries the step's limit, so the delete removes at most one step's
	 * rows without the pass reading the page first. The step looks for another
	 * due deadline only when it filled its page.
	 */
	private expireGraceStep(
		cache: StoredCache,
		now: IsoTimestamp
	): { readonly hasMoreDeadlines: boolean } {
		const page = phaseGranule;
		const due = this.context.db
			.select({ storePathHash: schema.retentionGrace.storePathHash })
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cache, cache),
					lte(schema.retentionGrace.retainUntil, now)
				)
			)
			.orderBy(asc(schema.retentionGrace.storePathHash))
			.limit(page);
		const expired = this.context.db
			.delete(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cache, cache),
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
					eq(schema.retentionGrace.cache, cache),
					lte(schema.retentionGrace.retainUntil, now)
				)
			)
			.limit(1)
			.get();

		return { hasMoreDeadlines: remaining !== undefined };
	}

	/**
	 * Advances one cache's collection scan until the invocation's row budget is
	 * spent, leaving the phase it stopped in recorded for the next invocation.
	 *
	 * The phases draw on one budget in sequence rather than taking a budget each,
	 * so an expensive early phase can leave a later one nothing to spend. That
	 * does not starve the later phase, because the input of each phase drains
	 * within a scan: a root expires once, a grace row is deleted as it is
	 * processed, the seed set is fixed when the scan starts, the mark frontier
	 * shrinks as paths are marked, and a collected path is deleted. The expensive
	 * phase is therefore cheap on the next invocation, which follows immediately
	 * because the pass re-arms its alarm while work remains.
	 */
	private collectUnreachable(
		cache: StoredCache,
		now: IsoTimestamp
	): {
		rootsExpired: number;
		rootTargetsExpired: number;
		pathsCollected: number;
		hasMoreExpiredRoots: boolean;
		hasMoreWork: boolean;
	} {
		let rootsExpired = 0;
		let rootTargetsExpired = 0;
		let pathsCollected = 0;
		let hasMoreExpiredRoots = false;
		// Compare the revision once. Nothing outside this pass can write the
		// tables that change it while the pass runs, and each phase adopts the
		// revision its own writes produce, so later steps read the row alone.
		let scan: typeof schema.garbageCollectionScans.$inferSelect | undefined =
			this.scan(cache);

		while (scan !== undefined) {
			if (scan.phase === 'expire-roots') {
				const expired = this.expireRoots(cache, now);
				rootsExpired += expired.rootsExpired;
				rootTargetsExpired += expired.rootTargetsExpired;
				// Report what the last step saw, not what any step saw: a later step
				// can finish the roots an earlier one left behind.
				hasMoreExpiredRoots = expired.hasMoreExpiredRoots;
				this.updateScan(cache, {
					revision: this.currentRevision(cache),
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

				this.updateScan(cache, {
					revision: this.currentRevision(cache),
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

			if (scan.phase === 'roots' || scan.phase === 'grace') {
				this.advanceSeed(cache, scan.phase, scan.cursor);

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
			hasMoreExpiredRoots,
			hasMoreWork:
				this.context.db
					.select({ cache: schema.garbageCollectionScans.cache })
					.from(schema.garbageCollectionScans)
					.where(eq(schema.garbageCollectionScans.cache, cache))
					.get() !== undefined
		};
	}

	private cacheGraceManaged(cache: StoredCache): boolean {
		const row = this.context.db
			.select({ graceManaged: schema.caches.graceManaged })
			.from(schema.caches)
			.where(eq(schema.caches.name, cache))
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
				.where(inArray(schema.pendingUploads.r2Key, keys))
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

	// List staging objects until the object or page cap is reached. Load tracked
	// rows only after finding an object, so an empty staging prefix reads no rows.
	// Later passes and the lifecycle rule handle the remainder.
	private async collectOrphanStagingKeys(
		orphanBefore: number
	): Promise<{ keys: R2ObjectKey[]; wasCapped: boolean }> {
		const keys: R2ObjectKey[] = [];
		let cursor: string | undefined;
		let pages = 0;

		do {
			const listed = await this.context.env.BLOBS.list({
				prefix: stagingPrefix,
				cursor,
				limit: orphanListPageSize
			});
			pages += 1;
			const tracked = this.trackedStagingKeys(
				listed.objects.map((object) => object.key)
			);

			for (const object of listed.objects) {
				if (keys.length >= maxOrphanReclaim) {
					return { keys, wasCapped: true };
				}

				if (this.isReclaimableOrphan(object, tracked, orphanBefore)) {
					keys.push(r2ObjectKeySchema.parse(object.key));
				}
			}

			cursor = listed.truncated ? listed.cursor : undefined;

			if (cursor !== undefined && pages === maxOrphanListPages) {
				return { keys, wasCapped: true };
			}
		} while (cursor !== undefined);

		return { keys, wasCapped: false };
	}

	private async reclaimOrphanStaging(
		logger: Logger,
		now: Date
	): Promise<number> {
		const orphanBefore = now.getTime() - orphanStagingGraceMs;
		const { keys, wasCapped } =
			await this.collectOrphanStagingKeys(orphanBefore);

		await deleteObjects(this.context.env.BLOBS, keys);

		if (wasCapped) {
			logger.warn('orphan staging scan hit the per-run cap', {
				reclaimed: keys.length
			});
		}

		return keys.length;
	}

	private tenantCollectionCache(): StoredCache | undefined {
		const current = this.context.db
			.select({ cache: schema.garbageCollectionTenantRuns.cache })
			.from(schema.garbageCollectionTenantRuns)
			.where(eq(schema.garbageCollectionTenantRuns.id, 1))
			.get();

		if (current !== undefined) {
			return current.cache;
		}

		const first = this.context.db
			.select({ cache: schema.caches.name })
			.from(schema.caches)
			.orderBy(asc(schema.caches.name))
			.limit(1)
			.get();

		if (first === undefined) {
			return undefined;
		}

		this.context.db
			.insert(schema.garbageCollectionTenantRuns)
			.values({ id: 1, cache: first.cache })
			.run();

		return first.cache;
	}

	private advanceTenantCollection(cache: StoredCache): boolean {
		const next = this.context.db
			.select({ cache: schema.caches.name })
			.from(schema.caches)
			.where(gt(schema.caches.name, cache))
			.orderBy(asc(schema.caches.name))
			.limit(1)
			.get();

		if (next === undefined) {
			this.context.db
				.delete(schema.garbageCollectionTenantRuns)
				.where(eq(schema.garbageCollectionTenantRuns.id, 1))
				.run();
			return false;
		}

		this.context.db
			.update(schema.garbageCollectionTenantRuns)
			.set({ cache: next.cache })
			.where(eq(schema.garbageCollectionTenantRuns.id, 1))
			.run();

		return true;
	}

	/**
	 * Deletes expired refresh-token families a step at a time until the budget is
	 * spent or none is left, keeping a family until every member is gone.
	 *
	 * This phase is not part of a cache's collection scan and has no scan row to
	 * record a phase in, so its steps run here. It resumes without one: a family
	 * row outlives its members, so a partly deleted family is found again by the
	 * next pass.
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
		const page = phaseGranule;

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

	async collectGarbage(
		logger: Logger,
		cache?: StoredCache,
		purgeOrigin?: RequestOrigin
	): Promise<GarbageCollectionOutcome> {
		const log = logger.with({
			job: 'garbage-collection',
			...(cache !== undefined && { cache })
		});
		const startedAt = new Date();
		const now = isoTimestamp(startedAt);

		// Remove pending rows under the critical section, but delete their staging
		// objects afterwards so an R2 stall cannot hold the section. The orphan scan
		// retries objects left by a failed delete.
		let stagingKeys: R2ObjectKey[] = [];

		const reaped = await this.context.criticalSection(async () => {
			const expiredRefreshFamilies = this.collectExpiredRefreshFamilies(now);

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
			//
			// Each delete names its rows through a subquery and reports them with
			// `RETURNING`, so the pass learns which staging objects to remove
			// without reading the page first.
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
			stagingKeys = [
				...expiredUploads
					.filter((upload) => upload.r2Key !== narObjectKey(upload.narHash))
					.map((upload) => upload.r2Key),
				...expiredAttestations.map((upload) => upload.r2Key)
			];

			// Tenant-wide collection advances through registered caches one at a time.
			// Scoped collection uses only the requested cache. Persistent mark and
			// frontier state resumes each pass without rereading earlier chunks.
			const collectionCache = cache ?? this.tenantCollectionCache();
			const collected =
				collectionCache === undefined
					? {
							rootsExpired: 0,
							pathsCollected: 0,
							hasMoreExpiredRoots: false,
							hasMoreWork: false
						}
					: this.collectUnreachable(collectionCache, now);
			const hasMoreCollectionWork =
				cache === undefined &&
				collectionCache !== undefined &&
				!collected.hasMoreWork
					? this.advanceTenantCollection(collectionCache)
					: collected.hasMoreWork;
			const hasMoreWork =
				expiredRefreshFamilies.hasMoreWork ||
				hasMorePendingRows ||
				hasMoreCollectionWork;

			const narInfosDeleted =
				await this.deletionQueue.flushQueuedNarInfoDeletions(purgeOrigin);

			// Queue retirement can change the scan revision by deleting grace rows. It
			// runs under this critical section, so adopting that revision ignores only
			// the scan's own cleanup and still detects external changes.
			if (collectionCache !== undefined && collected.hasMoreWork) {
				this.synchroniseScanRevision(collectionCache);
			}

			return {
				pendingUploadsDeleted: expiredUploads.length,
				pendingAttestationsDeleted: expiredAttestations.length,
				rootsExpired: collected.rootsExpired,
				pathsCollected: collected.pathsCollected,
				hasMoreExpiredRoots: collected.hasMoreExpiredRoots,
				hasMoreWork,
				narInfosDeleted
			};
		});

		// Delete R2 objects outside the critical section. The orphan scan then reads
		// current pending rows and applies the age fence, so a concurrent upload is
		// not mistaken for an orphan. A failed first delete must not discard the
		// collection counters or prevent that reconciliation.
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

		const orphanStagingDeleted = await this.reclaimOrphanStaging(
			log,
			startedAt
		);

		return { ...reaped, orphanStagingDeleted };
	}
}
