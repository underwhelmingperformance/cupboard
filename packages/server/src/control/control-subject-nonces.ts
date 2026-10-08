import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { asc, inArray, lte } from 'drizzle-orm';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import { SubjectTokenReplayedError } from '../errors.ts';
import { type SubjectNonce } from '../oidc/subject-binding.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

const nonces = d1Schema.controlConsumedSubjectNonce;

export const controlSubjectNoncePrunePageSize = 1000;

/**
 * Returns the statement that records `nonce` as consumed. It inserts nothing
 * when the nonce is already recorded, and returns the inserted row. `familyId`
 * identifies the refresh family that the same batch creates, so the batch's
 * later statements can check that this statement inserted the row.
 */
export function consumeControlSubjectNonce(
	database: Database,
	nonce: SubjectNonce,
	familyId?: string
) {
	return database
		.insert(nonces)
		.values({
			nonce: nonce.nonce,
			expiresAt: nonce.expiresAt,
			...(familyId !== undefined && { familyId })
		})
		.onConflictDoNothing()
		.returning({ nonce: nonces.nonce });
}

export async function recordControlSubjectNonce(
	database: Database,
	nonce: SubjectNonce
): Promise<void> {
	const inserted = await consumeControlSubjectNonce(database, nonce);

	if (inserted.length === 0) {
		throw new SubjectTokenReplayedError();
	}
}

export async function pruneControlSubjectNonces(
	database: Database,
	now: IsoTimestamp
): Promise<number> {
	const expired = database
		.select({ nonce: nonces.nonce })
		.from(nonces)
		.where(lte(nonces.expiresAt, now))
		.orderBy(asc(nonces.expiresAt))
		.limit(controlSubjectNoncePrunePageSize);
	const deleted = await database
		.delete(nonces)
		.where(inArray(nonces.nonce, expired))
		.returning({ nonce: nonces.nonce });

	return deleted.length;
}
