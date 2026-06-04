import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import { mintAccessJwt, verifyAccessJwt } from './auth.ts';
import {
	activeControlKey,
	controlVerificationKeys,
	ensureControlKey,
	retireControlKey,
	rotateControlKey
} from './control-key-store.ts';
import * as d1Schema from './db/d1-schema.ts';
import { LastControlKeyError } from './errors.ts';

const secret = btoa(String.fromCodePoint(...new Uint8Array(32).fill(7)));
const issuer = 'https://cupboard.test';
const audience = 'cupboard-control';
const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-01-01T00:01:00.000Z';
const t2 = '2026-01-01T00:02:00.000Z';
const now = new Date(t0);

function controlDatabase(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

describe('control key store', () => {
	it('bootstraps a single key and mints a token verifiable against its JWKS', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		// A second call is a first-writer-wins no-op, not a second key.
		await ensureControlKey(database, secret, t0);

		const verificationKeys = await controlVerificationKeys(database);
		const active = await activeControlKey(database, secret);
		const token = await mintAccessJwt(
			active.privateJwk,
			{
				issuer,
				audience,
				subject: 'admin',
				scope: 'admin',
				kid: active.kid,
				ttlSeconds: 600
			},
			now
		);
		const claims = await verifyAccessJwt(
			verificationKeys,
			token,
			{ issuer, audience },
			now
		);

		expect({
			keyCount: verificationKeys.length,
			activeIsPublished: verificationKeys.some((key) => key.kid === active.kid),
			claims
		}).toStrictEqual({
			keyCount: 1,
			activeIsPublished: true,
			claims: { scope: 'admin', subject: 'admin' }
		});
	});

	it('rotates to a new minting key while the old key keeps verifying', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		const firstActive = await activeControlKey(database, secret);
		const firstKid = firstActive.kid;
		const secondKid = await rotateControlKey(database, secret, t1);
		const active = await activeControlKey(database, secret);
		const verificationKeys = await controlVerificationKeys(database);
		const publishedKids = verificationKeys.map((key) => key.kid).toSorted();

		expect({
			activeKid: active.kid,
			rotated: secondKid !== firstKid,
			publishedKids
		}).toStrictEqual({
			activeKid: secondKid,
			rotated: true,
			publishedKids: [firstKid, secondKid].toSorted()
		});
	});

	it('retires a key and refuses to retire the last live key', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		const firstActive = await activeControlKey(database, secret);
		const firstKid = firstActive.kid;
		const secondKid = await rotateControlKey(database, secret, t1);

		await retireControlKey(database, firstKid, t2);

		const verificationKeys = await controlVerificationKeys(database);
		const remaining = verificationKeys.map((key) => key.kid);
		const activeAfter = await activeControlKey(database, secret);

		expect({ remaining, activeAfter: activeAfter.kid }).toStrictEqual({
			remaining: [secondKid],
			activeAfter: secondKid
		});
		await expect(retireControlKey(database, secondKid, t2)).rejects.toThrow(
			LastControlKeyError
		);
	});
});
