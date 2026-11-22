import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type RefreshSessionId,
	refreshSessionIdSchema,
	type TenantSessionListResponse,
	type TenantSessionRevokeResponse,
	type TenantSessionSummary
} from '@cupboard/protocol/sessions';
import { and, eq, exists, gt, isNull, type SQL, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import {
	countAccessKeysBelow,
	deleteAccessKeysBelow
} from './access-key-store.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';

type RefreshTokenFamily = typeof schema.refreshTokenFamilies.$inferSelect;

/**
Whether this call deleted the family row, and how many access keys below the
session a revocation deleted.
*/
interface RefreshFamilyDeletion {
	readonly family: 'deleted' | 'absent';
	readonly deletedAccessKeys: number;
}

/**
Why a refresh family is removed. `revocation` is `session:revoke`, and also
deletes the access keys below the session. `ending` is a logout, an expiry,
the member limit or a change of policy. It leaves those keys, and it leaves
the row of a family that a replay has ended, so that `session list` still
shows that session. A replayed refresh token does not remove the family: see
{@link markFamilyReplayed}.
*/
export type RefreshFamilyRemoval = 'revocation' | 'ending';

export function deleteRefreshFamily(
	database: SchemaWriter,
	familyId: RefreshSessionId,
	removal: RefreshFamilyRemoval
): RefreshFamilyDeletion {
	const deletedAccessKeys =
		removal === 'revocation'
			? deleteAccessKeysBelow(database, { kind: 'session', id: familyId })
			: 0;

	database
		.delete(schema.refreshTokenMembers)
		.where(eq(schema.refreshTokenMembers.familyId, familyId))
		.run();

	const family = eq(schema.refreshTokenFamilies.id, familyId);
	const deleted = database
		.delete(schema.refreshTokenFamilies)
		.where(
			removal === 'ending'
				? and(family, isNull(schema.refreshTokenFamilies.replayedAt))
				: family
		)
		.returning({ id: schema.refreshTokenFamilies.id })
		.all();

	return {
		family: deleted.length > 0 ? 'deleted' : 'absent',
		deletedAccessKeys
	};
}

/**
Ends a family whose refresh token was replayed, at `now`. The members are
deleted, so no refresh token of the family authenticates again. The family row
remains with `replayed_at` set, so that `session list` shows the session and
`session revoke` can delete it with the access keys below it. A second
detection keeps the first `replayed_at`.

The generation advances, so a rotation that read the family before the replay
fails its compare-and-set. `retained_by_keys` records whether keys remain
below the session. Collection keeps the row while they do, and deletes it once
the family has expired and no key remains below it.
*/
export function markFamilyReplayed(
	database: SchemaWriter,
	familyId: RefreshSessionId,
	now: IsoTimestamp
): void {
	database
		.delete(schema.refreshTokenMembers)
		.where(eq(schema.refreshTokenMembers.familyId, familyId))
		.run();
	database
		.update(schema.refreshTokenFamilies)
		.set({
			replayedAt: sql`coalesce(${schema.refreshTokenFamilies.replayedAt}, ${now})`,
			generation: sql`${schema.refreshTokenFamilies.generation} + 1`,
			retainedByKeys: sql`${exists(keysBelowSession(database, familyId))}`
		})
		.where(eq(schema.refreshTokenFamilies.id, familyId))
		.run();
}

/**
Whether collection may delete an expired family. A family that a replay ended
while access keys remain below it is retained, so that `session list` still
shows it. The condition matches the partial index
`refresh_session_family_collectable_idx`, so collection and maintenance never
read retained families.
*/
export function collectableFamilyCondition(): SQL {
	return sql`${schema.refreshTokenFamilies.retainedByKeys} = 0`;
}

function keysBelowSession(database: SchemaWriter, familyId: string) {
	return database
		.select({ id: schema.accessKeyAncestors.descendantId })
		.from(schema.accessKeyAncestors)
		.where(
			and(
				eq(schema.accessKeyAncestors.ancestorKind, 'session'),
				eq(schema.accessKeyAncestors.ancestorId, familyId)
			)
		);
}

export class RefreshSessionsService {
	constructor(private readonly context: ServerContext) {}

	/**
	Lists the unexpired sessions, and the sessions that a replay ended while
	access keys remain below them, with the number of keys below each one.
	*/
	list(): TenantSessionListResponse {
		const now = isoTimestamp(new Date());
		// SQLite reads an OR of the two conditions with a scan of the table, so
		// each condition is a query of its own on its partial index.
		const unexpired = this.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.where(
				and(
					collectableFamilyCondition(),
					gt(schema.refreshTokenFamilies.expiresAt, now)
				)
			)
			.all();
		const retained = this.context.db
			.select()
			.from(schema.refreshTokenFamilies)
			.where(sql`${schema.refreshTokenFamilies.retainedByKeys} = 1`)
			.all();
		const families = [...unexpired, ...retained].toSorted(
			(left, right) =>
				byCodeUnit(left.createdAt, right.createdAt) ||
				byCodeUnit(left.id, right.id)
		);

		return {
			sessions: families.map((family) =>
				sessionSummary(
					family,
					countAccessKeysBelow(this.context.db, {
						kind: 'session',
						id: refreshSessionIdSchema.parse(family.id)
					})
				)
			)
		};
	}

	revoke(id: RefreshSessionId): TenantSessionRevokeResponse {
		const { family, deletedAccessKeys } = this.context.db.transaction(
			(transaction) => deleteRefreshFamily(transaction, id, 'revocation')
		);

		return {
			id,
			revoked: family === 'deleted' || deletedAccessKeys > 0,
			deletedAccessKeys
		};
	}
}

function sessionSummary(
	family: RefreshTokenFamily,
	accessKeysBelow: number
): TenantSessionSummary {
	return {
		id: refreshSessionIdSchema.parse(family.id),
		...(family.issuer !== null && { issuer: family.issuer }),
		...(family.subject !== null && { subject: family.subject }),
		...(family.rule !== null && { rule: family.rule }),
		createdAt: family.createdAt,
		expiresAt: family.expiresAt,
		accessKeysBelow,
		...(family.replayedAt !== null && { replayedAt: family.replayedAt })
	};
}
