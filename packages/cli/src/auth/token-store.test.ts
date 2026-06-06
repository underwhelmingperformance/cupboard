import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect } from 'vitest';

import { testWithConfigHome } from '../test-support.ts';

import { readCachedToken, writeCachedToken } from './token-store.ts';

const tenant = 'https://cupboard.test/t/acme';
const other = 'https://cupboard.test/t/beta';
const host = 'https://cupboard.test';

function encodeJwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${encodeJwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${encodeJwtSegment(claims)}.signature`;
}

async function cachedFileMode(configHome: string): Promise<number> {
	const directory = path.join(configHome, 'cupboard', 'tokens');
	const [file] = await readdir(directory);
	const stats = await stat(path.join(directory, file ?? ''));

	return stats.mode & 0o777;
}

describe('token cache', () => {
	testWithConfigHome(
		'round-trips a tenant token under its target, readable only by the owner',
		async ({ configHome }) => {
			const token = jwt({ iss: tenant, aud: tenant });

			await writeCachedToken(token, tenant);

			expect({
				token: await readCachedToken(tenant),
				mode: await cachedFileMode(configHome)
			}).toStrictEqual({ token, mode: 0o600 });
		}
	);

	testWithConfigHome(
		'returns undefined when no token is cached for the target',
		async () => {
			expect(await readCachedToken(tenant)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'does not return a token cached for another tenant on the same host',
		async () => {
			await writeCachedToken(jwt({ iss: tenant, aud: tenant }), tenant);

			expect(await readCachedToken(other)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'rejects a cached token whose issuer is not the target',
		async () => {
			// A token whose signed issuer is a different tenant, planted under this
			// target: the issuer binding must refuse it rather than send it on.
			await writeCachedToken(jwt({ iss: other, aud: tenant }), tenant);

			expect(await readCachedToken(tenant)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'rejects a cached token whose URL audience is not the target',
		async () => {
			await writeCachedToken(jwt({ iss: tenant, aud: other }), tenant);

			expect(await readCachedToken(tenant)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'accepts a control token whose audience is a non-URL client id',
		async () => {
			const token = jwt({ iss: host, aud: 'cupboard-control' });

			await writeCachedToken(token, host);

			expect(await readCachedToken(host)).toBe(token);
		}
	);

	testWithConfigHome(
		'keys on the canonical target, ignoring a trailing slash',
		async () => {
			const token = jwt({ iss: tenant, aud: tenant });

			await writeCachedToken(token, `${tenant}/`);

			expect(await readCachedToken(tenant)).toBe(token);
		}
	);
});
