import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect } from 'vitest';

import { testWithConfigHome } from '../test-support.ts';

import { readCachedSession, writeCachedSession } from './token-store.ts';

const tenant = 'https://cupboard.test/t/acme';
const other = 'https://cupboard.test/t/beta';
const host = 'https://cupboard.test';

function encodeJwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${encodeJwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${encodeJwtSegment(claims)}.signature`;
}

function tokensDirectory(configHome: string): string {
	return path.join(configHome, 'cupboard', 'tokens');
}

async function cachedFileMode(configHome: string): Promise<number> {
	const directory = tokensDirectory(configHome);
	const [file] = await readdir(directory);
	const stats = await stat(path.join(directory, file ?? ''));

	return stats.mode & 0o777;
}

describe('session cache', () => {
	testWithConfigHome(
		'round-trips a tenant session under its target, readable only by the owner',
		async ({ configHome }) => {
			const session = {
				accessToken: jwt({ iss: tenant, aud: tenant }),
				refreshToken: 'refresh-1'
			};

			await writeCachedSession(session, tenant);

			expect({
				session: await readCachedSession(tenant),
				mode: await cachedFileMode(configHome)
			}).toStrictEqual({ session, mode: 0o600 });
		}
	);

	testWithConfigHome(
		'round-trips a session granted no refresh token',
		async () => {
			const session = { accessToken: jwt({ iss: tenant, aud: tenant }) };

			await writeCachedSession(session, tenant);

			expect(await readCachedSession(tenant)).toStrictEqual(session);
		}
	);

	testWithConfigHome(
		'reads a pre-session cache file as a bare access token',
		async ({ configHome }) => {
			// The file format before sessions: the access token on its own line.
			const token = jwt({ iss: tenant, aud: tenant });
			const tenantUrl = new URL(tenant);
			const key = createHash('sha256')
				.update(tenantUrl.href.replace(/\/+$/, ''))
				.digest('hex');
			await mkdir(tokensDirectory(configHome), { recursive: true });
			await writeFile(
				path.join(tokensDirectory(configHome), key),
				`${token}\n`
			);

			expect(await readCachedSession(tenant)).toStrictEqual({
				accessToken: token
			});
		}
	);

	testWithConfigHome(
		'returns undefined when no session is cached for the target',
		async () => {
			expect(await readCachedSession(tenant)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'does not return a session cached for another tenant on the same host',
		async () => {
			await writeCachedSession(
				{ accessToken: jwt({ iss: tenant, aud: tenant }) },
				tenant
			);

			expect(await readCachedSession(other)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'rejects a cached session whose token issuer is not the target',
		async () => {
			// A token whose signed issuer is a different tenant, planted under this
			// target: the issuer binding must refuse it rather than send it on.
			await writeCachedSession(
				{ accessToken: jwt({ iss: other, aud: tenant }) },
				tenant
			);

			expect(await readCachedSession(tenant)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'rejects a cached session whose URL audience is not the target',
		async () => {
			await writeCachedSession(
				{ accessToken: jwt({ iss: tenant, aud: other }) },
				tenant
			);

			expect(await readCachedSession(tenant)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'accepts a control token whose audience is a non-URL client id',
		async () => {
			const session = {
				accessToken: jwt({ iss: host, aud: 'cupboard-control' })
			};

			await writeCachedSession(session, host);

			expect(await readCachedSession(host)).toStrictEqual(session);
		}
	);

	testWithConfigHome(
		'keys on the canonical target, ignoring a trailing slash',
		async () => {
			const session = { accessToken: jwt({ iss: tenant, aud: tenant }) };

			await writeCachedSession(session, `${tenant}/`);

			expect(await readCachedSession(tenant)).toStrictEqual(session);
		}
	);
});
