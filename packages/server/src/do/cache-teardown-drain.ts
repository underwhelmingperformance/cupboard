import { rootLogger } from '@cupboard/logger';
import { publicationStagingPrefix } from '@cupboard/protocol/publication';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, inArray, type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import { type SQLiteTable } from 'drizzle-orm/sqlite-core';

import { type ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { stagingPrefix } from '../http/http.ts';

import { type ServerContext } from './context.ts';
import { type DeletionQueueService } from './deletion-queue-service.ts';
import { jsonValueList } from './json-list.ts';
import { concludePromotion, parsePromotionRecord } from './promotion-record.ts';
import { publicationFailureJson } from './publication-store.ts';
import { isRowBudgetExhausted } from './row-budget.ts';
import { affordableSubrequestOperations } from './subrequest-slice.ts';

// The most rows of one table that a step deletes, as in a collection scan's
// phases.
const pageSize = 128;

// Concluding the promotion of an upload whose verdict was awaited gives up
// the canonical incarnation that the upload reserved, in one D1 call.
const promotionSubrequests = 1;

type PendingUploadRow = typeof schema.pendingUploads.$inferSelect;

/**
What one pass of the drain left.
*/
export interface TeardownDrainProgress {
	// Whether no table that the drain empties has a row of the cache.
	readonly isEmpty: boolean;
	// Whether the pass made D1 calls to conclude promotions, which leaves
	// fewer calls for the rest of the pass than its page sizes assume.
	readonly hasConcludedPromotions: boolean;
}

// One page of a table step.
interface TablePage {
	readonly hasDeleted: boolean;
	// Whether rows of the cache remain in the table.
	readonly hasMore: boolean;
}

/**
Decides whether a pass of the drain may start another page.

Earlier work in the invocation can spend the row budget before the drain
starts, so the first page that deletes rows runs whatever the budget, and
every pass makes progress. A page that finds its table empty does not
count. The budget is checked before every later page, so the page that
spends it is the last of the pass, even when that page empties its table.
*/
class PassBudget {
	private hasDeleted = false;

	mayStartPage(): boolean {
		return !this.hasDeleted || !isRowBudgetExhausted();
	}

	recordPage(hasDeleted: boolean): void {
		this.hasDeleted ||= hasDeleted;
	}
}

// Deletes pages of one table until it has no row of the cache or the budget
// stops the pass.
function drainTable(
	step: () => TablePage,
	budget: PassBudget
): 'emptied' | 'stopped' {
	for (;;) {
		if (!budget.mayStartPage()) {
			return 'stopped';
		}

		const page = step();
		budget.recordPage(page.hasDeleted);
		if (!page.hasMore) {
			return 'emptied';
		}
	}
}

type UploadStep =
	| { readonly kind: 'empty' }
	| { readonly kind: 'refused' }
	| { readonly kind: 'deleted'; readonly concluded: number };

function isAwaitingVerdict(upload: PendingUploadRow): boolean {
	return upload.verdict === 'pending' || upload.verdict === 'committing';
}

// Whether concluding the upload's promotion makes a D1 call.
function hasPromotionReservation(upload: PendingUploadRow): boolean {
	return (
		isAwaitingVerdict(upload) &&
		parsePromotionRecord(upload.promotionJson)?.reservation !== undefined
	);
}

function stagingKeyCondition(r2Key: SQLWrapper): SQL {
	return sql`(substr(${r2Key}, 1, ${stagingPrefix.length}) = ${stagingPrefix} OR substr(${r2Key}, 1, ${publicationStagingPrefix.length}) = ${publicationStagingPrefix})`;
}

/**
Deletes the rows of a removed cache in pages, under the invocation's row
budget.

Removing a cache marks it removed and leaves its rows. Until this drain
deletes them, code that reaches them through the cache's id treats them as
absent, and no code adds a row for the cache. Every page deletes the rows
that it reads, so the next page starts at the first remaining row, and a
pass that stops after any page leaves a state from which the next pass
continues.
*/
export class CacheTeardownDrain {
	constructor(
		private readonly context: ServerContext,
		private readonly deletionQueue: Pick<
			DeletionQueueService,
			'enqueueNarInfoDeletions'
		>
	) {}

	private hasRow(table: SQLiteTable, cache: ResolvedCache): boolean {
		return (
			this.context.db.all<{ present: number }>(
				sql`SELECT 1 AS present FROM ${table} WHERE cache_id = ${cache.id} LIMIT 1`
			).length > 0
		);
	}

	private deletePage(table: SQLiteTable, cache: ResolvedCache): TablePage {
		// The statement writes rows only when it deletes some. A `RETURNING`
		// clause would report the count, but it adds billed row reads to every
		// page.
		this.context.dbCost.recordOutstanding();
		const writtenBefore = this.context.dbCost.rowsWritten;
		this.context.db.run(
			sql`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE cache_id = ${cache.id} LIMIT ${pageSize})`
		);
		this.context.dbCost.recordOutstanding();

		return {
			hasDeleted: this.context.dbCost.rowsWritten > writtenBefore,
			hasMore: this.hasRow(table, cache)
		};
	}

	private deleteNarInfoPage(cache: ResolvedCache): TablePage {
		const now = isoTimestamp(new Date());
		const page = sql`rowid IN (SELECT rowid FROM ${schema.narInfos} WHERE ${schema.narInfos.cacheId} = ${cache.id} LIMIT ${pageSize})`;

		const deleted = this.context.db.transaction((tx) => {
			const deleted = tx
				.delete(schema.narInfos)
				.where(page)
				.returning({
					storePathHash: schema.narInfos.storePathHash,
					narHash: schema.narInfos.narHash,
					generation: schema.narInfos.generation
				})
				.all();

			this.deletionQueue.enqueueNarInfoDeletions(tx, cache, deleted, now);

			return deleted;
		});

		return {
			hasDeleted: deleted.length > 0,
			hasMore: this.hasRow(schema.narInfos, cache)
		};
	}

	private deleteAttestationPage(cache: ResolvedCache): TablePage {
		const ids = this.context.db
			.select({ id: schema.pendingAttestations.id })
			.from(schema.pendingAttestations)
			.where(eq(schema.pendingAttestations.cacheId, cache.id))
			.limit(pageSize)
			.all()
			.map((row) => row.id);

		if (ids.length === 0) {
			return { hasDeleted: false, hasMore: false };
		}

		const inPage = inArray(schema.pendingAttestations.id, jsonValueList(ids));
		const staged = and(
			inPage,
			stagingKeyCondition(schema.pendingAttestations.r2Key)
		);
		this.context.db.transaction((tx) => {
			const stagedKeys = tx
				.select({
					cacheId: schema.pendingAttestations.cacheId,
					r2Key: schema.pendingAttestations.r2Key
				})
				.from(schema.pendingAttestations)
				.where(staged);

			tx.insert(schema.stagingCleanup)
				.select(stagedKeys)
				.onConflictDoNothing()
				.run();
			tx.delete(schema.pendingAttestations).where(inPage).run();
		});

		return { hasDeleted: true, hasMore: ids.length === pageSize };
	}

	/**
	Deletes one page of the cache's pending uploads and concludes each one as
	`absent`: its accepted operation fails, its staged object goes to
	`staging_cleanup`, and the promotion of an upload that awaited a verdict
	gives up its reservation. The page ends before the first upload whose
	promotion the remaining subrequests cannot conclude.
	*/
	private async deleteUploadPage(cache: ResolvedCache): Promise<UploadStep> {
		const rows = this.context.db
			.select()
			.from(schema.pendingUploads)
			.where(eq(schema.pendingUploads.cacheId, cache.id))
			.limit(pageSize)
			.all();

		if (rows.length === 0) {
			return { kind: 'empty' };
		}

		let affordable = affordableSubrequestOperations(promotionSubrequests);
		const page: PendingUploadRow[] = [];
		for (const row of rows) {
			if (hasPromotionReservation(row)) {
				if (affordable === 0) {
					break;
				}

				affordable -= 1;
			}

			page.push(row);
		}

		if (page.length === 0) {
			return { kind: 'refused' };
		}

		const list = jsonValueList(page.map((row) => row.id));
		const inPage = inArray(schema.pendingUploads.id, list);
		const staged = and(
			inPage,
			stagingKeyCondition(schema.pendingUploads.r2Key)
		);
		const deleted = this.context.db.transaction((tx) => {
			const stagedKeys = tx
				.select({
					cacheId: schema.pendingUploads.cacheId,
					r2Key: schema.pendingUploads.r2Key
				})
				.from(schema.pendingUploads)
				.where(staged);

			tx.insert(schema.stagingCleanup)
				.select(stagedKeys)
				.onConflictDoNothing()
				.run();
			tx.update(schema.publicationOperations)
				.set({ state: 'failed', resultJson: publicationFailureJson('absent') })
				.where(
					and(
						inArray(schema.publicationOperations.id, list),
						eq(schema.publicationOperations.state, 'accepted')
					)
				)
				.run();

			return tx.delete(schema.pendingUploads).where(inPage).returning().all();
		});

		for (const upload of deleted) {
			if (!isAwaitingVerdict(upload)) {
				continue;
			}

			await concludePromotion(this.context.d1, upload, {
				logger: rootLogger(),
				outcome: 'absent'
			});
		}

		return {
			kind: 'deleted',
			concluded: deleted.filter((upload) => hasPromotionReservation(upload))
				.length
		};
	}

	/**
	Runs the drain's steps in order until the cache has no rows left in their
	tables or the row budget runs out. Pending uploads go first, because
	verification and publication expiry act on them, and the narinfo rows go
	after the roots and grace rows that retain them.

	Each narinfo row is deleted in the transaction that queues its deletion
	at the row's generation, so the queued retirement removes exactly the
	edge and object of that row.
	*/
	async drain(cache: ResolvedCache): Promise<TeardownDrainProgress> {
		let hasConcludedPromotions = false;
		const budget = new PassBudget();

		for (;;) {
			if (!budget.mayStartPage()) {
				return { isEmpty: false, hasConcludedPromotions };
			}

			const step = await this.deleteUploadPage(cache);
			if (step.kind === 'empty') {
				break;
			}

			if (step.kind === 'refused') {
				return { isEmpty: false, hasConcludedPromotions };
			}

			budget.recordPage(true);
			hasConcludedPromotions ||= step.concluded > 0;
		}

		const steps: readonly (() => TablePage)[] = [
			() => this.deleteAttestationPage(cache),
			() => this.deletePage(schema.retentionRootReleases, cache),
			() => this.deletePage(schema.retentionRootTargets, cache),
			() => this.deletePage(schema.retentionRoots, cache),
			() => this.deletePage(schema.retentionGrace, cache),
			() => this.deleteNarInfoPage(cache),
			() => this.deletePage(schema.garbageCollectionMarks, cache),
			// The collection barrier triggers add frontier rows while a scan row
			// exists, so the frontier and then the scan row go last.
			() => this.deletePage(schema.garbageCollectionFrontier, cache),
			() => this.deletePage(schema.garbageCollectionScans, cache)
		];

		// When every step has run until its table has no row of the cache, the
		// drain is complete, because no code adds a row for a removed cache.
		const isEmpty = steps.every(
			(step) => drainTable(step, budget) === 'emptied'
		);

		return { isEmpty, hasConcludedPromotions };
	}
}
