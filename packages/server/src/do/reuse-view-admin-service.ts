import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cachePrioritySchema
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	reuseViewDefaultPriority,
	type ReuseViewListResponse,
	type ReuseViewName,
	type ReuseViewRemoveResponse,
	reuseViewRevisionSchema,
	type ReuseViewSelector,
	type ReuseViewSetBody,
	type ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { reuseViewSummaryFromRow, type ServerContext } from './context.ts';
import {
	reuseViewSelectorRow,
	reuseViewSelectorsFromRows
} from './reuse-view-selectors.ts';

function selectorSort(
	left: ReuseViewSelector,
	right: ReuseViewSelector
): number {
	return left.kind === right.kind
		? byCodeUnit(JSON.stringify(left), JSON.stringify(right))
		: byCodeUnit(left.kind, right.kind);
}

export interface ResolvedReuseView {
	readonly name: ReuseViewName;
	readonly access: CacheAccessMode;
	readonly revision: ReuseViewSummary['revision'];
	readonly priority: ReuseViewSummary['priority'];
	readonly selectors: readonly ReuseViewSelector[];
}

export class ReuseViewAdminService {
	constructor(private readonly context: ServerContext) {}

	private unchangedView(
		tx: Parameters<Parameters<ServerContext['db']['transaction']>[0]>[0],
		name: ReuseViewName,
		body: ReuseViewSetBody
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
		const stored = reuseViewSelectorsFromRows(
			name,
			tx
				.select({
					kind: schema.reuseViewSelectors.kind,
					cacheName: schema.reuseViewSelectors.cacheName,
					prefix: schema.reuseViewSelectors.prefix
				})
				.from(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, name))
				.all()
		).toSorted(selectorSort);
		const isUnchanged =
			current.access === body.access &&
			current.priority === priority &&
			stored.length === requested.length &&
			stored.every(
				(selector, index) =>
					JSON.stringify(selector) === JSON.stringify(requested[index])
			);

		if (!isUnchanged) {
			return undefined;
		}

		return {
			name,
			access: current.access,
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
		const rowsByView = new Map<
			ReuseViewName,
			(typeof selectorRows)[number][]
		>();

		for (const row of selectorRows) {
			rowsByView.set(row.view, [...(rowsByView.get(row.view) ?? []), row]);
		}

		const selectorsByView = new Map<ReuseViewName, ReuseViewSelector[]>(
			rowsByView
				.entries()
				.map(([view, rows]) => [view, reuseViewSelectorsFromRows(view, rows)])
		);

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

	setView(name: ReuseViewName, body: ReuseViewSetBody): ReuseViewSummary {
		const now = isoTimestamp(new Date());

		return this.context.db.transaction((tx) => {
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
				.values({
					name,
					access: body.access,
					revision,
					priority,
					createdAt,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: schema.reuseViews.name,
					set: {
						access: body.access,
						revision,
						priority,
						updatedAt: now
					}
				})
				.run();

			tx.delete(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, name))
				.run();
			tx.insert(schema.reuseViewSelectors)
				.values(
					body.selectors.map((selector) => ({
						view: name,
						...reuseViewSelectorRow(selector)
					}))
				)
				.run();

			return {
				name,
				access: body.access,
				revision,
				priority,
				selectors: body.selectors.toSorted(selectorSort),
				createdAt,
				updatedAt: now
			};
		});
	}

	removeView(name: ReuseViewName): ReuseViewRemoveResponse {
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

	resolve(name: ReuseViewName): ResolvedReuseView | undefined {
		const row = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision,
				priority: schema.reuseViews.priority
			})
			.from(schema.reuseViews)
			.where(eq(schema.reuseViews.name, name))
			.get();

		if (row === undefined) {
			return undefined;
		}

		const selectors = reuseViewSelectorsFromRows(
			name,
			this.context.db
				.select({
					kind: schema.reuseViewSelectors.kind,
					cacheName: schema.reuseViewSelectors.cacheName,
					prefix: schema.reuseViewSelectors.prefix
				})
				.from(schema.reuseViewSelectors)
				.where(eq(schema.reuseViewSelectors.view, name))
				.all()
		).toSorted(selectorSort);

		return {
			name,
			access: row.access,
			revision: row.revision,
			priority: row.priority,
			selectors
		};
	}

	cacheInfoBody(view: ResolvedReuseView): string {
		return new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.hasMassQuery,
			cachePrioritySchema.parse(view.priority)
		).render();
	}
}
