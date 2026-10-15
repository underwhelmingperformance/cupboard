import { type TransitionId } from '@cupboard/protocol/deployment';
import { and, asc, eq, exists, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type ListingAdoptionCaptureSequence,
	listingAdoptionCaptureSequenceSchema
} from '../blob/listing-adoption-capture.ts';
import { jsonValueList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

type Checkpoint = typeof schema.listingAdoptionConsumer.$inferSelect;
interface CapturePage {
	readonly ids: readonly ListingAdoptionCaptureSequence[];
	readonly through: ListingAdoptionCaptureSequence;
	readonly after: ListingAdoptionCaptureSequence;
	readonly hasMore: boolean;
}
const pageSize = 32;
const captureStart = listingAdoptionCaptureSequenceSchema.parse(0);
export type ListingAdoptionConsumeResult =
	| {
			readonly kind: 'advanced';
			readonly scanned: number;
			readonly enrolled: number;
			readonly after: ListingAdoptionCaptureSequence;
			readonly hasMore: boolean;
	  }
	| {
			readonly kind: 'expired';
			readonly prunedThrough: ListingAdoptionCaptureSequence;
	  }
	| { readonly kind: 'idle' | 'stale' | 'unavailable' };

/**
Copies bounded capture pages into durable expansion work before acknowledging
input progress. Captured sources do not grant publication or read authority.
*/
export class ListingAdoptionConsumerStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private transitionQuery(id: TransitionId) {
		const table = schema.deploymentTransition;
		return this.database
			.select({ id: table.id })
			.from(table)
			.where(and(eq(table.id, id), eq(table.state, 'complete')));
	}

	private readyQuery() {
		const readiness = and(
			exists(this.transitionQuery('listing-adoption-work')),
			exists(this.transitionQuery('listing-adoption-capture'))
		);
		return this.database
			.select({ one: sql`1`.as('one') })
			.from(sql`(SELECT 1) AS singleton`)
			.where(readiness);
	}

	private positionQuery() {
		const table = schema.listingAdoptionCaptureState;
		return this.database.select().from(table).where(eq(table.id, 1));
	}

	private stateQuery() {
		return this.database
			.select()
			.from(schema.listingAdoptionConsumer)
			.where(eq(schema.listingAdoptionConsumer.id, 1));
	}

	private captured(
		after: ListingAdoptionCaptureSequence,
		through: ListingAdoptionCaptureSequence
	) {
		const table = schema.listingAdoptionCaptureState;
		const eligibility = and(
			eq(table.id, 1),
			eq(table.isReady, true),
			lte(table.prunedThrough, after),
			gte(table.latest, through)
		);
		return this.database
			.select({ id: table.id })
			.from(table)
			.where(eligibility);
	}

	private async checkpoint(): Promise<Checkpoint | undefined> {
		const stored = await this.stateQuery().get();
		if (stored !== undefined) {
			return stored;
		}
		const readiness = and(
			exists(this.readyQuery()),
			exists(this.captured(captureStart, captureStart))
		);
		const source = this.database
			.select({
				id: sql`1`.as('id'),
				epoch: sql`lower(hex(randomblob(16)))`.as('epoch'),
				after: sql`0`.as('after'),
				scanned: sql`0`.as('scanned'),
				enrolled: sql`0`.as('enrolled'),
				updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`.as('updated_at')
			})
			.from(sql`(SELECT 1) AS singleton`)
			.where(readiness);
		await this.database
			.insert(schema.listingAdoptionConsumer)
			.select(source)
			.onConflictDoNothing();
		return this.stateQuery().get();
	}

	private fence(row: Checkpoint, through: ListingAdoptionCaptureSequence) {
		const table = schema.listingAdoptionConsumer;
		return and(
			eq(table.id, 1),
			eq(table.epoch, row.epoch),
			eq(table.after, row.after),
			eq(table.scanned, row.scanned),
			eq(table.enrolled, row.enrolled),
			exists(this.readyQuery()),
			exists(this.captured(row.after, through))
		);
	}

	private async enrol(
		row: Checkpoint,
		page: CapturePage
	): Promise<ListingAdoptionConsumeResult> {
		const checkpoint = schema.listingAdoptionConsumer;
		const current = this.database
			.select({ id: checkpoint.id })
			.from(checkpoint)
			.where(this.fence(row, page.through));
		const events = schema.listingAdoptionCaptureEvent;
		const selected = jsonValueList(page.ids);
		const eligibility = and(inArray(events.id, selected), exists(current));
		const source = this.database
			.select({
				id: sql`lower(hex(randomblob(16)))`.as('id'),
				consumerEpoch: sql`${row.epoch}`.as('consumer_epoch'),
				eventId: events.id,
				source: events.source,
				createdAt: events.createdAt
			})
			.from(events)
			.where(eligibility);
		const work = schema.listingAdoptionWork;
		const count = this.database
			.select({ count: sql<number>`count(*)` })
			.from(work)
			.where(
				and(eq(work.consumerEpoch, row.epoch), inArray(work.eventId, selected))
			);
		const [, saved] = await this.database.batch([
			this.database
				.insert(work)
				.select(source)
				.onConflictDoNothing({ target: [work.consumerEpoch, work.eventId] }),
			this.database
				.update(checkpoint)
				.set({
					after: page.after,
					scanned: sql`${checkpoint.scanned}+${page.ids.length}`,
					enrolled: sql`${checkpoint.enrolled}+(${count})`,
					updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`
				})
				.where(this.fence(row, page.through))
				.returning({
					scanned: checkpoint.scanned,
					enrolled: checkpoint.enrolled
				})
		]);
		const progress = saved[0];
		if (progress === undefined) {
			return { kind: 'stale' };
		}
		return {
			kind: 'advanced',
			scanned: progress.scanned - row.scanned,
			enrolled: progress.enrolled - row.enrolled,
			after: page.after,
			hasMore: page.hasMore
		};
	}

	async advance(): Promise<ListingAdoptionConsumeResult> {
		try {
			if ((await this.readyQuery().get()) === undefined) {
				return { kind: 'unavailable' };
			}
			const position = await this.positionQuery().get();
			if (position?.isReady !== true) {
				return { kind: 'unavailable' };
			}
			const row = await this.checkpoint();
			if (row === undefined) {
				return position.prunedThrough > 0
					? { kind: 'expired', prunedThrough: position.prunedThrough }
					: { kind: 'unavailable' };
			}
			if (row.after < position.prunedThrough) {
				return { kind: 'expired', prunedThrough: position.prunedThrough };
			}
			if (row.after > position.latest) {
				throw new Error(
					'The adoption consumer cursor exceeds the capture position'
				);
			}
			if (row.after === position.latest) {
				return { kind: 'idle' };
			}
			const events = schema.listingAdoptionCaptureEvent;
			const rows = await this.database
				.select({ id: events.id })
				.from(events)
				.where(and(gt(events.id, row.after), lte(events.id, position.latest)))
				.orderBy(asc(events.id))
				.limit(pageSize + 1);
			const ids = rows.slice(0, pageSize).map((event) => event.id);
			const hasMore = rows.length > pageSize;
			const after = hasMore ? ids.at(-1) : position.latest;
			if (after === undefined) {
				throw new Error('The adoption capture page cursor is missing');
			}
			return await this.enrol(row, {
				ids,
				through: position.latest,
				after,
				hasMore
			});
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
}
