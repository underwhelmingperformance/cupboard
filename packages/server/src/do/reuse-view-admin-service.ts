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
	type ReuseViewSummary,
	type StoredReuseView
} from '@cupboard/protocol/reuse-views';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { inArray, type SQL, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import {
	reuseViewSummaryFromRow,
	type SchemaWriter,
	type ServerContext
} from './context.ts';
import { type JsonRowList, jsonRowLists } from './json-list.ts';
import {
	legacyReuseViewKey,
	legacyReuseViewKeys,
	legacyReuseViewSelectorRows,
	reuseViewSelectorRow,
	reuseViewSelectorsFromRows
} from './reuse-view-selectors.ts';

/**
 * A selector row as its insert's list carries it. A list value is text or a
 * number, so a column the selector's kind leaves unset travels as an empty
 * string and the statement writes `null` back through `nullif`. Neither a
 * cache name nor a prefix is ever empty.
 */
export interface StoredReuseViewSelector {
	readonly kind: ReuseViewSelector['kind'];
	readonly cacheName: string;
	readonly prefix: string;
}

// The columns of one legacy selector row, as SQL reads them back from the list.
export interface LegacyStoredReuseViewSelector {
	readonly kind: 'exact' | 'prefix';
	readonly pattern: string;
}

function nullWhenEmpty(value: SQL): SQL {
	return sql`nullif(${value}, '')`;
}

export function storedReuseViewSelector(
	selector: ReuseViewSelector
): StoredReuseViewSelector {
	const row = reuseViewSelectorRow(selector);

	return {
		kind: row.kind,
		cacheName: row.cacheName ?? '',
		prefix: row.prefix ?? ''
	};
}

/**
 * Builds the insert that records one list of a view's selectors. The selectors
 * travel as a row list, so the statement binds the same parameters however many
 * a request carries.
 *
 * `reuse_view_selector_native` numbers its rows itself, so the source supplies
 * a null id for SQLite to replace.
 *
 * The parameter test imports this builder and inspects the statement it makes.
 */
export function reuseViewSelectorInsert(
	handle: SchemaWriter,
	view: StoredReuseView,
	selectors: JsonRowList<StoredReuseViewSelector>
) {
	const cacheName = nullWhenEmpty(selectors.column('cacheName'));
	const prefix = nullWhenEmpty(selectors.column('prefix'));

	return handle
		.insert(schema.nativeReuseViewSelectors)
		.select(
			selectors.insertSource([
				sql`null`,
				sql`${view}`,
				selectors.column('kind'),
				cacheName,
				prefix
			])
		);
}

// The legacy rows stay in step with the native ones until the contraction
// drops them, and their insert binds its list the same way.
export function legacyReuseViewSelectorInsert(
	handle: SchemaWriter,
	view: StoredReuseView,
	selectors: JsonRowList<LegacyStoredReuseViewSelector>
) {
	return handle
		.insert(schema.reuseViewSelectors)
		.select(
			selectors.insertSource([
				sql`${view}`,
				selectors.column('kind'),
				selectors.column('pattern')
			])
		);
}

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
		const keys = legacyReuseViewKeys(name);
		const current = tx
			.select()
			.from(schema.reuseViews)
			.where(inArray(schema.reuseViews.name, keys))
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
					kind: schema.nativeReuseViewSelectors.kind,
					cacheName: schema.nativeReuseViewSelectors.cacheName,
					prefix: schema.nativeReuseViewSelectors.prefix
				})
				.from(schema.nativeReuseViewSelectors)
				.where(inArray(schema.nativeReuseViewSelectors.view, keys))
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
			access: body.access,
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
			.from(schema.nativeReuseViewSelectors)
			.all();
		const rowsByView = new Map<string, (typeof selectorRows)[number][]>();

		for (const row of selectorRows) {
			rowsByView.set(row.view, [...(rowsByView.get(row.view) ?? []), row]);
		}

		const selectorsByView = new Map<string, ReuseViewSelector[]>(
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

			// The view is stored under the key its access gives it, and a view that
			// changes access moves between the two keys. Every read therefore
			// matches both, and every write replaces the rows held under both.
			const keys = legacyReuseViewKeys(name);
			const storedName = legacyReuseViewKey(name, body.access);

			// A revision is an ABA fence for lookups, so it must never be reused.
			// The counter travels with the view across an access change, which is
			// why this takes the highest value recorded under either key.
			const recorded = tx
				.select({ next: schema.reuseViewRevisionSeq.nextRevision })
				.from(schema.reuseViewRevisionSeq)
				.where(inArray(schema.reuseViewRevisionSeq.name, keys))
				.all()
				.map((row) => row.next);
			const revision = reuseViewRevisionSchema.parse(Math.max(1, ...recorded));
			const nextRevision = reuseViewRevisionSchema.parse(revision + 1);

			tx.insert(schema.reuseViewRevisionSeq)
				.values({ name: storedName, nextRevision })
				.onConflictDoUpdate({
					target: schema.reuseViewRevisionSeq.name,
					set: { nextRevision }
				})
				.run();

			const existing = tx
				.select({ createdAt: schema.reuseViews.createdAt })
				.from(schema.reuseViews)
				.where(inArray(schema.reuseViews.name, keys))
				.get();
			const createdAt = existing?.createdAt ?? now;
			const priority = body.priority ?? reuseViewDefaultPriority;

			tx.delete(schema.reuseViews)
				.where(inArray(schema.reuseViews.name, keys))
				.run();
			tx.insert(schema.reuseViews)
				.values({
					name: storedName,
					access: body.access,
					revision,
					priority,
					createdAt,
					updatedAt: now
				})
				.run();

			tx.delete(schema.nativeReuseViewSelectors)
				.where(inArray(schema.nativeReuseViewSelectors.view, keys))
				.run();
			const listedSelectors = jsonRowLists(
				body.selectors.map((selector) => storedReuseViewSelector(selector))
			);

			for (const selectors of listedSelectors) {
				reuseViewSelectorInsert(tx, storedName, selectors).run();
			}

			tx.delete(schema.reuseViewSelectors)
				.where(inArray(schema.reuseViewSelectors.view, keys))
				.run();

			const listedLegacySelectors = jsonRowLists<LegacyStoredReuseViewSelector>(
				legacyReuseViewSelectorRows(storedName, body.selectors).map(
					({ kind, pattern }) => ({ kind, pattern })
				)
			);

			for (const rows of listedLegacySelectors) {
				legacyReuseViewSelectorInsert(tx, storedName, rows).run();
			}

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
		const keys = legacyReuseViewKeys(name);
		const existing = this.context.db
			.select({ name: schema.reuseViews.name })
			.from(schema.reuseViews)
			.where(inArray(schema.reuseViews.name, keys))
			.get();

		this.context.db.transaction((tx) => {
			tx.delete(schema.nativeReuseViewSelectors)
				.where(inArray(schema.nativeReuseViewSelectors.view, keys))
				.run();
			tx.delete(schema.reuseViewSelectors)
				.where(inArray(schema.reuseViewSelectors.view, keys))
				.run();
			tx.delete(schema.reuseViews)
				.where(inArray(schema.reuseViews.name, keys))
				.run();
		});

		return { name, removed: existing !== undefined };
	}

	resolve(name: ReuseViewName): ResolvedReuseView | undefined {
		const keys = legacyReuseViewKeys(name);
		const row = this.context.db
			.select({
				access: schema.reuseViews.access,
				revision: schema.reuseViews.revision,
				priority: schema.reuseViews.priority
			})
			.from(schema.reuseViews)
			.where(inArray(schema.reuseViews.name, keys))
			.get();

		if (row === undefined) {
			return undefined;
		}

		// A row whose access the reconciliation has not yet supplied cannot say who
		// may read the view. Resolving it as public would open a private view, so
		// the view stays unresolved until the reconciliation reaches it.
		if (row.access === null) {
			return undefined;
		}

		const selectors = reuseViewSelectorsFromRows(
			name,
			this.context.db
				.select({
					kind: schema.nativeReuseViewSelectors.kind,
					cacheName: schema.nativeReuseViewSelectors.cacheName,
					prefix: schema.nativeReuseViewSelectors.prefix
				})
				.from(schema.nativeReuseViewSelectors)
				.where(inArray(schema.nativeReuseViewSelectors.view, keys))
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
