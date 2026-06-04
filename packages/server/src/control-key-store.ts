import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

import { type AuthPublicKey, generateAuthKeyPair } from './auth.ts';
import {
	unwrapControlPrivateJwk,
	wrapControlPrivateJwk
} from './control-key.ts';
import * as d1Schema from './db/d1-schema.ts';
import { ControlKeyMissingError, LastControlKeyError } from './errors.ts';

type Database = DrizzleD1Database<typeof d1Schema>;

// The key that currently mints control tokens: its kid and unwrapped private JWK.
export interface ControlSigningKey {
	readonly kid: string;
	readonly privateJwk: JsonWebKey;
}

const bootstrapId = 'bootstrap';

// Ensures a control signing key exists, creating the first one if the set is
// empty. First-writer-wins on a fixed bootstrap id, so concurrent Workers racing
// the first request settle on a single key rather than each minting their own (the
// loser's generated key is simply discarded).
export async function ensureControlKey(
	database: Database,
	wrappingSecret: string,
	now: string
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
			kid: crypto.randomUUID(),
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

// The key that currently mints: the newest non-retired key, with its private JWK
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

// Every key that still verifies a control token, public part only — the control
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
		publicJwk: JSON.parse(row.publicJwkJson) as JsonWebKey
	}));
}

// Adds a new control key that becomes the minting key, leaving the existing keys
// live so tokens they already signed keep verifying until those keys are retired.
export async function rotateControlKey(
	database: Database,
	wrappingSecret: string,
	now: string
): Promise<string> {
	const { privateJwk, publicJwk } = await generateAuthKeyPair();
	const kid = crypto.randomUUID();

	await database
		.insert(d1Schema.controlAuthKey)
		.values({
			id: crypto.randomUUID(),
			kid,
			publicJwkJson: JSON.stringify(publicJwk),
			wrappedPrivateJwk: await wrapControlPrivateJwk(
				wrappingSecret,
				privateJwk
			),
			createdAt: now
		})
		.run();

	return kid;
}

// Retires a control key so it no longer verifies. Retiring a key that is already
// retired or absent is an idempotent no-op; retiring the last live key is refused,
// since it would leave no key able to verify outstanding control tokens.
export async function retireControlKey(
	database: Database,
	kid: string,
	now: string
): Promise<void> {
	const live = await database
		.select({ kid: d1Schema.controlAuthKey.kid })
		.from(d1Schema.controlAuthKey)
		.where(isNull(d1Schema.controlAuthKey.retiredAt))
		.all();

	if (!live.some((key) => key.kid === kid)) {
		return;
	}

	if (live.length <= 1) {
		throw new LastControlKeyError(kid);
	}

	await database
		.update(d1Schema.controlAuthKey)
		.set({ retiredAt: now })
		.where(
			and(
				eq(d1Schema.controlAuthKey.kid, kid),
				isNull(d1Schema.controlAuthKey.retiredAt)
			)
		)
		.run();
}
