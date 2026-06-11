import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect } from 'vitest';

import { testWithConfigHome } from '../test-support.ts';

import { readCachedGrant, writeCachedGrant } from './grant-store.ts';

function grantFile(configHome: string): string {
	return path.join(configHome, 'cupboard', 'cloudflare-grant.json');
}

describe('grant store', () => {
	testWithConfigHome(
		'round-trips a grant, readable only by the owner',
		async ({ configHome }) => {
			const grant = {
				accessToken: 'access-1',
				refreshToken: 'refresh-1',
				expiresAt: 1_700_000_000_000
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
		'round-trips a grant without a refresh token',
		async () => {
			const grant = {
				accessToken: 'access-2',
				refreshToken: undefined,
				expiresAt: 42
			};

			await writeCachedGrant(grant);

			expect(await readCachedGrant()).toStrictEqual(grant);
		}
	);

	testWithConfigHome('returns undefined when nothing is cached', async () => {
		expect(await readCachedGrant()).toBeUndefined();
	});

	testWithConfigHome(
		'reads a corrupt cache as absent rather than failing',
		async ({ configHome }) => {
			const grant = {
				accessToken: 'access-3',
				refreshToken: undefined,
				expiresAt: 42
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
				expiresAt: 42
			});
			await writeFile(
				grantFile(configHome),
				JSON.stringify({ refresh_token: 'only' })
			);

			expect(await readCachedGrant()).toBeUndefined();
		}
	);
});
