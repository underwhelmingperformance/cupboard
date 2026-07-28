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

// The key that currently issues control tokens: its kid and unwrapped private JWK.
export interface ControlSigningKey {
	readonly kid: AuthKeyId;
	readonly privateJwk: JsonWebKey;
}

// A control key as the admin surface sees it: its kid and whether it is retired.
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

// Ensures a control signing key exists, creating the first one if the set is
// empty. First-writer-wins on a fixed bootstrap id, so concurrent Workers racing
// the first request settle on a single key (the
// loser's generated key is simply discarded).
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

// The key that currently issues: the newest non-retired key, with its private JWK
// unwrapped. Throws if none exists, so callers run {@link ensureControlKey} first.
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

// Every key that still verifies a control token, public part only: the control
// JWKS. No unwrap is needed, so the wrapping secret is not required here.
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

// Every control key, retired or not, for the admin surface to inspect before
// rotating or retiring.
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

// Adds a new control key that becomes the issuing key, leaving the existing keys
// live so tokens they already signed keep verifying until those keys are retired.
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

// Retires a control key so it no longer verifies, returning whether it actually
// retired one: `false` means the key was already retired or absent (an idempotent
// no-op). Retiring the last live key is refused, since it would leave no key able
// to verify outstanding control tokens.
//
// The refusal is a single guarded statement (a read-then-write would be unsafe): a
// count-then-update would let two concurrent retirements of different keys each
// observe two live keys and both proceed, draining the set to zero. The guard
// requires that *another* live key still exists, evaluated within the statement,
// and D1 serialises writers, so the second retirement re-reads the reduced set
// and changes nothing.
export async function retireControlKey(
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

	// No row changed: the key was already retired or absent (an idempotent no-op),
	// or it is the last live key and the guard refused it. A read tells them apart.
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
			if (await retireControlKey(database, key.kid, now)) {
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
