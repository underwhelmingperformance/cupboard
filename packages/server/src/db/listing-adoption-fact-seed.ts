import { type NarListingIdentity } from '@cupboard/protocol/artifacts';
import { and, asc, desc, eq, exists, isNull, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { jsonRowList } from '../do/json-list.ts';
import { SharedFactsUnavailableError } from '../errors.ts';

import * as schema from './d1-schema.ts';

const pageSize = 32;
type Checkpoint = typeof schema.listingAdoptionFactSeed.$inferSelect;
export type ListingAdoptionFactSeedResult =
	| {
			readonly kind: 'advanced';
			readonly scanned: number;
			readonly captured: number;
			readonly isComplete: boolean;
	  }
	| { readonly kind: 'complete' | 'stale' | 'unavailable' };

/**
Schedules adoption for facts that precede live capture. Projection rows and
events do not grant cache authority.
*/
export class ListingAdoptionFactSeedStore {
	constructor(private readonly database: DrizzleD1Database<typeof schema>) {}

	private readyQuery() {
		const state = schema.listingAdoptionCaptureState;
		return this.database
			.select({ id: state.id })
			.from(state)
			.where(and(eq(state.id, 1), eq(state.isReady, true)));
	}

	private stateQuery() {
		return this.database
			.select()
			.from(schema.listingAdoptionFactSeed)
			.where(eq(schema.listingAdoptionFactSeed.id, 1));
	}

	private async checkpoint(): Promise<Checkpoint | undefined> {
		const stored = await this.stateQuery().get();
		if (stored !== undefined) {
			return stored;
		}
		const fact = schema.listingFact;
		const boundary = this.database
			.select({
				narHash: fact.narHash,
				generatorRevision: fact.generatorRevision
			})
			.from(fact)
			.orderBy(desc(fact.narHash), desc(fact.generatorRevision))
			.limit(1)
			.as('boundary');
		const source = this.database
			.select({
				id: sql`1`.as('id'),
				epoch: sql`lower(hex(randomblob(16)))`.as('epoch'),
				afterNarHash: sql`NULL`.as('after_nar_hash'),
				afterGeneratorRevision: sql`NULL`.as('after_generator_revision'),
				throughNarHash: boundary.narHash,
				throughGeneratorRevision: boundary.generatorRevision,
				scanned: sql`0`.as('scanned'),
				captured: sql`0`.as('captured'),
				isComplete: isNull(boundary.narHash).as('is_complete'),
				updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as('updated_at')
			})
			.from(sql`(SELECT 1) AS singleton`)
			.leftJoin(boundary, sql`true`)
			.where(exists(this.readyQuery()));
		await this.database
			.insert(schema.listingAdoptionFactSeed)
			.select(source)
			.onConflictDoNothing();
		return this.stateQuery().get();
	}

	private fence(row: Checkpoint) {
		const table = schema.listingAdoptionFactSeed;
		const ready = exists(this.readyQuery());
		return and(
			eq(table.id, 1),
			eq(table.epoch, row.epoch),
			eq(table.isComplete, false),
			row.afterNarHash === null
				? isNull(table.afterNarHash)
				: eq(table.afterNarHash, row.afterNarHash),
			row.afterGeneratorRevision === null
				? isNull(table.afterGeneratorRevision)
				: eq(table.afterGeneratorRevision, row.afterGeneratorRevision),
			row.throughNarHash === null
				? isNull(table.throughNarHash)
				: eq(table.throughNarHash, row.throughNarHash),
			row.throughGeneratorRevision === null
				? isNull(table.throughGeneratorRevision)
				: eq(table.throughGeneratorRevision, row.throughGeneratorRevision),
			ready
		);
	}

	private async enrol(
		row: Checkpoint,
		identities: readonly NarListingIdentity[],
		isComplete: boolean
	): Promise<ListingAdoptionFactSeedResult> {
		if (row.throughNarHash === null || row.throughGeneratorRevision === null) {
			throw new Error('The listing adoption fact seed boundary is missing');
		}
		const next = isComplete
			? {
					narHash: row.throughNarHash,
					generatorRevision: row.throughGeneratorRevision
				}
			: identities.at(-1);
		if (next === undefined) {
			throw new Error('The listing adoption fact seed page cursor is missing');
		}
		const current = this.database
			.select({ one: sql`1` })
			.from(schema.listingAdoptionFactSeed)
			.where(this.fence(row));
		const fact = schema.listingFact;
		const selected = jsonRowList(identities);
		const selectedCondition = selected.matches({
			narHash: fact.narHash,
			generatorRevision: fact.generatorRevision
		});
		const condition = and(selectedCondition, exists(current));
		const projection = this.database
			.select({
				narHash: fact.narHash,
				generatorRevision: fact.generatorRevision,
				digest: fact.digest
			})
			.from(fact)
			.where(condition);
		const events = this.database
			.select({
				id: sql`NULL`.as('id'),
				source:
					sql`json_object('kind','listing','identity',json_object('narHash',${fact.narHash},'generatorRevision',${fact.generatorRevision}))`.as(
						'source'
					),
				createdAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.as('created_at')
			})
			.from(fact)
			.where(condition)
			.orderBy(asc(fact.narHash), asc(fact.generatorRevision));
		const captured = this.database
			.select({ count: sql<number>`count(*)` })
			.from(fact)
			.where(selectedCondition);
		const table = schema.listingAdoptionFactSeed;
		const [, appended, checkpoint] = await this.database.batch([
			this.database
				.insert(schema.listingAdoptionFact)
				.select(projection)
				.onConflictDoNothing(),
			this.database
				.insert(schema.listingAdoptionCaptureEvent)
				.select(events)
				.returning({ id: schema.listingAdoptionCaptureEvent.id }),
			this.database
				.update(table)
				.set({
					afterNarHash: next.narHash,
					afterGeneratorRevision: next.generatorRevision,
					scanned: sql`${table.scanned} + ${identities.length}`,
					captured: sql`${table.captured} + (${captured})`,
					isComplete,
					updatedAt: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
				})
				.where(this.fence(row))
				.returning({ id: table.id })
		]);
		if (checkpoint.length === 0) {
			return { kind: 'stale' };
		}
		return {
			kind: 'advanced',
			scanned: identities.length,
			captured: appended.length,
			isComplete
		};
	}

	async advance(): Promise<ListingAdoptionFactSeedResult> {
		try {
			const ready = await this.readyQuery().get();
			if (ready === undefined) {
				return { kind: 'unavailable' };
			}
			const row = await this.checkpoint();
			if (row === undefined) {
				return { kind: 'unavailable' };
			}
			if (row.isComplete) {
				return { kind: 'complete' };
			}
			if (
				row.throughNarHash === null ||
				row.throughGeneratorRevision === null
			) {
				throw new Error('The listing adoption fact seed boundary is missing');
			}
			const fact = schema.listingFact;
			const lower =
				row.afterNarHash === null || row.afterGeneratorRevision === null
					? undefined
					: sql`(${fact.narHash},${fact.generatorRevision}) > (${row.afterNarHash},${row.afterGeneratorRevision})`;
			const upper = sql`(${fact.narHash},${fact.generatorRevision}) <= (${row.throughNarHash},${row.throughGeneratorRevision})`;
			const page = await this.database
				.select({
					narHash: fact.narHash,
					generatorRevision: fact.generatorRevision
				})
				.from(fact)
				.where(and(lower, upper))
				.orderBy(asc(fact.narHash), asc(fact.generatorRevision))
				.limit(pageSize + 1);
			return await this.enrol(
				row,
				page.slice(0, pageSize),
				page.length <= pageSize
			);
		} catch (error) {
			if (error instanceof SharedFactsUnavailableError) {
				throw error;
			}
			throw new SharedFactsUnavailableError(error);
		}
	}
}
