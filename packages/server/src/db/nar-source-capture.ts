import { and, asc, eq, exists, gt, gte, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type NarCapturePosition,
	narCapturePositionSchema,
	type NarCaptureSequence,
	narCaptureSequenceSchema,
	type NarCaptureWindow,
	narCaptureWindowSchema
} from '../blob/nar-source-capture.ts';
import { registeredLiveObjectIncarnation } from '../blob/object-incarnation.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';
import type { SharedNarSource } from './shared-nar-discovery.ts';

const replayPageSize = 32;
const prunePageSize = 128;
const positionFields = {
	latest: schema.narCaptureState.latest,
	prunedThrough: schema.narCaptureState.prunedThrough,
	isReady: schema.narCaptureState.isReady
};

export type NarCapturePageResult =
	| {
			readonly kind: 'page';
			readonly sources: readonly SharedNarSource[];
			readonly cursor: NarCaptureSequence;
			readonly isComplete: boolean;
	  }
	| { readonly kind: 'expired'; readonly prunedThrough: NarCaptureSequence };

export interface NarCapturePruneResult {
	readonly removed: number;
	readonly prunedThrough: NarCaptureSequence;
	readonly hasMore: boolean;
	readonly protectedByJobs: boolean;
}

/**
 * Replays retained NAR availability changes within a fixed capture window.
 * Events identify sources and do not grant cache read or publication authority.
 */
export class NarSourceCaptureStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private positionQuery() {
		return this.database
			.select(positionFields)
			.from(schema.narCaptureState)
			.where(eq(schema.narCaptureState.id, 1));
	}

	async position(): Promise<NarCapturePosition> {
		try {
			const row = await this.positionQuery().get();
			return narCapturePositionSchema.parse(row);
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	async page(window: NarCaptureWindow): Promise<NarCapturePageResult> {
		const { after, through } = narCaptureWindowSchema.parse(window);
		const reference = this.database
			.select({ one: sql`1` })
			.from(schema.blobReference)
			.where(eq(schema.blobReference.narHash, schema.narCaptureEvent.narHash));
		const sourceIdentity = and(
			eq(schema.blobState.narHash, schema.narCaptureEvent.narHash),
			eq(schema.blobState.incarnation, schema.narCaptureEvent.sourceIncarnation)
		);
		const windowPredicate = and(
			gt(schema.narCaptureEvent.id, after),
			lte(schema.narCaptureEvent.id, through)
		);
		const eventQuery = this.database
			.select({
				id: schema.narCaptureEvent.id,
				narHash: schema.narCaptureEvent.narHash,
				sourceIncarnation: schema.narCaptureEvent.sourceIncarnation,
				narSize: schema.blobState.narSize,
				fileSize: schema.blobState.fileSize,
				isRetained: exists(reference).mapWith(Boolean),
				isLive: registeredLiveObjectIncarnation(
					this.database,
					'nar',
					schema.narCaptureEvent.narHash,
					schema.narCaptureEvent.sourceIncarnation
				).mapWith(Boolean)
			})
			.from(schema.narCaptureEvent)
			.leftJoin(schema.blobState, sourceIdentity)
			.where(windowPredicate)
			.orderBy(asc(schema.narCaptureEvent.id))
			.limit(replayPageSize + 1);
		try {
			const [positions, rows] = await this.database.batch([
				this.positionQuery(),
				eventQuery
			]);
			const position = narCapturePositionSchema.parse(positions[0]);
			if (!position.isReady || through > position.latest) {
				throw new Error('NAR source capture boundary is not available');
			}
			if (after < position.prunedThrough) {
				return { kind: 'expired', prunedThrough: position.prunedThrough };
			}
			const selected = rows.slice(0, replayPageSize);
			const sources = new Map<SharedNarSource['narHash'], SharedNarSource>();
			for (const row of selected) {
				if (
					!row.isRetained ||
					!row.isLive ||
					row.narSize === null ||
					row.fileSize === null
				) {
					continue;
				}
				sources.set(row.narHash, {
					narHash: row.narHash,
					sourceIncarnation: row.sourceIncarnation,
					narSize: row.narSize,
					fileSize: row.fileSize
				});
			}
			const isComplete = rows.length <= replayPageSize;
			return {
				kind: 'page',
				sources: sources.values().toArray(),
				cursor: isComplete ? through : (selected.at(-1)?.id ?? after),
				isComplete
			};
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}

	/**
	 * The caller must durably record forward work through this boundary before
	 * pruning. Historical and catch-up jobs also protect their unread events.
	 */
	async pruneThrough(
		through: NarCaptureSequence
	): Promise<NarCapturePruneResult> {
		const acknowledged = narCaptureSequenceSchema.parse(through);
		const safeThrough = sql`min(${acknowledged},
			coalesce((SELECT event_cursor FROM shared_listing_job WHERE phase = 'historical' ORDER BY event_cursor LIMIT 1), ${acknowledged}),
			coalesce((SELECT event_cursor FROM shared_listing_job WHERE phase = 'catchup' ORDER BY event_cursor LIMIT 1), ${acknowledged}))`;
		const prunePredicate = and(
			eq(schema.narCaptureState.id, 1),
			eq(schema.narCaptureState.isReady, true),
			gte(schema.narCaptureState.latest, acknowledged)
		);
		const floorUpdate = this.database
			.update(schema.narCaptureState)
			.set({
				prunedThrough: sql`max(${schema.narCaptureState.prunedThrough}, coalesce((
					SELECT max(id) FROM (SELECT id FROM nar_capture_event WHERE id <= ${safeThrough} ORDER BY id LIMIT ${prunePageSize})
				), ${safeThrough}))`
			})
			.where(prunePredicate)
			.returning(positionFields);
		const eligibleState = this.database
			.select({ one: sql`1` })
			.from(schema.narCaptureState)
			.where(prunePredicate);
		const retainedFloor = sql`(SELECT pruned_through FROM nar_capture_state WHERE id = 1)`;
		const removable = and(
			lte(schema.narCaptureEvent.id, retainedFloor),
			exists(eligibleState)
		);
		const eventDeletion = this.database
			.delete(schema.narCaptureEvent)
			.where(removable)
			.returning({ id: schema.narCaptureEvent.id });
		const remainingEvents = this.database
			.select({
				hasMore:
					sql`EXISTS(SELECT 1 FROM nar_capture_event WHERE id <= ${safeThrough})`.mapWith(
						Boolean
					),
				protectedByJobs: sql`${safeThrough} < ${acknowledged}`.mapWith(Boolean)
			})
			.from(schema.narCaptureState)
			.where(prunePredicate);
		try {
			const [positions, removed, remaining] = await this.database.batch([
				floorUpdate,
				eventDeletion,
				remainingEvents
			]);
			const position = narCapturePositionSchema.parse(positions[0]);
			const status = remaining[0];
			if (status === undefined) {
				throw new Error('NAR source capture boundary is not available');
			}
			return {
				removed: removed.length,
				prunedThrough: position.prunedThrough,
				...status
			};
		} catch (error) {
			throw new SharedFactsUnavailableError(error);
		}
	}
}
