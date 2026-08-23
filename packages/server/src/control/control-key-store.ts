import { type AuthKeyId, authKeyIdSchema } from '@cupboard/nix-store/scalars';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, desc, eq, exists, isNotNull, isNull, lte, ne } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import {
	type AuthPublicKey,
	generateAuthKeyPair,
	scheduledAccessKeyRetireAt
} from '../auth/auth.ts';
import { parseJwk } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { ControlKeyMissingError, LastControlKeyError } from '../errors.ts';

import {
	unwrapControlPrivateJwk,
	wrapControlPrivateJwk
} from './control-key.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

export interface ControlSigningKey {
	readonly kid: AuthKeyId;
	readonly privateJwk: JsonWebKey;
}

export interface ControlKeySummary {
	readonly kid: AuthKeyId;
	readonly retired: boolean;
	readonly scheduledRetireAt?: IsoTimestamp;
}

export interface ControlKeyRotation {
	readonly kid: AuthKeyId;
	readonly retiring?: {
		readonly kid: AuthKeyId;
		readonly scheduledRetireAt: IsoTimestamp;
	};
}

const bootstrapId = 'bootstrap';

// The fixed bootstrap ID makes concurrent initialisation first-writer-wins.
// Losing Workers discard their generated key and use the stored key later.
export async function ensureControlKey(
	database: Database,
	wrappingSecret: string,
	now: IsoTimestamp
): Promise<void> {
	const existing = await database
		.select({ id: d1Schema.controlAuthKey.id })
		.from(d1Schema.controlAuthKey)
		.limit(1)
		.get();

	if (existing !== undefined) {
		return;
	}

	const { privateJwk, publicJwk } = await generateAuthKeyPair();

	await database
		.insert(d1Schema.controlAuthKey)
		.values({
			id: bootstrapId,
			kid: authKeyIdSchema.parse(crypto.randomUUID()),
			publicJwkJson: JSON.stringify(publicJwk),
			wrappedPrivateJwk: await wrapControlPrivateJwk(
				wrappingSecret,
				privateJwk
			),
			createdAt: now
		})
		.onConflictDoNothing()
		.run();
}

/**
 * Loads the newest live key for token issuance and unwraps its private JWK.
 * Callers must initialise the bootstrap key before calling this function.
 */
export async function activeControlKey(
	database: Database,
	wrappingSecret: string
): Promise<ControlSigningKey> {
	const row = await database
		.select()
		.from(d1Schema.controlAuthKey)
		.where(isNull(d1Schema.controlAuthKey.retiredAt))
		.orderBy(
			desc(isNull(d1Schema.controlAuthKey.scheduledRetireAt)),
			desc(d1Schema.controlAuthKey.createdAt),
			desc(d1Schema.controlAuthKey.id)
		)
		.limit(1)
		.get();

	if (row === undefined) {
		throw new ControlKeyMissingError();
	}

	return {
		kid: row.kid,
		privateJwk: await unwrapControlPrivateJwk(
			wrappingSecret,
			row.wrappedPrivateJwk
		)
	};
}

/**
 * Loads the public half of every live key for token verification. This path
 * does not unwrap or return private key material.
 */
export async function controlVerificationKeys(
	database: Database
): Promise<AuthPublicKey[]> {
	const rows = await database
		.select({
			kid: d1Schema.controlAuthKey.kid,
			publicJwkJson: d1Schema.controlAuthKey.publicJwkJson
		})
		.from(d1Schema.controlAuthKey)
		.where(isNull(d1Schema.controlAuthKey.retiredAt))
		.all();

	return rows.map((row) => ({
		kid: row.kid,
		publicJwk: parseJwk(row.publicJwkJson)
	}));
}

