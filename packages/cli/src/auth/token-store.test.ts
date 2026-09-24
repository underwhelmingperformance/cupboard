import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect } from 'vitest';

import { testWithConfigHome } from '../test-support.ts';

import {
	listCachedSessions,
	readCachedSession,
	removeAllCachedSessions,
	removeCachedSession,
	writeCachedSession
} from './token-store.ts';

const tenant = 'https://cupboard.test/t/acme';
const other = 'https://cupboard.test/t/beta';
const host = 'https://cupboard.test';
const tenantTarget = new URL(tenant);
const otherTarget = new URL(other);
const hostTarget = new URL(host);

function encodeJwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${encodeJwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${encodeJwtSegment(claims)}.signature`;
}

function tokensDirectory(configHome: string): string {
	return path.join(configHome, 'cupboard', 'tokens');
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

			await writeCachedSession(session, tenantTarget);

			expect({
				session: await readCachedSession(tenantTarget),
				mode: await cachedFileMode(configHome)
			}).toStrictEqual({ session, mode: 0o600 });
		}
	);

	testWithConfigHome(
		'round-trips a session granted no refresh token',
		async () => {
			const session = { accessToken: jwt({ iss: tenant, aud: tenant }) };

			await writeCachedSession(session, tenantTarget);

			expect(await readCachedSession(tenantTarget)).toStrictEqual(session);
		}
	);

	testWithConfigHome(
		'does not let an aborted late session commit replace its successor',
		async () => {
			const loser = {
				accessToken: jwt({ iss: tenant, aud: tenant, name: 'loser' })
			};
			const winner = {
				accessToken: jwt({ iss: tenant, aud: tenant, name: 'winner' })
			};
			const reason = new Error('session lock was lost before commit');

			await expect(
				writeCachedSession(loser, tenantTarget, abortOnSecondCheck(reason))
			).rejects.toBe(reason);
			await writeCachedSession(winner, tenantTarget);

			expect(await readCachedSession(tenantTarget)).toStrictEqual(winner);
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

			expect(await readCachedSession(tenantTarget)).toStrictEqual({
				accessToken: token
			});
		}
	);

	testWithConfigHome(
		'returns undefined when no session is cached for the target',
		async () => {
			expect(await readCachedSession(tenantTarget)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'does not return a session cached for another tenant on the same host',
		async () => {
			await writeCachedSession(
				{ accessToken: jwt({ iss: tenant, aud: tenant }) },
				tenantTarget
			);

			expect(await readCachedSession(otherTarget)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'rejects a cached session whose token issuer is not the target',
		async () => {
			await writeCachedSession(
				{ accessToken: jwt({ iss: other, aud: tenant }) },
				tenantTarget
			);

			expect(await readCachedSession(tenantTarget)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'rejects a cached session whose URL audience is not the target',
		async () => {
			await writeCachedSession(
				{ accessToken: jwt({ iss: tenant, aud: other }) },
				tenantTarget
			);

			expect(await readCachedSession(tenantTarget)).toBeUndefined();
		}
	);

	testWithConfigHome(
		'accepts a control token whose audience is a non-URL client id',
		async () => {
			const session = {
				accessToken: jwt({ iss: host, aud: 'cupboard-control' })
			};

			await writeCachedSession(session, hostTarget);

			expect(await readCachedSession(hostTarget)).toStrictEqual(session);
		}
	);

	testWithConfigHome(
		'keys on the canonical target, ignoring a trailing slash',
		async () => {
			const session = { accessToken: jwt({ iss: tenant, aud: tenant }) };

			await writeCachedSession(session, new URL(`${tenant}/`));

			expect(await readCachedSession(tenantTarget)).toStrictEqual(session);
		}
	);
});

describe('session listing and removal', () => {
	const tenantSession = { accessToken: jwt({ iss: tenant, aud: tenant }) };
	const otherSession = {
		accessToken: jwt({ iss: other, aud: other }),
		refreshToken: 'refresh-2'
	};
	const hostSession = { accessToken: jwt({ iss: host, aud: 'control' }) };

	testWithConfigHome(
		'lists every cached session, ignoring files that are not sessions',
		async ({ configHome }) => {
			await writeCachedSession(tenantSession, tenantTarget);
			await writeCachedSession(otherSession, otherTarget);
			await writeFile(
				path.join(tokensDirectory(configHome), '.secret.leftover'),
				'not a session'
			);
			await mkdir(path.join(tokensDirectory(configHome), 'x.lock'));

			const sessions = await listCachedSessions();

			expect(
				sessions.toSorted((left, right) =>
					left.accessToken.localeCompare(right.accessToken)
				)
			).toStrictEqual(
				[tenantSession, otherSession].toSorted((left, right) =>
					left.accessToken.localeCompare(right.accessToken)
				)
			);
		}
	);

	testWithConfigHome(
		'lists nothing when no session was ever cached',
		async () => {
			expect(await listCachedSessions()).toStrictEqual([]);
		}
	);

	testWithConfigHome(
		'removes one target session and leaves the others',
		async () => {
			await writeCachedSession(tenantSession, tenantTarget);
			await writeCachedSession(otherSession, otherTarget);

			expect({
				first: await removeCachedSession(new URL(`${tenant}/`)),
				second: await removeCachedSession(tenantTarget),
				tenant: await readCachedSession(tenantTarget),
				other: await readCachedSession(otherTarget)
			}).toStrictEqual({
				first: 'removed',
				second: 'absent',
				tenant: undefined,
				other: otherSession
			});
		}
	);

	testWithConfigHome(
		'removes every cached session and counts them',
		async () => {
			await writeCachedSession(tenantSession, tenantTarget);
			await writeCachedSession(otherSession, otherTarget);
			await writeCachedSession(hostSession, hostTarget);

			expect({
				removed: await removeAllCachedSessions(),
				remaining: await listCachedSessions()
			}).toStrictEqual({ removed: 3, remaining: [] });
		}
	);
});
