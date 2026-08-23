import { CacheInfo } from '@cupboard/nix-store/cache-info';
import { cachePrioritySchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type ParsedReuseViewName,
	type ParsedReuseViewSelector,
	type ParsedReuseViewSetBody,
	reuseViewDefaultPriority,
	type ReuseViewListResponse,
	type ReuseViewRemoveResponse,
	reuseViewRevisionSchema,
	type ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { reuseViewSummaryFromRow, type ServerContext } from './context.ts';

function selectorSort(
	left: ParsedReuseViewSelector,
	right: ParsedReuseViewSelector
): number {
	return left.kind === right.kind
		? byCodeUnit(left.pattern, right.pattern)
		: byCodeUnit(left.kind, right.kind);
}

export class ReuseViewAdminService {
	constructor(private readonly context: ServerContext) {}

	// Compare the complete definition inside setView's transaction so another
	// writer cannot change it between this read and the subsequent update.
	private unchangedView(
		tx: Parameters<Parameters<ServerContext['db']['transaction']>[0]>[0],
		name: ParsedReuseViewName,
		body: ParsedReuseViewSetBody
	): ReuseViewSummary | undefined {
		const current = tx
			.select()
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, name))
			.get();

		if (current === undefined) {
			return undefined;
		}

		const priority = body.priority ?? reuseViewDefaultPriority;
		const requested = body.selectors.toSorted(selectorSort);
		const stored = tx
			.select({
				kind: schema.reuseViewSelectors.kind,
				pattern: schema.reuseViewSelectors.pattern
			})
			.from(schema.reuseViewSelectors)
			.where(eq(schema.reuseViewSelectors.view, name))
			.all()
			.toSorted(selectorSort);
		const isUnchanged =
			current.priority === priority &&
			stored.length === requested.length &&
			stored.every((selector, index) => {
				const match = requested[index];

				return (
					selector.kind === match?.kind && selector.pattern === match.pattern
				);
			});

		if (!isUnchanged) {
			return undefined;
		}

		return {
			name,
			revision: current.revision,
			priority,
			selectors: requested,
			createdAt: current.createdAt,
			updatedAt: current.updatedAt
		};
	}

	listViews(): ReuseViewListResponse {
		const views = this.context.db.select().from(schema.reuseViews).all();
		const selectorRows = this.context.db
			.select()
			.from(schema.reuseViewSelectors)
			.all();
		const selectorsByView = new Map<string, ParsedReuseViewSelector[]>();

		for (const row of selectorRows) {
			const selectors = selectorsByView.get(row.view) ?? [];

			selectors.push({ kind: row.kind, pattern: row.pattern });
			selectorsByView.set(row.view, selectors);
		}

		const summaries = views
			.map((view) =>
				reuseViewSummaryFromRow(
					view,
					(selectorsByView.get(view.name) ?? []).toSorted(selectorSort)
				)
			)
			.toSorted((left, right) => byCodeUnit(left.name, right.name));

		return { views: summaries };
	}

	// Replace the complete definition in one transaction. Readers must not see a
	// new revision with the old selectors, and concurrent writers must receive
	// revisions in commit order.
	setView(
		name: ParsedReuseViewName,
		body: ParsedReuseViewSetBody
	): ReuseViewSummary {
		const now = isoTimestamp(new Date());

		return this.context.db.transaction((tx) => {
			// An unchanged definition keeps its revision. Issuing a new revision
			// would make concurrent lookups revalidate and retry unnecessarily.
			const unchanged = this.unchangedView(tx, name, body);

			if (unchanged !== undefined) {
				return unchanged;
			}

			const seq = tx
				.select({ next: schema.reuseViewRevisionSeq.nextRevision })
				.from(schema.reuseViewRevisionSeq)
				.where(eq(schema.reuseViewRevisionSeq.name, name))
				.get();
			const revision = seq?.next ?? reuseViewRevisionSchema.parse(1);
			const nextRevision = reuseViewRevisionSchema.parse(revision + 1);

			tx.insert(schema.reuseViewRevisionSeq)
				.values({ name, nextRevision })
				.onConflictDoUpdate({
					target: schema.reuseViewRevisionSeq.name,
					set: { nextRevision }
				})
				.run();

			const existing = tx
				.select({ createdAt: schema.reuseViews.createdAt })
				.from(schema.reuseViews)
				.where(eq(schema.reuseViews.name, name))
				.get();
			const createdAt = existing?.createdAt ?? now;
			const priority = body.priority ?? reuseViewDefaultPriority;

			tx.insert(schema.reuseViews)
				.values({ name, revision, priority, createdAt, updatedAt: now })
				.onConflictDoUpdate({
					target: schema.reuseViews.name,
					set: { revision, priority, updatedAt: now }
				})
				.run();

			tx.delete(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, name))
				.run();
			tx.insert(schema.reuseViewSelectors)
				.values(
					body.selectors.map((selector) => ({
						view: name,
						kind: selector.kind,
						pattern: selector.pattern
					}))
				)
				.run();

			return {
				name,
				revision,
				priority,
				selectors: body.selectors.toSorted(selectorSort),
				createdAt,
				updatedAt: now
			};
		});
	}

	// Preserve the revision sequence when deleting a view. A recreated view must
	// not reuse a revision because lookups use it as an ABA fence.
	removeView(name: ParsedReuseViewName): ReuseViewRemoveResponse {
		const existing = this.context.db
			.select({ name: schema.reuseViews.name })
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, name))
			.get();

		this.context.db.transaction((tx) => {
			tx.delete(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, name))
				.run();
			tx.delete(schema.reuseViews)
				.where(eq(schema.reuseViews.name, name))
				.run();
		});

		return { name, removed: existing !== undefined };
	}

	cacheInfoBody(name: ParsedReuseViewName): string | undefined {
		const row = this.context.db
			.select({ priority: schema.reuseViews.priority })
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, name))
			.get();

		if (row === undefined) {
			return undefined;
		}

		return new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.hasMassQuery,
			cachePrioritySchema.parse(row.priority)
		).render();
	}
}
