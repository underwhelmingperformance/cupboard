import { type Sha256HexDigest } from '@cupboard/nix-store/scalars';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, ne, notExists, type SQL, sql } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';

import {
	promotableStateIncarnation,
	registeredLiveObjectIncarnation
} from './object-incarnation.ts';

interface CasObjectState {
	readonly digest: Sha256HexDigest;
	readonly size: number;
	readonly incarnation: number;
	readonly storedAt: IsoTimestamp;
}

/**
 * Publishes state for a live CAS incarnation through physical storage or a
 * writable migration view. A newer state row is never replaced.
 */
export async function publishCasObjectState(
	database: DrizzleD1Database<typeof d1Schema>,
	state: CasObjectState
): Promise<void> {
	const live = registeredLiveObjectIncarnation(
		database,
		'cas',
		state.digest,
		state.incarnation
	);
	const update = database
		.update(d1Schema.casObject)
		.set({
			size: state.size,
			incarnation: state.incarnation,
			storedAt: state.storedAt,
			deleteAfter: sql`null`
		})
		.where(
			and(
				eq(d1Schema.casObject.digest, state.digest),
				promotableStateIncarnation(
					d1Schema.casObject.incarnation,
					state.incarnation
				),
				live
			)
		);
	const existing = database
		.select({ one: sql`1` })
		.from(d1Schema.casObject)
		.where(eq(d1Schema.casObject.digest, state.digest));
	const missingLiveState = database
		.select({
			digest: sql<Sha256HexDigest>`${state.digest}`.as('digest'),
			size: sql<number>`${state.size}`.as('size'),
			incarnation: sql<number>`${state.incarnation}`.as('incarnation'),
			storedAt: sql<IsoTimestamp>`${state.storedAt}`.as('stored_at'),
			deleteAfter: sql`null`.as('delete_after')
		})
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, 'cas'),
				eq(d1Schema.objectIncarnation.objectId, state.digest),
				eq(d1Schema.objectIncarnation.incarnation, state.incarnation),
				eq(d1Schema.objectIncarnation.state, 'live'),
				notExists(existing)
			)
		);
	const insert = database.insert(d1Schema.casObject).select(missingLiveState);

	await database.batch([update, insert]);
}

/**
 * Refuses a captured missing-object removal after repair advances either the
 * registry or its published state. The registry can advance before state does.
 */
export function casObjectNotRepromoted(
	database: DrizzleD1Database<typeof d1Schema>,
	digest: Sha256HexDigest,
	incarnation: number | undefined
): SQL | undefined {
	if (incarnation === undefined) {
		return undefined;
	}

	const newerState = and(
		eq(d1Schema.casObject.digest, digest),
		ne(d1Schema.casObject.incarnation, incarnation)
	);
	const newerRegistry = and(
		eq(d1Schema.objectIncarnation.kind, 'cas'),
		eq(d1Schema.objectIncarnation.objectId, digest),
		ne(d1Schema.objectIncarnation.incarnation, incarnation)
	);

	return and(
		notExists(
			database
				.select({ one: sql`1` })
				.from(d1Schema.casObject)
				.where(newerState)
		),
		notExists(
			database
				.select({ one: sql`1` })
				.from(d1Schema.objectIncarnation)
				.where(newerRegistry)
		)
	);
}
