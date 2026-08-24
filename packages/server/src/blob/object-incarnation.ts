import {
	nixSha256HashSchema,
	type NixSha256HashString,
	type Sha256HexDigest,
	sha256HexDigestSchema
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	eq,
	exists,
	inArray,
	isNull,
	lte,
	type SQL,
	sql,
	type SQLWrapper
} from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { blobReaperGraceMs } from '../http/http.ts';

export type SharedObjectKind = 'nar' | 'cas';

export interface ObjectIncarnation {
	readonly incarnation: number;
	readonly state: 'pending' | 'live';
}

// Incarnation one identifies objects written before the registry existed. A
// new registry row must start above it because the corresponding `blob_state`
// or `cas_object` row may already have been deleted while a response for the
// old immutable key remains cached.
export const firstVersionedObjectIncarnation = 2;

// An older Queue Consumer can publish during its 15-minute wall-time allowance.
// Keep that object's immutable URL available for a full narinfo cache grace
// after the old invocation must have ended.
export const lateWriteTombstoneHorizonMs = 16 * 60 * 1000 + blobReaperGraceMs;

/**
 * Returns a predicate that matches the live registry row for an incarnation.
 */
export function registeredLiveObjectIncarnation(
	database: DrizzleD1Database<typeof d1Schema>,
	kind: SharedObjectKind,
	objectId: string | SQLWrapper,
	incarnation: number | SQLWrapper
): SQL {
	const identity = and(
		eq(d1Schema.objectIncarnation.kind, kind),
		eq(d1Schema.objectIncarnation.objectId, objectId),
		eq(d1Schema.objectIncarnation.incarnation, incarnation),
		eq(d1Schema.objectIncarnation.state, 'live')
	);
	const registryRow = database
		.select({ one: sql`1` })
		.from(d1Schema.objectIncarnation)
		.where(identity);

	return exists(registryRow);
}

/**
 * Allows an upsert to retain its incarnation or advance an older state row to
 * the reserved incarnation. It never permits a version rollback.
 */
export function promotableStateIncarnation(
	current: SQLWrapper,
	target: number
): SQL | undefined {
	return lte(current, target);
}

/**
 * Reports whether the registry and object-state tables identify the same live
 * incarnation.
 */
export async function isObjectIncarnationLive(
	database: DrizzleD1Database<typeof d1Schema>,
	kind: SharedObjectKind,
	objectId: string,
	incarnation: number
): Promise<boolean> {
	let stateRow: SQLWrapper;

	if (kind === 'nar') {
		const identity = and(
			eq(d1Schema.blobState.narHash, nixSha256HashSchema.parse(objectId)),
			eq(d1Schema.blobState.incarnation, incarnation)
		);
		stateRow = database
			.select({ one: sql`1` })
			.from(d1Schema.blobState)
			.where(identity);
	} else {
		const identity = and(
			eq(d1Schema.casObject.digest, sha256HexDigestSchema.parse(objectId)),
			eq(d1Schema.casObject.incarnation, incarnation)
		);
		stateRow = database
			.select({ one: sql`1` })
			.from(d1Schema.casObject)
			.where(identity);
	}
	const stateMatches = exists(stateRow);

	const liveIdentity = and(
		eq(d1Schema.objectIncarnation.kind, kind),
		eq(d1Schema.objectIncarnation.objectId, objectId),
		eq(d1Schema.objectIncarnation.incarnation, incarnation),
		eq(d1Schema.objectIncarnation.state, 'live'),
		stateMatches
	);
	const [row] = await database
		.select({ one: sql`1` })
		.from(d1Schema.objectIncarnation)
		.where(liveIdentity);

	return row !== undefined;
}

type LegacyObjectIncarnations =
	| {
			readonly kind: 'nar';
			readonly objectIds: readonly NixSha256HashString[];
	  }
	| {
			readonly kind: 'cas';
			readonly objectIds: readonly Sha256HexDigest[];
	  };

/**
 * Registers incarnation-one rows that an older Worker wrote after the registry
 * migration had finished. A current registry row always wins the conflict.
 */
