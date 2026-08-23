import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect } from 'vitest';

import { testWithConfigHome } from '../test-support.ts';

import { readCachedGrant, writeCachedGrant } from './grant-store.ts';

function grantFile(configHome: string): string {
	return path.join(configHome, 'cupboard', 'cloudflare-grant.json');
}

function abortOnSecondCheck(reason: Error): AbortSignal {
	const controller = new AbortController();
	let checks = 0;

	return new Proxy(controller.signal, {
		get(target, property): unknown {
			if (property === 'aborted') {
				checks += 1;

				if (checks === 2) {
					controller.abort(reason);
				}
			}

			return Reflect.get(target, property, target);
		}
	});
}

describe('grant store', () => {
	testWithConfigHome(
		'round-trips a grant, readable only by the owner',
		async ({ configHome }) => {
			const grant = {
				accessToken: 'access-1',
				refreshToken: 'refresh-1',
				expiresAt: 1_700_000_000_000,
				subject: 'cf-user-1',
				idToken: 'id-token-1'
			};

			await writeCachedGrant(grant);
			const stats = await stat(grantFile(configHome));

			expect({
				grant: await readCachedGrant(),
				mode: stats.mode & 0o777
			}).toStrictEqual({ grant, mode: 0o600 });
		}
	);

	testWithConfigHome(
		'round-trips a grant without a refresh token or identity',
		async () => {
			const grant = {
				accessToken: 'access-2',
				refreshToken: undefined,
				expiresAt: 42,
				subject: undefined,
				idToken: undefined
			};

			await writeCachedGrant(grant);

			expect(await readCachedGrant()).toStrictEqual(grant);
		}
	);

	testWithConfigHome(
		'does not let an aborted late grant commit replace its successor',
		async () => {
			const loser = {
				accessToken: 'loser-access',
				refreshToken: 'loser-refresh',
				expiresAt: 1,
				subject: 'cf-user',
				idToken: 'loser-id'
			};
			const winner = {
				accessToken: 'winner-access',
				refreshToken: 'winner-refresh',
				expiresAt: 2,
				subject: 'cf-user',
				idToken: 'winner-id'
			};
			const reason = new Error('grant lock was lost before commit');

			await expect(
				writeCachedGrant(loser, abortOnSecondCheck(reason))
			).rejects.toBe(reason);
			await writeCachedGrant(winner);

			expect(await readCachedGrant()).toStrictEqual(winner);
		}
	);

	testWithConfigHome(
		'reads a cache written before identities existed',
		async ({ configHome }) => {
			await writeCachedGrant({
				accessToken: 'seed',
				refreshToken: undefined,
				expiresAt: 1,
				subject: undefined,
				idToken: undefined
			});
			await writeFile(
				grantFile(configHome),
				JSON.stringify({ access_token: 'access-5', expires_at: 42 })
			);

			expect(await readCachedGrant()).toStrictEqual({
				accessToken: 'access-5',
				refreshToken: undefined,
				expiresAt: 42,
				subject: undefined,
				idToken: undefined
			});
		}
	);

	testWithConfigHome('returns undefined when the cache is absent', async () => {
		expect(await readCachedGrant()).toBeUndefined();
	});

	testWithConfigHome(
		'reads a corrupt cache as absent rather than failing',
		async ({ configHome }) => {
			const grant = {
				accessToken: 'access-3',
				refreshToken: undefined,
				expiresAt: 42,
				subject: undefined,
				idToken: undefined
			};

			// Establish the directory, then corrupt the file in place.
			await writeCachedGrant(grant);
			await writeFile(grantFile(configHome), 'not json');

			expect(await readCachedGrant()).toBeUndefined();
		}
	);

	testWithConfigHome(
		'reads a cache that misses required fields as absent',
		async ({ configHome }) => {
			await writeCachedGrant({
				accessToken: 'access-4',
				refreshToken: undefined,
				expiresAt: 42,
				subject: undefined,
				idToken: undefined
			});
			await writeFile(
				grantFile(configHome),
				JSON.stringify({ refresh_token: 'only' })
			);

			expect(await readCachedGrant()).toBeUndefined();
		}
	);
});
