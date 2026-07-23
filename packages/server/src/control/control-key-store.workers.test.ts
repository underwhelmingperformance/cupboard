import { authKeyIdSchema } from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { env } from 'cloudflare:workers';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { issueAccessJwt, verifyAccessJwt } from '../auth/auth.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { LastControlKeyError } from '../errors.ts';

import {
	activeControlKey,
	controlKeySummaries,
	controlVerificationKeys,
	ensureControlKey,
	retireControlKey,
	retireScheduledControlKeys,
	rotateControlKey
} from './control-key-store.ts';

const secretBytes = new Uint8Array(32);
secretBytes.fill(7);
const secret = btoa(String.fromCodePoint(...secretBytes));
const issuer = 'https://cupboard.test';
const audience = 'cupboard-control';
const t0 = '2026-01-01T00:00:00.000Z';
const t1 = '2026-01-01T00:01:00.000Z';
const t2 = '2026-01-01T00:02:00.000Z';
const t1RetireAt = '2026-01-01T00:21:30.000Z';
const t2RetireAt = '2026-01-01T00:22:30.000Z';
const now = new Date(t0);

function controlDatabase(): ReturnType<typeof drizzleD1<typeof d1Schema>> {
	return drizzleD1(env.CUPBOARD_DB, { schema: d1Schema });
}

describe('control key store', () => {
	it('bootstraps a single key and issues a token verifiable against its JWKS', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		// A second call is a first-writer-wins no-op, not a second key.
		await ensureControlKey(database, secret, t0);

		const verificationKeys = await controlVerificationKeys(database);
		const [verificationKey] = z
			.tuple([z.looseObject({ kid: z.string() })])
			.parse(verificationKeys);
		const active = await activeControlKey(database, secret);
		const token = await issueAccessJwt(
			active.privateJwk,
			{
				issuer,
				audience,
				subject: 'admin',
				grants: [{ type: 'cupboard_wildcard' }],
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
			verificationKeys: [{ kid: verificationKey.kid }],
			claims
		}).toStrictEqual({
			verificationKeys: [{ kid: active.kid }],
			claims: {
				subject: 'admin',
				grants: [{ type: 'cupboard_wildcard' }],
				expiresAt: new Date(now.getTime() + 600 * 1000)
			}
		});
	});

	it('rotates to a new issuing key while the old key keeps verifying', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		const firstActive = await activeControlKey(database, secret);
		const firstKid = firstActive.kid;
		const second = await rotateControlKey(database, secret, t1);
		const secondKid = second.kid;
		const active = await activeControlKey(database, secret);
		const verificationKeys = await controlVerificationKeys(database);
		const publishedKids = verificationKeys
			.map((key) => key.kid)
			.toSorted(byCodeUnit);
		const summaries = await controlKeySummaries(database);

		expect({
			activeKid: active.kid,
			rotated: secondKid !== firstKid,
			publishedKids,
			retiring: second.retiring,
			summaries
		}).toStrictEqual({
			activeKid: secondKid,
			rotated: true,
			publishedKids: [firstKid, secondKid].toSorted(byCodeUnit),
			retiring: { kid: firstKid, scheduledRetireAt: t1RetireAt },
			summaries: [
				{ kid: firstKid, retired: false, scheduledRetireAt: t1RetireAt },
				{ kid: secondKid, retired: false }
			]
		});
	});

	it('leaves older scheduled keys unchanged across repeated rotations', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		const first = await activeControlKey(database, secret);
		const second = await rotateControlKey(database, secret, t1);
		const third = await rotateControlKey(database, secret, t2);

		const summaries = await controlKeySummaries(database);

		expect(summaries).toStrictEqual([
			{ kid: first.kid, retired: false, scheduledRetireAt: t1RetireAt },
			{ kid: second.kid, retired: false, scheduledRetireAt: t2RetireAt },
			{ kid: third.kid, retired: false }
		]);
	});

	it('retires scheduled keys only when they are due', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		const first = await activeControlKey(database, secret);
		const second = await rotateControlKey(database, secret, t1);

		const early = await retireScheduledControlKeys(
			database,
			'2026-01-01T00:21:29.999Z'
		);
		const earlyVerificationKeys = await controlVerificationKeys(database);
		const earlyKeys = earlyVerificationKeys.map((key) => key.kid);
		const due = await retireScheduledControlKeys(database, t1RetireAt);
		const dueVerificationKeys = await controlVerificationKeys(database);
		const dueKeys = dueVerificationKeys.map((key) => key.kid);
		const again = await retireScheduledControlKeys(database, t1RetireAt);

		expect({ early, earlyKeys, due, dueKeys, again }).toStrictEqual({
			early: 0,
			earlyKeys: [first.kid, second.kid],
			due: 1,
			dueKeys: [second.kid],
			again: 0
		});
	});

	it('retires a key and refuses to retire the last live key', async () => {
		const database = controlDatabase();

		await ensureControlKey(database, secret, t0);
		const firstActive = await activeControlKey(database, secret);
		const firstKid = firstActive.kid;
		const second = await rotateControlKey(database, secret, t1);
		const secondKid = second.kid;

		await retireControlKey(database, firstKid, t2);

		const verificationKeys = await controlVerificationKeys(database);
		const remaining = verificationKeys.map((key) => key.kid);
		const activeAfter = await activeControlKey(database, secret);

		expect({ remaining, activeAfter: activeAfter.kid }).toStrictEqual({
			remaining: [secondKid],
			activeAfter: secondKid
		});
		let error: unknown;
		try {
			await retireControlKey(database, secondKid, t2);
			error = { kind: 'retired' };
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(LastControlKeyError);
		if (!(error instanceof LastControlKeyError)) {
			throw error;
		}

		expect({
			name: error.name,
			status: error.status,
			kid: error.kid
		}).toStrictEqual({
			name: 'LastControlKeyError',
			status: StatusCodes.CONFLICT,
			kid: secondKid
		});
	});

	it.each([
		{ name: 'an already-retired key', target: 'retired' as const },
		{ name: 'an unknown key', target: 'unknown' as const }
	])(
		'treats retiring $name as a no-op, never as the last-key refusal',
		async ({ target }) => {
			const database = controlDatabase();

			await ensureControlKey(database, secret, t0);
			const firstActive = await activeControlKey(database, secret);
			const firstKid = firstActive.kid;
			const second = await rotateControlKey(database, secret, t1);
			const secondKid = second.kid;

			await retireControlKey(database, firstKid, t2);

			// Only `secondKid` is live now. Retiring the already-retired `firstKid` (or
			// an unknown key) must resolve quietly: the post-update read finds it not
			// live, so it is the idempotent branch, not the last-live-key refusal that
			// would wrongly fire when exactly one key remains.
			const kid =
				target === 'retired' ? firstKid : authKeyIdSchema.parse('nonexistent');

			await expect(retireControlKey(database, kid, t2)).resolves.toBe(false);

			const liveKeys = await controlVerificationKeys(database);
			const liveKids = liveKeys.map((key) => key.kid);

			expect(liveKids).toStrictEqual([secondKid]);
		}
	);
});