export async function registerLegacyObjectIncarnations(
	database: DrizzleD1Database<typeof d1Schema>,
	objects: LegacyObjectIncarnations,
	updatedAt: IsoTimestamp
): Promise<void> {
	if (objects.objectIds.length === 0) {
		return;
	}

	if (objects.kind === 'nar') {
		const legacyRows = and(
			inArray(d1Schema.blobState.narHash, objects.objectIds),
			eq(d1Schema.blobState.incarnation, 1)
		);
		const rows = database
			.select({
				kind: sql<SharedObjectKind>`'nar'`.as('kind'),
				objectId: d1Schema.blobState.narHash,
				incarnation: d1Schema.blobState.incarnation,
				state: sql<'live'>`'live'`.as('state'),
				reservationOwner: sql<string | null>`null`.as('reservation_owner'),
				updatedAt: sql<IsoTimestamp>`${updatedAt}`.as('updated_at')
			})
			.from(d1Schema.blobState)
			.where(legacyRows);

		await database
			.insert(d1Schema.objectIncarnation)
			.select(rows)
			.onConflictDoNothing();

		return;
	}

	const legacyRows = and(
		inArray(d1Schema.casObject.digest, objects.objectIds),
		eq(d1Schema.casObject.incarnation, 1)
	);
	const rows = database
		.select({
			kind: sql<SharedObjectKind>`'cas'`.as('kind'),
			objectId: d1Schema.casObject.digest,
			incarnation: d1Schema.casObject.incarnation,
			state: sql<'live'>`'live'`.as('state'),
			reservationOwner: sql<string | null>`null`.as('reservation_owner'),
			updatedAt: sql<IsoTimestamp>`${updatedAt}`.as('updated_at')
		})
		.from(d1Schema.casObject)
		.where(legacyRows);

	await database
		.insert(d1Schema.objectIncarnation)
		.select(rows)
		.onConflictDoNothing();
}

function immediateRemovalDeadline(now: Date = new Date()): IsoTimestamp {
	return isoTimestamp(now);
}

function lateWriteRemovalDeadline(now: Date): IsoTimestamp {
	return isoTimestamp(new Date(now.getTime() + lateWriteTombstoneHorizonMs));
}

/**
 * Records an exact physical incarnation for the deletion retry pass.
 */
export async function queueObjectDeletion(
	database: DrizzleD1Database<typeof d1Schema>,
	kind: SharedObjectKind,
	objectId: string,
	incarnation: number,
	removalDeadline: IsoTimestamp = immediateRemovalDeadline()
): Promise<void> {
	await database
		.insert(d1Schema.objectDeletion)
		.values({
			kind,
			objectId,
			incarnation,
			removeAfter: removalDeadline
		})
		.onConflictDoNothing();
}

/**
 * Returns the current incarnation, reserving a greater one when the previous
 * object is absent. D1 serialises the conditional update, so concurrent
 * promoters share one pending incarnation.
 */
