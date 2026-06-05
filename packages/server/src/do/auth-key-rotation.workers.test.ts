import type {
	AuthKeyListResponse,
	AuthKeyRetireResponse,
	AuthKeyRotateResponse
} from '@cupboard/protocol/keys';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { generateAuthKeyPair } from '../auth/auth.ts';
import { authKeys } from '../db/schema.ts';
import {
	authorisedFetch,
	currentServer,
	fetchPath,
	initialise,
	latestMigrationIndex,
	migrateThrough,
	mintServerSignedToken,
	resetTestServer
} from '../test-support.ts';

async function adminToken(): Promise<string> {
	await initialise();

	return mintServerSignedToken('admin');
}

async function listKeys(token: string): Promise<AuthKeyListResponse> {
	const response = await authorisedFetch('/keys/auth', token);

	return response.json<AuthKeyListResponse>();
}

async function rotate(token: string): Promise<AuthKeyRotateResponse> {
	const response = await authorisedFetch('/keys/auth/rotate', token, {
		method: 'POST'
	});

	return response.json<AuthKeyRotateResponse>();
}

function retire(token: string, kid: string): Promise<Response> {
	return authorisedFetch(`/keys/auth/retire/${kid}`, token, { method: 'POST' });
}

describe('auth-key rotation', () => {
	beforeEach(resetTestServer);

	it('starts with one active key', async () => {
		const token = await adminToken();

		const list = await listKeys(token);
		const [key] = list.keys;
		const { kid, createdAt, ...rest } = key ?? {};

		expect(typeof kid).toBe('string');
		expect(typeof createdAt).toBe('string');
		expect({ count: list.keys.length, rest }).toStrictEqual({
			count: 1,
			rest: { active: true }
		});
	});

	it('rotates so the new key mints and both keys still verify', async () => {
		const token = await adminToken();
		const before = await listKeys(token);
		const original = before.keys[0]?.kid;

		const rotated = await rotate(token);

		// `token` was signed by the original key before the rotation; it still
		// verifies because the original key remains in the set.
		const originalStillWorks = await authorisedFetch('/keys/auth', token);

		expect({
			activeKids: rotated.keys
				.filter((key) => key.active)
				.map((key) => key.kid),
			count: rotated.keys.length,
			rotatedIsActive: rotated.keys.some(
				(key) => key.kid === rotated.rotated && key.active
			),
			originalRetained: rotated.keys.some((key) => key.kid === original),
			originalStillVerifies: originalStillWorks.status
		}).toStrictEqual({
			activeKids: [rotated.rotated],
			count: 2,
			rotatedIsActive: true,
			originalRetained: true,
			originalStillVerifies: StatusCodes.OK
		});
	});

	it('retires a superseded key and refuses to retire the last one', async () => {
		const token = await adminToken();
		const before = await listKeys(token);
		const original = before.keys[0]?.kid ?? '';
		const rotated = await rotate(token);

		// Retiring the original would invalidate `token`, which it signed, so act
		// with a token minted by the now-active rotated key.
		const activeToken = await mintServerSignedToken('admin');
		const retiredResponse = await retire(activeToken, original);
		const retired = await retiredResponse.json<AuthKeyRetireResponse>();
		const list = await listKeys(activeToken);
		const refused = await retire(activeToken, rotated.rotated);
		const refusedBody = await refused.text();

		expect({
			retired,
			remainingKids: list.keys.map((key) => key.kid),
			refusedStatus: refused.status,
			refusedBody
		}).toStrictEqual({
			retired: { kid: original, retired: true },
			remainingKids: [rotated.rotated],
			refusedStatus: StatusCodes.CONFLICT,
			refusedBody: 'Cannot retire the last auth key\n'
		});
	});

	it('reports an unknown kid as not retired', async () => {
		const token = await adminToken();

		const response = await retire(token, 'no-such-kid');

		expect(await response.json<AuthKeyRetireResponse>()).toStrictEqual({
			kid: 'no-such-kid',
			retired: false
		});
	});

	it('refuses a write token', async () => {
		await initialise();
		const token = await mintServerSignedToken('write');

		const response = await authorisedFetch('/keys/auth', token);

		expect(response.status).toBe(StatusCodes.FORBIDDEN);
	});

	it('backfills a missing kid on a pre-rotation key when keys first load', async () => {
		const seeded = await runInDurableObject(
			currentServer(),
			async (_instance, state) => {
				await migrateThrough(state, latestMigrationIndex);
				const pair = await generateAuthKeyPair();

				drizzle(state.storage, { schema: { authKeys } })
					.insert(authKeys)
					.values({
						id: 'active',
						kid: '',
						privateJwkJson: JSON.stringify(pair.privateJwk),
						publicJwkJson: JSON.stringify(pair.publicJwk),
						createdAt: '2026-01-01T00:00:00.000Z'
					})
					.run();

				return pair.publicJwk.x;
			}
		);

		const response = await fetchPath('/.well-known/jwks.json');
		const body = await response.json<{ keys: { kid: string; x?: string }[] }>();
		const storedKid = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				drizzle(state.storage, { schema: { authKeys } })
					.select()
					.from(authKeys)
					.all()
					.at(0)?.kid
		);

		expect({
			storedKidNonEmpty: (storedKid ?? '').length > 0,
			jwksKidMatchesStored: body.keys[0]?.kid === storedKid,
			publishesSeededKey: body.keys[0]?.x === seeded
		}).toStrictEqual({
			storedKidNonEmpty: true,
			jwksKidMatchesStored: true,
			publishesSeededKey: true
		});
	});
});
