import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { describe, expect, it } from 'vitest';

import type { Removal } from '../auth/secret-file.ts';
import {
	readCachedSession,
	removeAllCachedSessions,
	removeCachedSession,
	writeCachedSession
} from '../auth/token-store.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import {
	readCachedGrant,
	removeCachedGrant,
	writeCachedGrant
} from '../deploy/grant-store.ts';
import { testWithConfigHome } from '../test-support.ts';

import {
	type LogoutDependencies,
	logoutInput,
	LogoutTargetError,
	runLogout
} from './logout.ts';

const tenant = 'https://cupboard.example.workers.dev/t/acme';
const other = 'https://cupboard.example.workers.dev/t/beta';

function jwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${jwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${jwtSegment(claims)}.signature`;
}

const grant: CloudflareGrant = {
	accessToken: 'cloudflare-access',
	refreshToken: undefined,
	idToken: undefined,
	expiresAt: 1_700_000_000_000,
	subject: 'user-1'
};

function removal(wasPresent: boolean): Removal {
	return wasPresent ? 'removed' : 'absent';
}

function fakeDependencies(state: {
	sessions: Set<string>;
	grant: boolean;
}): LogoutDependencies {
	return {
		removeSession: (url) =>
			Promise.resolve(removal(state.sessions.delete(url.href))),
		removeAllSessions: () => {
			const count = state.sessions.size;
			state.sessions.clear();

			return Promise.resolve(count);
		},
		readGrant: () => Promise.resolve(state.grant ? grant : undefined),
		removeGrant: () => {
			const wasPresent = state.grant;
			state.grant = false;

			return Promise.resolve(removal(wasPresent));
		}
	};
}

describe('logoutInput', () => {
	it('signs out of one URL', () => {
		const url = new URL(tenant);

		expect(logoutInput(url, {})).toStrictEqual({
			sessions: { kind: 'url', url },
			cloudflareSignIn: 'keep'
		});
	});

	it('signs out of everything, including Cloudflare', () => {
		expect(
			logoutInput(undefined, { all: true, cloudflare: true })
		).toStrictEqual({ sessions: { kind: 'all' }, cloudflareSignIn: 'remove' });
	});

	it('removes only the Cloudflare sign-in', () => {
		expect(logoutInput(undefined, { cloudflare: true })).toStrictEqual({
			sessions: { kind: 'none' },
			cloudflareSignIn: 'remove'
		});
	});

	it.each([
		['nothing to remove', undefined, {}],
		['a URL with --all', new URL(tenant), { all: true }]
	])('refuses %s', (_name, url, options) => {
		expect(() => logoutInput(url, options)).toThrow(LogoutTargetError);
	});
});

describe('runLogout', () => {
	it('removes one session and warns that the Cloudflare sign-in remains', async () => {
		const state = { sessions: new Set([tenant, other]), grant: true };
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			fakeDependencies(state)
		);

		expect({
			result,
			remaining: [...state.sessions],
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 1,
				cloudflareSignIn: 'kept',
				revoked: false
			},
			remaining: [other],
			results: [
				{
					kind: 'logout',
					data: result,
					rows: [
						{ label: tenant, value: 'session removed' },
						{ label: 'Cloudflare sign-in', value: 'still cached' }
					]
				}
			],
			warnings: 1
		});
	});

	it('is idempotent for a URL with no session', async () => {
		const state = { sessions: new Set<string>(), grant: false };
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(new URL(tenant), {}),
			ui.reporter(),
			fakeDependencies(state)
		);

		expect({
			result,
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				url: tenant,
				sessionsRemoved: 0,
				cloudflareSignIn: 'absent',
				revoked: false
			},
			results: [
				{
					kind: 'logout',
					data: result,
					rows: [{ label: tenant, value: 'no session was cached' }]
				}
			],
			warnings: 0
		});
	});

	it('removes every session and the Cloudflare sign-in', async () => {
		const state = { sessions: new Set([tenant, other]), grant: true };
		const { ui, captured } = fakeCliUi();

		const result = await runLogout(
			logoutInput(undefined, { all: true, cloudflare: true }),
			ui.reporter(),
			fakeDependencies(state)
		);

		expect({
			result,
			state: { sessions: state.sessions.size, grant: state.grant },
			results: captured.results,
			warnings: captured.warnings.length
		}).toStrictEqual({
			result: {
				sessionsRemoved: 2,
				cloudflareSignIn: 'removed',
				revoked: false
			},
			state: { sessions: 0, grant: false },
			results: [
				{
					kind: 'logout',
					data: result,
					rows: [
						{ label: 'Sessions removed', value: '2' },
						{ label: 'Cloudflare sign-in', value: 'removed' }
					]
				}
			],
			warnings: 0
		});
	});
});

describe('runLogout against the on-disk stores', () => {
	testWithConfigHome(
		'deletes the cached session and Cloudflare sign-in files',
		async () => {
			const tenantUrl = new URL(tenant);
			const otherUrl = new URL(other);
			await writeCachedSession(
				{ accessToken: jwt({ iss: tenant, aud: tenant }) },
				tenantUrl
			);
			await writeCachedSession(
				{ accessToken: jwt({ iss: other, aud: other }) },
				otherUrl
			);
			await writeCachedGrant(grant);
			const { ui } = fakeCliUi();

			const result = await runLogout(
				logoutInput(tenantUrl, { cloudflare: true }),
				ui.reporter(),
				{
					removeSession: removeCachedSession,
					removeAllSessions: removeAllCachedSessions,
					readGrant: readCachedGrant,
					removeGrant: removeCachedGrant
				}
			);

			expect({
				result,
				tenant: await readCachedSession(tenantUrl),
				other: (await readCachedSession(otherUrl)) !== undefined,
				grant: await readCachedGrant()
			}).toStrictEqual({
				result: {
					url: tenant,
					sessionsRemoved: 1,
					cloudflareSignIn: 'removed',
					revoked: false
				},
				tenant: undefined,
				other: true,
				grant: undefined
			});
		}
	);
});