export async function reserveObjectIncarnation(
	database: DrizzleD1Database<typeof d1Schema>,
	kind: SharedObjectKind,
	objectId: string,
	reservationOwner?: string
): Promise<ObjectIncarnation> {
	const updatedAt = isoTimestamp(new Date());
	const replacementRemoveAfter = lateWriteRemovalDeadline(new Date(updatedAt));
	const identityFilter = and(
		eq(d1Schema.objectIncarnation.kind, kind),
		eq(d1Schema.objectIncarnation.objectId, objectId)
	);

	for (;;) {
		const [reserved] = await database
			.update(d1Schema.objectIncarnation)
			.set({
				incarnation: sql`${d1Schema.objectIncarnation.incarnation} + 1`,
				state: 'pending',
				reservationOwner: reservationOwner ?? sql`null`,
				updatedAt
			})
			.where(
				and(identityFilter, eq(d1Schema.objectIncarnation.state, 'absent'))
			)
			.returning({
				incarnation: d1Schema.objectIncarnation.incarnation,
				state: d1Schema.objectIncarnation.state
			});

		if (reserved !== undefined) {
			return { incarnation: reserved.incarnation, state: 'pending' };
		}

		const insert = database
			.insert(d1Schema.objectIncarnation)
			.values({
				kind,
				objectId,
				incarnation: firstVersionedObjectIncarnation,
				state: 'pending',
				reservationOwner,
				updatedAt
			})
			.onConflictDoNothing()
			.returning({
				incarnation: d1Schema.objectIncarnation.incarnation,
				state: d1Schema.objectIncarnation.state
			});
		const insertedIdentity = and(
			identityFilter,
			eq(
				d1Schema.objectIncarnation.incarnation,
				firstVersionedObjectIncarnation
			)
		);
		const queueLegacy = database
			.insert(d1Schema.objectDeletion)
			.select(
				database
					.select({
						kind: d1Schema.objectIncarnation.kind,
						objectId: d1Schema.objectIncarnation.objectId,
						incarnation: sql<number>`1`.as('incarnation'),
						removeAfter: sql<
							typeof replacementRemoveAfter
						>`${replacementRemoveAfter}`.as('remove_after')
					})
					.from(d1Schema.objectIncarnation)
					.where(insertedIdentity)
			)
			.onConflictDoUpdate({
				target: [
					d1Schema.objectDeletion.kind,
					d1Schema.objectDeletion.objectId,
					d1Schema.objectDeletion.incarnation
				],
				set: {
					removeAfter: sql`max(${d1Schema.objectDeletion.removeAfter}, excluded.remove_after)`
				}
			});
		const [insertedRows] = await database.batch([insert, queueLegacy]);
		const inserted = insertedRows.at(0);

		if (inserted !== undefined) {
			return { incarnation: inserted.incarnation, state: 'pending' };
		}

		const [current] = await database
			.select({
				incarnation: d1Schema.objectIncarnation.incarnation,
				state: d1Schema.objectIncarnation.state,
				reservationOwner: d1Schema.objectIncarnation.reservationOwner
			})
			.from(d1Schema.objectIncarnation)
			.where(identityFilter);

		if (
			reservationOwner !== undefined &&
			current?.state === 'pending' &&
			current.reservationOwner !== reservationOwner
		) {
			const replace = database
				.update(d1Schema.objectIncarnation)
				.set({
					incarnation: sql`${d1Schema.objectIncarnation.incarnation} + 1`,
					reservationOwner,
					updatedAt
				})
				.where(
					and(
						identityFilter,
						eq(d1Schema.objectIncarnation.incarnation, current.incarnation),
						eq(d1Schema.objectIncarnation.state, 'pending'),
						current.reservationOwner === null
							? sql`${d1Schema.objectIncarnation.reservationOwner} is null`
							: eq(
									d1Schema.objectIncarnation.reservationOwner,
									current.reservationOwner
								)
					)
				)
				.returning({
					incarnation: d1Schema.objectIncarnation.incarnation,
					state: d1Schema.objectIncarnation.state
				});
			const replacementFilter = and(
				identityFilter,
				eq(d1Schema.objectIncarnation.incarnation, current.incarnation + 1),
				eq(d1Schema.objectIncarnation.reservationOwner, reservationOwner)
			);
			const superseded = database
				.select({
					kind: sql<SharedObjectKind>`${kind}`.as('kind'),
					objectId: sql<string>`${objectId}`.as('object_id'),
					incarnation: sql<number>`${current.incarnation}`.as('incarnation'),
					removeAfter: sql<
						typeof replacementRemoveAfter
					>`${replacementRemoveAfter}`.as('remove_after')
				})
				.from(d1Schema.objectIncarnation)
				.where(replacementFilter);
			const queueSuperseded = database
				.insert(d1Schema.objectDeletion)
				.select(superseded)
				.onConflictDoUpdate({
					target: [
						d1Schema.objectDeletion.kind,
						d1Schema.objectDeletion.objectId,
						d1Schema.objectDeletion.incarnation
					],
					set: {
						removeAfter: sql`max(${d1Schema.objectDeletion.removeAfter}, excluded.remove_after)`
					}
				});
			const [replacedRows] = await database.batch([replace, queueSuperseded]);
			const replaced = replacedRows.at(0);

			if (replaced !== undefined) {
				return { incarnation: replaced.incarnation, state: 'pending' };
			}

			continue;
		}

		if (current !== undefined && current.state !== 'absent') {
			const [refreshed] = await database
				.update(d1Schema.objectIncarnation)
				.set({
					updatedAt,
					...(current.state === 'pending' && { reservationOwner })
				})
				.where(
					and(
						identityFilter,
						eq(d1Schema.objectIncarnation.incarnation, current.incarnation),
						eq(d1Schema.objectIncarnation.state, current.state)
					)
				)
				.returning({
					incarnation: d1Schema.objectIncarnation.incarnation,
					state: d1Schema.objectIncarnation.state
				});

			if (refreshed !== undefined && refreshed.state !== 'absent') {
				return {
					incarnation: refreshed.incarnation,
					state: refreshed.state
				};
			}
		}
	}
}

export async function activateObjectIncarnation(
	database: DrizzleD1Database<typeof d1Schema>,
	kind: SharedObjectKind,
	objectId: string,
	incarnation: number,
	reservationOwner?: string
): Promise<'live' | 'retired'> {
	const updatedAt = isoTimestamp(new Date());
	const [row] = await database
		.update(d1Schema.objectIncarnation)
		.set({ state: 'live', reservationOwner: sql`null`, updatedAt })
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, kind),
				eq(d1Schema.objectIncarnation.objectId, objectId),
				eq(d1Schema.objectIncarnation.incarnation, incarnation),
				eq(d1Schema.objectIncarnation.state, 'pending'),
				reservationOwner === undefined
					? isNull(d1Schema.objectIncarnation.reservationOwner)
					: eq(d1Schema.objectIncarnation.reservationOwner, reservationOwner)
			)
		)
		.returning({ state: d1Schema.objectIncarnation.state });

	if (row !== undefined) {
		return 'live';
	}

	const [current] = await database
		.select({ state: d1Schema.objectIncarnation.state })
		.from(d1Schema.objectIncarnation)
		.where(
			and(
				eq(d1Schema.objectIncarnation.kind, kind),
				eq(d1Schema.objectIncarnation.objectId, objectId),
				eq(d1Schema.objectIncarnation.incarnation, incarnation)
			)
		);

	return current?.state === 'live' ? 'live' : 'retired';
}