/**
Returns live and retired control keys in creation order.
*/
export async function controlKeySummaries(
	database: Database
): Promise<ControlKeySummary[]> {
	const rows = await database
		.select({
			kid: d1Schema.controlAuthKey.kid,
			retiredAt: d1Schema.controlAuthKey.retiredAt,
			scheduledRetireAt: d1Schema.controlAuthKey.scheduledRetireAt
		})
		.from(d1Schema.controlAuthKey)
		.orderBy(d1Schema.controlAuthKey.createdAt, d1Schema.controlAuthKey.id)
		.all();

	return rows.map((row) => {
		const scheduledRetireAt = row.scheduledRetireAt ?? undefined;

		return {
			kid: row.kid,
			retired: row.retiredAt !== null,
			...(scheduledRetireAt !== undefined && { scheduledRetireAt })
		};
	});
}

// Keep the outgoing key live until its scheduled retirement so existing tokens
// continue to verify.
export async function rotateControlKey(
	database: Database,
	wrappingSecret: string,
	now: IsoTimestamp
): Promise<ControlKeyRotation> {
	const outgoing = await activeControlKey(database, wrappingSecret);
	const { privateJwk, publicJwk } = await generateAuthKeyPair();
	const kid = authKeyIdSchema.parse(crypto.randomUUID());
	const scheduledRetireAt = scheduledAccessKeyRetireAt(new Date(now));

	await database.batch([
		database
			.update(d1Schema.controlAuthKey)
			.set({ scheduledRetireAt })
			.where(eq(d1Schema.controlAuthKey.kid, outgoing.kid)),
		database.insert(d1Schema.controlAuthKey).values({
			id: crypto.randomUUID(),
			kid,
			publicJwkJson: JSON.stringify(publicJwk),
			wrappedPrivateJwk: await wrapControlPrivateJwk(
				wrappingSecret,
				privateJwk
			),
			createdAt: now
		})
	]);

	return { kid, retiring: { kid: outgoing.kid, scheduledRetireAt } };
}

// Guard retirement in one statement. Separate reads and writes could let two
// concurrent calls each observe another live key and retire both. D1 serialises
// the guarded writes, so the second call cannot remove the last key.
export async function didRetireControlKey(
	database: Database,
	kid: AuthKeyId,
	now: IsoTimestamp
): Promise<boolean> {
	const anotherLiveKey = database
		.select({ kid: d1Schema.controlAuthKey.kid })
		.from(d1Schema.controlAuthKey)
		.where(
			and(
				isNull(d1Schema.controlAuthKey.retiredAt),
				ne(d1Schema.controlAuthKey.kid, kid)
			)
		);
	const result = await database
		.update(d1Schema.controlAuthKey)
		.set({ retiredAt: now })
		.where(
			and(
				eq(d1Schema.controlAuthKey.kid, kid),
				isNull(d1Schema.controlAuthKey.retiredAt),
				exists(anotherLiveKey)
			)
		)
		.run();

	if (result.meta.changes > 0) {
		return true;
	}

	// Distinguish an idempotent no-op from refusal to retire the last live key.
	const stillLive = await database
		.select({ kid: d1Schema.controlAuthKey.kid })
		.from(d1Schema.controlAuthKey)
		.where(
			and(
				eq(d1Schema.controlAuthKey.kid, kid),
				isNull(d1Schema.controlAuthKey.retiredAt)
			)
		)
		.get();

	if (stillLive !== undefined) {
		throw new LastControlKeyError(kid);
	}

	return false;
}

export async function retireScheduledControlKeys(
	database: Database,
	now: IsoTimestamp
): Promise<number> {
	const due = await database
		.select({ kid: d1Schema.controlAuthKey.kid })
		.from(d1Schema.controlAuthKey)
		.where(
			and(
				isNull(d1Schema.controlAuthKey.retiredAt),
				isNotNull(d1Schema.controlAuthKey.scheduledRetireAt),
				lte(d1Schema.controlAuthKey.scheduledRetireAt, now)
			)
		)
		.orderBy(
			d1Schema.controlAuthKey.scheduledRetireAt,
			d1Schema.controlAuthKey.createdAt
		)
		.all();
	let retired = 0;

	for (const key of due) {
		try {
			if (await didRetireControlKey(database, key.kid, now)) {
				retired += 1;
			}
		} catch (error) {
			if (error instanceof LastControlKeyError) {
				continue;
			}

			throw error;
		}
	}

	return retired;
}
