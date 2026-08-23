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
	isNull,
	lt,
	lte,
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

import { chunk, deleteObjects, maxInClauseValues } from './bulk.ts';
import {
	type GarbageCollectionOutcome,
	type ServerContext
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type RetentionService } from './retention-service.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';

// Bound the paths deleted under one critical section. An alarm resumes a scan
// that reaches this limit.
export const maxPathsCollectedPerRun = 1000;

// Keep the root row until every target has entered grace. This bounded batch can
// then resume without a cursor and without leaving a target unprotected.
export const maxExpiredRootTargetsPerRun = 1000;

export const maxRootsExpiredPerRun = 32;

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

	private scan(
		cache: StoredCache
	): typeof schema.garbageCollectionScans.$inferSelect {
		const revision = this.currentRevision(cache);
		const stored = this.context.db
			.select()
			.from(schema.garbageCollectionScans)
			.where(eq(schema.garbageCollectionScans.cache, cache))
			.get();

		if (stored?.revision !== revision) {
			this.resetScan(cache, revision);
			const reset = this.context.db
				.select()
				.from(schema.garbageCollectionScans)
				.where(eq(schema.garbageCollectionScans.cache, cache))
				.get();

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
			.limit(maxRootsExpiredPerRun + 1)
			.all();
		const expiredRoots = expiredRootCandidates.slice(0, maxRootsExpiredPerRun);
		const expiredRootNames = expiredRoots.map((root) => root.name);
		const expiryByRoot = new Map(
			expiredRoots.flatMap((root) =>
				root.expiresAt === null ? [] : [[root.name, root.expiresAt] as const]
			)
		);

		// Anchor each target's grace period to the root's recorded expiry. Using the
		// collection time would extend retention whenever collection runs late.
		const expiredRootTargetCandidates =
			expiredRootNames.length === 0
				? []
				: this.context.db
						.select({
							rootName: schema.retentionRootTargets.rootName,
							storePathHash: schema.retentionRootTargets.storePathHash
						})
						.from(schema.retentionRootTargets)
						.where(
							and(
								eq(schema.retentionRootTargets.cache, cache),
								inArray(schema.retentionRootTargets.rootName, expiredRootNames)
							)
						)
						.orderBy(
							asc(schema.retentionRootTargets.rootName),
							asc(schema.retentionRootTargets.storePathHash)
						)
						.limit(maxExpiredRootTargetsPerRun + 1)
						.all();
		const expiredRootTargets = expiredRootTargetCandidates.slice(
			0,
			maxExpiredRootTargetsPerRun
		);
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

			const hashesByRoot = new Map<RootName, StorePathHash[]>();

			for (const target of expiredRootTargets) {
				const hashes = hashesByRoot.get(target.rootName) ?? [];
				hashes.push(target.storePathHash);
				hashesByRoot.set(target.rootName, hashes);
			}

			for (const [rootName, storePathHashes] of hashesByRoot) {
				for (const storePathHashBatch of chunk(
					storePathHashes,
					maxInClauseValues
				)) {
					tx.delete(schema.retentionRootTargets)
						.where(
							and(
								eq(schema.retentionRootTargets.cache, cache),
								eq(schema.retentionRootTargets.rootName, rootName),
								inArray(
									schema.retentionRootTargets.storePathHash,
									storePathHashBatch
								)
							)
						)
						.run();
				}
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

			for (const rootNameBatch of chunk(completedRoots, maxInClauseValues)) {
				tx.delete(schema.retentionRoots)
					.where(
						and(
							eq(schema.retentionRoots.cache, cache),
							inArray(schema.retentionRoots.name, rootNameBatch)
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
		const batches = chunk(storePathHashes, Math.floor(maxInClauseValues / 2));

		for (const batch of batches) {
			this.context.db
				.insert(schema.garbageCollectionFrontier)
				.values(batch.map((storePathHash) => ({ cache, storePathHash })))
				.onConflictDoNothing()
				.run();
		}
	}

	private advanceSeed(
		cache: StoredCache,
		phase: 'roots' | 'grace',
		cursor: string,
		budget: number
	): { readonly used: number; readonly complete: boolean } {
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
						.limit(budget + 1)
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
						.limit(budget + 1)
						.all();
		const batch = rows.slice(0, budget);

		this.insertFrontier(
			cache,
			batch.map((row) => row.storePathHash)
		);

		if (rows.length > batch.length) {
			this.updateScan(cache, {
				cursor: batch.at(-1)?.storePathHash ?? cursor
			});
			return { used: batch.length, complete: false };
		}

		this.updateScan(cache, {
			phase: phase === 'roots' ? 'grace' : 'mark',
			cursor: ''
		});

		return { used: batch.length, complete: true };
	}

	private existingMarks(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): ReadonlySet<StorePathHash> {
		const marks = new Set<StorePathHash>();

		for (const batch of chunk(storePathHashes, maxInClauseValues)) {
			const rows = this.context.db
				.select({ storePathHash: schema.garbageCollectionMarks.storePathHash })
				.from(schema.garbageCollectionMarks)
				.where(
					and(
						eq(schema.garbageCollectionMarks.cache, cache),
						inArray(schema.garbageCollectionMarks.storePathHash, batch)
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

	private advanceMark(
		cache: StoredCache,
		budget: number
	): { readonly used: number; readonly complete: boolean } {
		let used = 0;

		while (used < budget) {
			const scan = this.scan(cache);
			let storePathHash = scan.markStorePathHash;
			let referenceCursor = scan.referenceCursor;

			if (!storePathHash) {
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
					return { used, complete: this.finishMark(cache) };
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
				used += 1;

				if (row === undefined) {
					continue;
				}

				storePathHash = row.storePathHash;
				referenceCursor = -1;

				if (used >= budget) {
					break;
				}
			}

			this.validateReferencesContainer(cache, storePathHash);

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
				LIMIT ${budget - used + 1}
			`);
			const batch = references.slice(0, budget - used);
			const hashes = batch.map(({ reference }) =>
				this.referenceHash(storePathHash, reference)
			);
			const marked = this.existingMarks(cache, hashes);

			this.insertFrontier(
				cache,
				hashes.filter((hash) => hash !== storePathHash && !marked.has(hash))
			);
			used += batch.length;

			if (references.length > batch.length) {
				this.updateScan(cache, {
					referenceCursor: batch.at(-1)?.referenceIndex ?? referenceCursor
				});
				break;
			}

			this.updateScan(cache, {
				markStorePathHash: sql`null`,
				referenceCursor: -1
			});
		}

		return { used, complete: false };
	}

	private finishMark(cache: StoredCache): boolean {
		const scan = this.scan(cache);
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

	private inFlightHashes(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[]
	): ReadonlySet<StorePathHash> {
		if (storePathHashes.length === 0) {
			return new Set();
		}

		const reservedVerdict = or(
			eq(schema.pendingUploads.verdict, 'committing'),
			eq(schema.pendingUploads.verdict, 'pending')
		);
		const hashes = new Set<StorePathHash>();

		for (const batch of chunk(storePathHashes, maxInClauseValues)) {
			const rows = this.context.db
				.select({
					id: schema.pendingUploads.id,
					metadataJson: schema.pendingUploads.metadataJson
				})
				.from(schema.pendingUploads)
				.where(
					and(
						eq(schema.pendingUploads.cache, cache),
						reservedVerdict,
						inArray(
							sql<string>`json_extract(${schema.pendingUploads.metadataJson}, '$.storePathHash')`,
							batch
						)
					)
				)
				.all();

			for (const row of rows) {
				let storePathHash: StorePathHash | undefined;

				try {
					storePathHash = parseStoredUploadPathMetadata(
						row.id,
						row.metadataJson
					).storePathHash;
				} catch {
					storePathHash = undefined;
				}

				if (storePathHash !== undefined) {
					hashes.add(storePathHash);
				}
			}
		}

		return hashes;
	}

	private advanceCollect(
		cache: StoredCache,
		now: IsoTimestamp,
		cursor: string,
		budget: number
	): {
		readonly used: number;
		readonly pathsCollected: number;
		readonly complete: boolean;
	} {
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
			.limit(budget + 1)
			.all();
		const batch = rows.slice(0, budget);
		const hashes = batch.map((row) => row.storePathHash);
		const marked = this.existingMarks(cache, hashes);
		const inFlight = this.inFlightHashes(cache, hashes);
		let pathsCollected = 0;

		for (const path of batch) {
			if (marked.has(path.storePathHash) || inFlight.has(path.storePathHash)) {
				continue;
			}

			this.context.db.transaction((tx) => {
				tx.delete(schema.narInfos)
					.where(
						and(
							eq(schema.narInfos.cache, cache),
							eq(schema.narInfos.storePathHash, path.storePathHash),
							eq(schema.narInfos.generation, path.generation)
						)
					)
					.run();
				this.deletionQueue.enqueueNarInfoDeletion(
					tx,
					cache,
					path.storePathHash,
					path.narHash,
					path.generation,
					now
				);
			});
			pathsCollected += 1;
		}

		if (rows.length > batch.length) {
			this.updateScan(cache, {
				cursor: batch.at(-1)?.storePathHash ?? cursor
			});
			this.synchroniseScanRevision(cache);
		} else {
			this.clearScan(cache);
		}

		return {
			used: batch.length,
			pathsCollected,
			complete: rows.length <= batch.length
		};
	}

	private collectUnreachable(
		cache: StoredCache,
		now: IsoTimestamp,
		budget: number
	): {
		rootsExpired: number;
		rootTargetsExpired: number;
		pathsCollected: number;
		hasMoreExpiredRoots: boolean;
		hasMoreWork: boolean;
	} {
		let expiryRemaining = budget;
		let seedRemaining = budget;
		let markRemaining = budget;
		let collectRemaining = budget;
		let rootsExpired = 0;
		let rootTargetsExpired = 0;
		let pathsCollected = 0;
		let hasMoreExpiredRoots = false;

		for (;;) {
			const scan = this.scan(cache);

			if (scan.phase === 'expire-roots') {
				const expired = this.expireRoots(cache, now);
				rootsExpired += expired.rootsExpired;
				rootTargetsExpired += expired.rootTargetsExpired;
				hasMoreExpiredRoots ||= expired.hasMoreExpiredRoots;
				this.updateScan(cache, {
					revision: this.currentRevision(cache),
					allowEmptyCollection:
						scan.allowEmptyCollection ||
						expired.rootsExpired > 0 ||
						this.cacheGraceManaged(cache),
					...(!expired.hasMoreExpiredRoots && { phase: 'expire-grace' })
				});

				if (expired.hasMoreExpiredRoots) {
					break;
				}

				continue;
			}

			if (scan.phase === 'expire-grace') {
				const candidates = this.context.db
					.select({ storePathHash: schema.retentionGrace.storePathHash })
					.from(schema.retentionGrace)
					.where(
						and(
							eq(schema.retentionGrace.cache, cache),
							lte(schema.retentionGrace.retainUntil, now)
						)
					)
					.orderBy(asc(schema.retentionGrace.storePathHash))
					.limit(expiryRemaining + 1)
					.all();
				const batch = candidates.slice(0, expiryRemaining);

				const deadlineBatches = chunk(
					batch.map((row) => row.storePathHash),
					maxInClauseValues
				);

				for (const hashes of deadlineBatches) {
					this.context.db
						.delete(schema.retentionGrace)
						.where(
							and(
								eq(schema.retentionGrace.cache, cache),
								inArray(schema.retentionGrace.storePathHash, hashes)
							)
						)
						.run();
				}
				expiryRemaining -= batch.length;
				this.updateScan(cache, {
					revision: this.currentRevision(cache),
					allowEmptyCollection:
						scan.allowEmptyCollection || this.cacheGraceManaged(cache),
					...(candidates.length <= batch.length && { phase: 'roots' })
				});

				if (candidates.length > batch.length) {
					break;
				}

				continue;
			}

			if (scan.phase === 'roots' || scan.phase === 'grace') {
				const seeded = this.advanceSeed(
					cache,
					scan.phase,
					scan.cursor,
					seedRemaining
				);
				seedRemaining -= seeded.used;

				if (seedRemaining === 0 && !seeded.complete) {
					break;
				}

				continue;
			}

			if (scan.phase === 'mark') {
				const marked = this.advanceMark(cache, markRemaining);
				markRemaining -= marked.used;

				if (marked.complete) {
					break;
				}
				if (markRemaining === 0) {
					break;
				}

				continue;
			}

			const collected = this.advanceCollect(
				cache,
				now,
				scan.cursor,
				collectRemaining
			);
			collectRemaining -= collected.used;
			pathsCollected += collected.pathsCollected;

			if (collectRemaining === 0 || collected.complete) {
				break;
			}
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
	private trackedStagingKeys(): ReadonlySet<string> {
		return new Set<string>([
			...this.context.db
				.select({ r2Key: schema.pendingUploads.r2Key })
				.from(schema.pendingUploads)
				.all()
				.map((row) => row.r2Key),
			...this.context.db
				.select({ r2Key: schema.pendingAttestations.r2Key })
				.from(schema.pendingAttestations)
				.all()
				.map((row) => row.r2Key)
		]);
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

	private async collectOrphanStagingKeys(
		orphanBefore: number
	): Promise<{ keys: R2ObjectKey[]; wasCapped: boolean }> {
		const keys: R2ObjectKey[] = [];
		let cursor: string | undefined;
		let tracked: ReadonlySet<string> | undefined;

		do {
			const listed = await this.context.env.BLOBS.list({
				prefix: stagingPrefix,
				cursor,
				limit: orphanListPageSize
			});

			for (const object of listed.objects) {
				if (keys.length >= maxOrphanReclaim) {
					return { keys, wasCapped: true };
				}

				tracked ??= this.trackedStagingKeys();

				if (this.isReclaimableOrphan(object, tracked, orphanBefore)) {
					keys.push(r2ObjectKeySchema.parse(object.key));
				}
			}

			cursor = listed.truncated ? listed.cursor : undefined;
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
			logger.warn('orphan staging reclaim hit the per-run cap', {
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

	async collectGarbage(
		logger: Logger,
		cache?: StoredCache,
		purgeOrigin?: RequestOrigin,
		collectLimit: number = maxPathsCollectedPerRun
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
			// `pending` and `committing` are live commit states, even after expiry;
			// verification may still resume them. Reap only uploads without a verdict
			// and terminal `servable`, `mismatch`, or `over-quota` uploads.
			const reapable = and(
				lt(schema.pendingUploads.expiresAt, now),
				or(
					isNull(schema.pendingUploads.verdict),
					eq(schema.pendingUploads.verdict, 'servable'),
					eq(schema.pendingUploads.verdict, 'mismatch'),
					eq(schema.pendingUploads.verdict, 'over-quota')
				)
			);

			const expiredUploads = this.context.db
				.select()
				.from(schema.pendingUploads)
				.where(reapable)
				.all();
			const expiredAttestations = this.context.db
				.select()
				.from(schema.pendingAttestations)
				.where(lt(schema.pendingAttestations.expiresAt, now))
				.all();

			// Delete only private staging objects here. A reuse upload points at the
			// shared canonical NAR, whose lifetime is owned by the global reaper.
			stagingKeys = [
				...expiredUploads
					.filter((upload) => upload.r2Key !== narObjectKey(upload.narHash))
					.map((upload) => upload.r2Key),
				...expiredAttestations.map((upload) => upload.r2Key)
			];

			this.context.db.delete(schema.pendingUploads).where(reapable).run();
			this.context.db
				.delete(schema.pendingAttestations)
				.where(lt(schema.pendingAttestations.expiresAt, now))
				.run();
			this.context.db
				.delete(schema.refreshTokens)
				.where(lt(schema.refreshTokens.expiresAt, now))
				.run();

			const collectionCache = cache ?? this.tenantCollectionCache();
			const collected =
				collectionCache === undefined
					? {
							rootsExpired: 0,
							pathsCollected: 0,
							hasMoreExpiredRoots: false,
							hasMoreWork: false
						}
					: this.collectUnreachable(collectionCache, now, collectLimit);
			const hasMoreWork =
				cache === undefined &&
				collectionCache !== undefined &&
				!collected.hasMoreWork
					? this.advanceTenantCollection(collectionCache)
					: collected.hasMoreWork;

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
