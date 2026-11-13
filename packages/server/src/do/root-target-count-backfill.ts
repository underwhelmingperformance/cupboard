import { and, eq, gt, isNull, lte, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';
import { liveRootTargetCount } from './live-root-targets.ts';
import { isRowBudgetExhausted } from './row-budget.ts';

// The most roots that one pass reads before it counts any of them.
const rootTargetCountBackfillPageSize = 128;

const roots = schema.retentionRoots;
const state = schema.rootTargetCountBackfill;

/**
Counts the targets of each root without a `target_count`. Such a root
existed before migration 0085, and no set or ensure has written it since.
The listing reads the target rows of such a root.

A pass visits roots in rowid order from the cursor up to the highest rowid at
migration time, and counts each root without a count in its own statement.
Counting a root reads its target rows. A pass stops once the row budget is
spent, so it always counts at least one root.
*/
export class RootTargetCountBackfill {
	private complete = false;

	constructor(private readonly context: ServerContext) {}

	private progress() {
		return this.context.db
			.select({ cursor: state.cursor, rowidHighWater: state.rowidHighWater })
			.from(state)
			.where(eq(state.id, 1))
			.get();
	}

	hasPending(): boolean {
		if (this.complete) {
			return false;
		}

		const progress = this.progress();
		this.complete =
			progress === undefined || progress.cursor >= progress.rowidHighWater;

		return !this.complete;
	}

	advance(): void {
		const progress = this.progress();

		if (progress === undefined || progress.cursor >= progress.rowidHighWater) {
			return;
		}

		const rowid = sql<number>`${roots}.rowid`;
		const page = this.context.db
			.select({ rowid })
			.from(roots)
			.where(
				and(gt(rowid, progress.cursor), lte(rowid, progress.rowidHighWater))
			)
			.orderBy(rowid)
			.limit(rootTargetCountBackfillPageSize)
			.all();
		let counted = 0;

		for (const root of page) {
			this.context.db
				.update(roots)
				.set({ targetCount: liveRootTargetCount() })
				.where(and(eq(rowid, root.rowid), isNull(roots.targetCount)))
				.run();
			counted += 1;

			if (isRowBudgetExhausted()) {
				break;
			}
		}

		const isDone =
			counted === page.length && page.length < rootTargetCountBackfillPageSize;
		const cursor = isDone
			? progress.rowidHighWater
			: (page[counted - 1]?.rowid ?? progress.cursor);

		this.context.db.update(state).set({ cursor }).where(eq(state.id, 1)).run();
	}
}
