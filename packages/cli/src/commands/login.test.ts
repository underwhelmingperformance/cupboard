import { describe, expect, it } from 'vitest';

import { DeviceAuthorizationRequestError } from '../auth/oidc-login.ts';
import {
	type CloudflareGrant,
	cloudflareOauthClientId,
	deployScopes
} from '../deploy/cloudflare-oauth.ts';

import {
	cupboardIdToken,
	DeviceGrantNotEnabledError,
	LoginIdTokenMissingError,
	loginScopeForClient,
	mapDeviceLoginError
} from './login.ts';

describe('mapDeviceLoginError', () => {
	it.each([[400], [401], [403]])(
		'maps a refused device authorization (HTTP %i) for the built-in client',
		(status) => {
			const mapped = mapDeviceLoginError(
				new DeviceAuthorizationRequestError(status),
				cloudflareOauthClientId
			);

			expect(mapped).toBeInstanceOf(DeviceGrantNotEnabledError);
		}
	);

	it('passes the error through for other clients', () => {
		const error = new DeviceAuthorizationRequestError(403);

		expect(mapDeviceLoginError(error, 'someone-else')).toBe(error);
	});

	it.each([
		['a server error', new DeviceAuthorizationRequestError(500)],
		['an unrelated failure', new Error('network down')]
	])('passes %s through for the built-in client', (_name, error) => {
		expect(mapDeviceLoginError(error, cloudflareOauthClientId)).toBe(error);
	});
});

describe('loginScopeForClient', () => {
	it('uses the registered Cloudflare scopes for the built-in client', () => {
		expect(loginScopeForClient(cloudflareOauthClientId)).toBe(
			deployScopes.join(' ')
		);
	});

	it('leaves custom OIDC clients on the generic login default', () => {
		expect(loginScopeForClient('someone-else')).toBeUndefined();
	});
});

const now = 1_700_000_000_000;

/** An unsigned id_token whose payload carries the given expiry (seconds). */
function tokenExpiringAt(expSeconds: number): string {
	const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString(
		'base64url'
	);
	const payload = Buffer.from(
		JSON.stringify({ sub: 'cf-user-1', exp: expSeconds })
	).toString('base64url');

	return `${header}.${payload}.signature`;
}

function grantWith(idToken?: string): CloudflareGrant {
	return {
		accessToken: 'access-1',
		refreshToken: 'refresh-1',
		expiresAt: now + 60 * 60 * 1000,
		subject: 'cf-user-1',
		idToken
	};
}

interface IdTokenWorld {
	readonly storedGrant?: CloudflareGrant;
	readonly renewedGrant?: CloudflareGrant;
	readonly loginGrant?: CloudflareGrant;
}

function idTokenDeps(world: IdTokenWorld): {
	deps: Parameters<typeof cupboardIdToken>[0];
	calls: { written: CloudflareGrant[]; logins: number };
} {
	const written: CloudflareGrant[] = [];
	const counter = { logins: 0 };

	return {
		calls: {
			written,
			get logins() {
				return counter.logins;
			}
		},
		deps: {
			chain: {
				readGrant: () => Promise.resolve(world.storedGrant),
				writeGrant: (grant) => {
					written.push(grant);
					return Promise.resolve();
				},
				refreshGrant: () => Promise.resolve(world.renewedGrant),
				now: () => now
			},
			login: () => {
				counter.logins += 1;

				if (world.loginGrant === undefined) {
					return Promise.reject(new Error('login was not expected'));
				}

				return Promise.resolve(world.loginGrant);
			}
		}
	};
}

describe('cupboardIdToken', () => {
	it('answers from the cached grant without a browser', async () => {
		const idToken = tokenExpiringAt(now / 1000 + 3600);
		const { deps, calls } = idTokenDeps({ storedGrant: grantWith(idToken) });

		expect({
			token: await cupboardIdToken(deps),
			logins: calls.logins
		}).toStrictEqual({ token: idToken, logins: 0 });
	});

	it('logs in afresh when the cached token is expired and unrefreshable', async () => {
		const expired = tokenExpiringAt(now / 1000 - 60);
		const fresh = tokenExpiringAt(now / 1000 + 3600);
		const loginGrant = grantWith(fresh);
		const { deps, calls } = idTokenDeps({
			storedGrant: grantWith(expired),
			loginGrant
		});

		expect({
			token: await cupboardIdToken(deps),
			// The new grant is persisted, so the deploy shares the login.
			written: calls.written
		}).toStrictEqual({ token: fresh, written: [loginGrant] });
	});

	it('logs in afresh when no grant is cached', async () => {
		const fresh = tokenExpiringAt(now / 1000 + 3600);
		const { deps } = idTokenDeps({ loginGrant: grantWith(fresh) });

		expect(await cupboardIdToken(deps)).toBe(fresh);
	});

	it('rejects a login that carried no id_token', async () => {
		const { deps } = idTokenDeps({ loginGrant: grantWith() });

		await expect(cupboardIdToken(deps)).rejects.toBeInstanceOf(
			LoginIdTokenMissingError
		);
	});
});
