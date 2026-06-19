import type {
	AuthKeyListResponse,
	AuthKeyRotateResponse
} from '@cupboard/protocol/keys';
import {
	authKeyListResponseSchema,
	authKeyRetireResponseSchema,
	authKeyRotateResponseSchema
} from '@cupboard/protocol/keys';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { generateAuthKeyPair } from '../auth/auth.ts';
import { authKeys } from '../db/schema.ts';
import {
	adminGrants,
	authorisedFetch,
	cacheWriteGrants,
	currentServer,
	fetchPath,
	initialise,
	issueServerSignedToken,
	latestMigrationIndex,
	migrateThrough,
	resetTestServer
} from '../test-support.ts';

async function adminToken(): Promise<string> {
	await initialise();

	return issueServerSignedToken(adminGrants());
}

async function listKeys(token: string): Promise<AuthKeyListResponse> {
	const response = await authorisedFetch('/keys/auth', token);

	return authKeyListResponseSchema.parse(await response.json());
}

async function rotate(token: string): Promise<AuthKeyRotateResponse> {
	const response = await authorisedFetch('/keys/auth/rotate', token, {
		method: 'POST'
	});

	return authKeyRotateResponseSchema.parse(await response.json());
}

function retire(token: string, kid: string): Promise<Response> {
	return authorisedFetch(`/keys/auth/retire/${kid}`, token, { method: 'POST' });
}

const rotateAt = new Date('2026-01-01T00:01:00.000Z');
const scheduledRetireAt = '2026-01-01T00:21:30.000Z';

const orpcErrorBodySchema = z.strictObject({
	code: z.string(),
	defined: z.boolean(),
	message: z.string(),
	status: z.number()
});

function singleListedKey(
	list: AuthKeyListResponse
): AuthKeyListResponse['keys'][number] {
	const [key] = z
		.tuple([
			z.object({
				kid: z.string(),
				createdAt: z.string(),
				active: z.boolean(),
				scheduledRetireAt: z.string().optional()
			})
		])
		.parse(list.keys);

	return key;
}

describe('auth-key rotation', () => {
	beforeEach(resetTestServer);
	afterEach(() => vi.useRealTimers());

	it('starts with one active key', async () => {
		const token = await adminToken();

		const list = await listKeys(token);
		const key = singleListedKey(list);

		expect(list.keys).toStrictEqual([
			{
				kid: key.kid,
				createdAt: key.createdAt,
				active: true
			}
		]);
	});

	it('rotates so the new key issues and both keys still verify', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(rotateAt);

		const token = await adminToken();
		const before = await listKeys(token);
		const { kid: original } = singleListedKey(before);

		const rotated = await rotate(token);

		// `token` was signed by the original key before the rotation; it still
		// verifies because the original key remains in the set.
		const originalStillWorks = await authorisedFetch('/keys/auth', token);
		const keys = rotated.keys
			.map((key) => ({
				kid: key.kid,
				createdAt: key.createdAt,
				active: key.active,
				scheduledRetireAt: key.scheduledRetireAt
			}))
			.toSorted((left, right) => left.kid.localeCompare(right.kid));

		expect({
			keys,
			retiring: rotated.retiring,
			originalStillVerifies: originalStillWorks.status
		}).toStrictEqual({
			keys: [
				{
					kid: original,
					createdAt: rotateAt.toISOString(),
					active: false,
					scheduledRetireAt
				},
				{
					kid: rotated.rotated,
					createdAt: rotateAt.toISOString(),
					active: true,
					scheduledRetireAt: undefined
				}
			].toSorted((left, right) => left.kid.localeCompare(right.kid)),
			retiring: { kid: original, scheduledRetireAt },
			originalStillVerifies: StatusCodes.OK
		});
	});

	it('retires scheduled auth keys only when they are due', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(rotateAt);

		const token = await adminToken();
		const before = await listKeys(token);
		const { kid: original } = singleListedKey(before);
		const rotated = await rotate(token);

		vi.setSystemTime(new Date('2026-01-01T00:21:29.999Z'));
		await currentServer().runAuthKeyRetirement();
		const earlyToken = await issueServerSignedToken(adminGrants());
		const early = await listKeys(earlyToken);

		vi.setSystemTime(new Date(scheduledRetireAt));
		await currentServer().runAuthKeyRetirement();
		const dueToken = await issueServerSignedToken(adminGrants());
		const due = await listKeys(dueToken);

		await currentServer().runAuthKeyRetirement();
		const again = await listKeys(dueToken);

		expect({
			retiring: rotated.retiring,
			earlyKeys: early.keys.map((key) => key.kid),
			dueKeys: due.keys.map((key) => key.kid),
			againKeys: again.keys.map((key) => key.kid)
		}).toStrictEqual({
			retiring: { kid: original, scheduledRetireAt },
			earlyKeys: [original, rotated.rotated],
			dueKeys: [rotated.rotated],
			againKeys: [rotated.rotated]
		});
	});

	it('retires a superseded key and refuses to retire the last one', async () => {
		const token = await adminToken();
		const before = await listKeys(token);
		const { kid: original } = singleListedKey(before);
		const rotated = await rotate(token);

		// Retiring the original would invalidate `token`, which it signed, so act
		// with a token issued by the now-active rotated key.
		const activeToken = await issueServerSignedToken(adminGrants());
		const retiredResponse = await retire(activeToken, original);
		const retired = authKeyRetireResponseSchema.parse(
			await retiredResponse.json()
		);
		const list = await listKeys(activeToken);
		const refused = await retire(activeToken, rotated.rotated);
		const refusedBody = orpcErrorBodySchema.parse(await refused.json());

		expect({
			retired,
			remainingKids: list.keys.map((key) => key.kid),
			refusedDefined: refusedBody.defined,
			refusedStatus: refused.status,
			refusedCode: refusedBody.code
		}).toStrictEqual({
			retired: { kid: original, retired: true },
			remainingKids: [rotated.rotated],
			refusedDefined: false,
			refusedStatus: StatusCodes.CONFLICT,
			refusedCode: 'CONFLICT'
		});
	});

	it('reports an unknown kid as not retired', async () => {
		const token = await adminToken();

		const response = await retire(token, 'no-such-kid');

		expect(
			authKeyRetireResponseSchema.parse(await response.json())
		).toStrictEqual({
			kid: 'no-such-kid',
			retired: false
		});
	});

	it('refuses a write token', async () => {
		await initialise();
		const token = await issueServerSignedToken(cacheWriteGrants());

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
		const keySchema = z.object({
			kid: z.string(),
			x: z.string().optional()
		});
		const body = z
			.object({ keys: z.array(keySchema) })
			.parse(await response.json());
		const stored = await runInDurableObject(
			currentServer(),
			(_instance, state) =>
				drizzle(state.storage, { schema: { authKeys } })
					.select({ kid: authKeys.kid })
					.from(authKeys)
					.all()
		);
		const [{ kid }] = z
			.tuple([z.object({ kid: z.string().min(1) })])
			.parse(stored);

		expect({
			stored,
			jwks: body.keys.map(({ kid, x }) => ({ kid, x }))
		}).toStrictEqual({
			stored: [{ kid }],
			jwks: [{ kid, x: seeded }]
		});
	});
});
