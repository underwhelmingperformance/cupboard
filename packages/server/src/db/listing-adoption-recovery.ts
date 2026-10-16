import { type TransitionId } from '@cupboard/protocol/deployment';
import { and, eq, exists, gt, gte, notExists, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type ListingAdoptionCaptureSequence,
	listingAdoptionCaptureSequenceSchema
} from '../blob/listing-adoption-capture.ts';
import { type ListingAdoptionConsumerEpoch } from '../blob/listing-adoption-work.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

export type ListingAdoptionRecoveryResult =
	| {
			readonly kind: 'recovered';
			readonly after: ListingAdoptionCaptureSequence;
			readonly epoch: ListingAdoptionConsumerEpoch;
	  }
	| { readonly kind: 'idle' | 'stale' | 'unavailable' };
interface RecoverySnapshot {
	readonly position: typeof schema.listingAdoptionCaptureState.$inferSelect;
	readonly consumer?: typeof schema.listingAdoptionConsumer.$inferSelect;
}
const databaseNow = sql`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const captureStart = listingAdoptionCaptureSequenceSchema.parse(0);

export class ListingAdoptionRecoveryStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}
	private completedTransition(id: TransitionId) {
		const table = schema.deploymentTransition;
		const condition = and(eq(table.id, id), eq(table.state, 'complete'));
		const marker = this.database
			.select({ id: table.id })
			.from(table)
			.where(condition);
		return exists(marker);
	}
	private readyQuery() {
		const installed = and(
			this.completedTransition('listing-adoption-capture'),
			this.completedTransition('listing-adoption-work'),
			this.completedTransition('listing-adoption-fact-seed'),
			this.completedTransition('listing-adoption-parents'),
			this.completedTransition('listing-adoption-parent-seed'),
			this.completedTransition('listing-adoption-seed-dispatch'),
			this.completedTransition('listing-adoption-tasks')
		);
		return this.database
			.select({ one: sql`1`.as('one') })
			.from(sql`(SELECT 1) AS singleton`)
			.where(installed);
	}
	private fence(snapshot: RecoverySnapshot) {
		const table = schema.listingAdoptionConsumer;
		const row = snapshot.consumer;
		const consumer = this.database.select({ id: table.id }).from(table);
		const identity =
			row === undefined
				? eq(table.id, 1)
				: and(
						eq(table.id, 1),
						eq(table.epoch, row.epoch),
						eq(table.after, row.after),
						eq(table.scanned, row.scanned),
						eq(table.enrolled, row.enrolled)
					);
		const selected = consumer.where(identity);
		const captured = row === undefined ? notExists(selected) : exists(selected);
		const state = schema.listingAdoptionCaptureState;
		const position = this.database
			.select({ id: state.id })
			.from(state)
			.where(
				and(
					eq(state.id, 1),
					eq(state.isReady, true),
					eq(state.prunedThrough, snapshot.position.prunedThrough),
					gt(state.prunedThrough, row?.after ?? captureStart),
					gte(state.latest, snapshot.position.latest)
				)
			);
		return and(captured, exists(position), exists(this.readyQuery()));
	}
	private async restart(
		snapshot: RecoverySnapshot
	): Promise<ListingAdoptionRecoveryResult> {
		const current = this.fence(snapshot);
		const table = schema.listingAdoptionConsumer;
		const epoch = sql<ListingAdoptionConsumerEpoch>`lower(hex(randomblob(16)))`;
		const after = snapshot.position.latest;
		const scanned = snapshot.consumer?.scanned ?? 0;
		const enrolled = snapshot.consumer?.enrolled ?? 0;
		const source = this.database
			.select({
				id: schema.listingAdoptionCaptureState.id,
				epoch: epoch.as('epoch'),
				after: sql<ListingAdoptionCaptureSequence>`${after}`.as('after'),
				scanned: sql<number>`${scanned}`.as('scanned'),
				enrolled: sql<number>`${enrolled}`.as('enrolled'),
				updatedAt: databaseNow.as('updated_at')
			})
			.from(schema.listingAdoptionCaptureState)
			.where(and(eq(schema.listingAdoptionCaptureState.id, 1), current));
		const checkpoint = this.database
			.insert(table)
			.select(source)
			.onConflictDoUpdate({
				target: table.id,
				set: {
					epoch: sql`excluded.epoch`,
					after,
					scanned,
					enrolled,
					updatedAt: databaseNow
				},
				setWhere: current
			})
			.returning({ epoch: table.epoch, after: table.after });
		const results = await this.database.batch([
			this.database.delete(schema.listingAdoptionFactSeed).where(current),
			this.database.delete(schema.listingAdoptionParentSeed).where(current),
			this.database.delete(schema.listingAdoptionSeedDispatch).where(current),
			checkpoint
		]);
		const saved = results[3];
		const row = saved[0];
		return row === undefined
			? { kind: 'stale' }
			: { kind: 'recovered', ...row };
	}
	async recover(): Promise<ListingAdoptionRecoveryResult> {
		try {
			if ((await this.readyQuery().get()) === undefined) {
				return { kind: 'unavailable' };
			}
			const position = await this.database
				.select()
				.from(schema.listingAdoptionCaptureState)
				.where(eq(schema.listingAdoptionCaptureState.id, 1))
				.get();
			if (position?.isReady !== true) {
				return { kind: 'unavailable' };
			}
			const consumer = await this.database
				.select()
				.from(schema.listingAdoptionConsumer)
				.where(eq(schema.listingAdoptionConsumer.id, 1))
				.get();
			if ((consumer?.after ?? captureStart) >= position.prunedThrough) {
				return { kind: 'idle' };
			}
			return await this.restart({ position, consumer });
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
}
