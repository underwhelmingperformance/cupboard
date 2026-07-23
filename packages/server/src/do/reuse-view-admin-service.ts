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

	// The stored summary when the view already holds exactly the requested
	// definition, else undefined. Runs inside setView's transaction so the
	// comparison and any subsequent write cannot interleave with another
	// definition change.
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

	// An upsert of the view's whole definition: a fresh revision, replacing its
	// selector set wholesale, in one transaction so a reader never observes a
	// revision bump without its matching selectors or the other way round. The
	// revision counter is read-and-incremented inside the same transaction as
	// the write it stamps, so a losing racer's revision is never issued to a
	// winner that committed first.
	setView(
		name: ParsedReuseViewName,
		body: ParsedReuseViewSetBody
	): ReuseViewSummary {
		const now = new Date().toISOString();

		return this.context.db.transaction((tx) => {
			// An identical re-apply changes nothing and returns the stored
			// definition as it stands: a revision bump would force every
			// concurrent lookup through its revalidate-and-retry path, so a
			// content-free re-apply (a routine CI convergence run, say) must
			// not issue one.
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

	// Deletes the view and its selectors, but NEVER the revision sequence: a
	// view later recreated under the same name must never repeat a revision
	// the removed view already issued, since the read path's ABA fence depends
	// on a revision uniquely identifying one definition.
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

	/**
	 * Renders a reuse view's nix-cache-info body from its stored priority, or
	 * `undefined` when no view of that name exists.
	 */
	cacheInfoBody(name: string): string | undefined {
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
