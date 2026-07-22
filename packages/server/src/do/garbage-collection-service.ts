import { type Logger } from '@cupboard/logger';
import {
	type RootName,
	type StoredCache,
	storePathBasenameSchema,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
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
import { narObjectKey, stagingPrefix } from '../http/http.ts';

import { chunk, deleteObjects, maxInClauseValues } from './bulk.ts';
import {
	type GarbageCollectionOutcome,
	type ServerContext
} from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { type RetentionService } from './retention-service.ts';
import { parseStoredUploadPathMetadata } from './upload-metadata.ts';

// One sweep deletes at most this many committed paths before returning, so a
// chunk holds the Durable Object's gate only for its own deletes. When a sweep
// stops at this cap the caller resumes it on an alarm, draining the backlog
// across chunks.
export const maxPathsSweptPerRun = 1000;

// Root expiry drains targets in bounded batches. The root row remains until its
// last target has moved to grace, so a larger or historical root resumes safely
// without a separate cursor or a reachability gap.
export const maxExpiredRootTargetsPerRun = 1000;

// Empty and small roots should drain together, while the target cap above
// remains the bound on path work.
export const maxRootsExpiredPerRun = 32;

// An upload credential is scoped to `staging/<pushId>/` and a client may write
// any key beneath it, including keys it never negotiated. The negotiated keys
// have pending rows the reaper owns; the rest are orphans only this
// reconciliation reclaims. Matching the upload TTL, an object younger than this
// may still belong to an in-flight upload, so the sweep leaves it for a later
// pass; the bucket lifecycle rule is the lazy backstop for anything beyond the
// per-run cap.
const orphanStagingGraceMs = 15 * 60 * 1000;

// One R2 `list` page; the platform caps a page at 1000 keys.
const orphanListPageSize = 1000;

// At most this many orphans are deleted per sweep, so a flood of staged objects
// cannot make a single GC run unbounded. Whatever remains is reclaimed by the
// next sweep and, failing that, the bucket lifecycle rule.
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
					allowEmptySweep: false
				})
				.onConflictDoUpdate({
					target: schema.garbageCollectionScans.cache,
					set: {
						revision,
						phase: 'expire-roots',
						cursor: '',
						markStorePathHash: sql`null`,
						referenceCursor: -1,
						allowEmptySweep: false
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
				'phase' | 'cursor' | 'referenceCursor' | 'allowEmptySweep' | 'revision'
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
		now: string
	): {
		rootsExpired: number;
		rootsInspected: number;
		rootTargetsExpired: number;
		hasMoreExpiredRoots: boolean;
	} {
		// Expire TTL'd roots first, regardless of whether a sweep follows, so an
		// expiring channel always lapses. A NULL expiry (permanent) never matches.
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

		// Each expiring root's targets receive a grace deadline before the root is
		// removed, anchored to the root's nominal expiry rather than this sweep's
		// time, so a late sweep cannot extend retention. The `lte` filter above
		// cannot match a NULL expiry, so the narrowing here never drops a root.
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
			// The deadline and target removal share one transaction: a crash between
			// them could otherwise release a target with no grace source in its place.
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

		if (retained === undefined && !scan.allowEmptySweep) {
			this.clearScan(cache);
			return true;
		}

		this.updateScan(cache, { phase: 'sweep', cursor: '' });
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

	private advanceSweep(
		cache: StoredCache,
		now: string,
		cursor: string,
		budget: number
	): {
		readonly used: number;
		readonly pathsSwept: number;
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
		let pathsSwept = 0;

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
			pathsSwept += 1;
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
			pathsSwept,
			complete: rows.length <= batch.length
		};
	}

	private collectUnreachable(
		cache: StoredCache,
		now: string,
		budget: number
	): {
		rootsExpired: number;
		rootTargetsExpired: number;
		pathsSwept: number;
		hasMoreExpiredRoots: boolean;
		hasMoreWork: boolean;
	} {
		let expiryRemaining = budget;
		let seedRemaining = budget;
		let markRemaining = budget;
		let sweepRemaining = budget;
		let rootsExpired = 0;
		let rootTargetsExpired = 0;
		let pathsSwept = 0;
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
					allowEmptySweep:
						scan.allowEmptySweep ||
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
					allowEmptySweep:
						scan.allowEmptySweep || this.cacheGraceManaged(cache),
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

			const swept = this.advanceSweep(cache, now, scan.cursor, sweepRemaining);
			sweepRemaining -= swept.used;
			pathsSwept += swept.pathsSwept;

			if (sweepRemaining === 0 || swept.complete) {
				break;
			}
		}

		return {
			rootsExpired,
			rootTargetsExpired,
			pathsSwept,
			hasMoreExpiredRoots,
			hasMoreWork:
				this.context.db
					.select({ cache: schema.garbageCollectionScans.cache })
					.from(schema.garbageCollectionScans)
					.where(eq(schema.garbageCollectionScans.cache, cache))
					.get() !== undefined
		};
	}

	// Read only when the sweep would otherwise skip an unreachable cache, so the
	// common retained case costs no extra row.
	private cacheGraceManaged(cache: StoredCache): boolean {
		const row = this.context.db
			.select({ graceManaged: schema.caches.graceManaged })
			.from(schema.caches)
			.where(eq(schema.caches.name, cache))
			.get();

		return row?.graceManaged ?? false;
	}

	// The r2Keys of every live pending upload and attestation: the staging objects
	// a row vouches for, which the reaper, not the orphan sweep, owns. Read once
	// per sweep, and only when there is a staging object to reconcile, so an idle
	// store with an empty staging root never scans the pending tables.
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

	// An object is reclaimable when no pending row tracks it and it predates the
	// upload grace, so an in-flight upload whose row this snapshot raced survives.
	private isReclaimableOrphan(
		object: R2Object,
		tracked: ReadonlySet<string>,
		orphanBefore: number
	): boolean {
		return !tracked.has(object.key) && object.uploaded.getTime() < orphanBefore;
	}

	// Lists the staging root and gathers the orphan keys, stopping at the per-run
	// cap. The tracked set is loaded lazily on the first object seen, so a sweep
	// over an empty staging root reads no rows. `wasCapped` is true when the cap
	// was reached with orphans still unlisted, so the caller can record that the
	// next sweep and the lifecycle rule finish the job.
	private async collectOrphanStagingKeys(
		orphanBefore: number
	): Promise<{ keys: string[]; wasCapped: boolean }> {
		const keys: string[] = [];
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
					keys.push(object.key);
				}
			}

			cursor = listed.truncated ? listed.cursor : undefined;
		} while (cursor !== undefined);

		return { keys, wasCapped: false };
	}

	// Reclaims staging objects no pending row tracks: keys a client wrote under
	// its `staging/<pushId>/` credential beyond what it negotiated, and the
	// remnants of pushes whose rows have already been reaped. Bounded per run and
	// gated on an upload-grace age so an in-flight upload survives.
	private async reclaimOrphanStaging(
		logger: Logger,
		now: Date
	): Promise<number> {
		const orphanBefore = now.getTime() - orphanStagingGraceMs;
		const { keys, wasCapped } =
			await this.collectOrphanStagingKeys(orphanBefore);

		await deleteObjects(this.context.env.BLOBS, keys);

		if (wasCapped) {
			logger.warn('orphan staging sweep hit the per-run cap', {
				reclaimed: keys.length
			});
		}

		return keys.length;
	}

	private tenantSweepCache(): StoredCache | undefined {
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

	private advanceTenantSweep(cache: StoredCache): boolean {
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
		purgeOrigin?: string,
		sweepLimit: number = maxPathsSweptPerRun
	): Promise<GarbageCollectionOutcome> {
		const log = logger.with({
			job: 'garbage-collection',
			...(cache !== undefined && { cache })
		});
		const startedAt = new Date();
		const now = startedAt.toISOString();

		// The staging objects the sweep reaps, deleted after the critical section
		// closes so an R2 stall cannot hold the gate. The rows are removed under the
		// gate; a delete that does not land leaves an object the orphan sweep
		// reclaims, exactly as it backstops any untracked staging object.
		let stagingKeys: string[] = [];

		const reaped = await this.context.criticalSection(async () => {
			// A `pending` or `committing` upload is a live commit saga (awaiting
			// background verification, or a crashed inline commit the verify pass
			// re-drives), not abandoned, so it and its staged bytes must survive the
			// sweep until the verify pass resolves it. The reapable states once expired
			// are a null-verdict row still awaiting its bytes and the terminal verdicts
			// (`servable`, `mismatch`, `over-quota`) whose status-observation window has
			// passed; their staging bytes are already gone.
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

			// An abandoned upload's private staging object is reclaimed directly; a
			// reuse upload's r2Key is the shared canonical key, which the reaper owns,
			// so it is left alone.
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
			// An expired refresh token nobody presented again still holds a row;
			// the sweep reclaims it. A live session is untouched (rotation renews
			// its expiry on every use).
			this.context.db
				.delete(schema.refreshTokens)
				.where(lt(schema.refreshTokens.expiresAt, now))
				.run();

			// A tenant-wide run advances through one registered cache at a time; a
			// scoped run works only its named cache. The selected cache's persistent
			// mark/frontier state bounds this pass without re-reading earlier chunks.
			const sweepCache = cache ?? this.tenantSweepCache();
			const swept =
				sweepCache === undefined
					? {
							rootsExpired: 0,
							pathsSwept: 0,
							hasMoreExpiredRoots: false,
							hasMoreWork: false
						}
					: this.collectUnreachable(sweepCache, now, sweepLimit);
			const hasMoreWork =
				cache === undefined && sweepCache !== undefined && !swept.hasMoreWork
					? this.advanceTenantSweep(sweepCache)
					: swept.hasMoreWork;

			const narInfosDeleted =
				await this.deletionQueue.flushQueuedNarInfoDeletions(purgeOrigin);

			// Queue retirement may delete the swept paths' grace rows. It runs under
			// the same gate, so absorbing that revision here cannot hide an external
			// mutation and prevents the scan from restarting on its own cleanup.
			if (sweepCache !== undefined && swept.hasMoreWork) {
				this.synchroniseScanRevision(sweepCache);
			}

			return {
				pendingUploadsDeleted: expiredUploads.length,
				pendingAttestationsDeleted: expiredAttestations.length,
				rootsExpired: swept.rootsExpired,
				pathsSwept: swept.pathsSwept,
				hasMoreExpiredRoots: swept.hasMoreExpiredRoots,
				hasMoreWork,
				narInfosDeleted
			};
		});

		// The reaped staging objects and the orphan sweep both delete R2 objects, so
		// they run outside the critical section. The orphan sweep reconciles against
		// the live pending rows by their keys, not a snapshot taken earlier, and
		// skips anything within the upload grace, so a row created while it runs is
		// never mistaken for an orphan.
		//
		// The rows were removed under the gate, so this delete is best-effort: a
		// failure must not lose the outcome counters or skip the orphan sweep, which
		// reclaims whatever did not land.
		try {
			await deleteObjects(this.context.env.BLOBS, stagingKeys);
		} catch (error) {
			log.warn(
				'staging object delete did not land; orphan sweep will reclaim',
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
