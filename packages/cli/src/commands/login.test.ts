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

			if (mapped instanceof DeviceGrantNotEnabledError) {
				expect(mapped.cause).toBeInstanceOf(DeviceAuthorizationRequestError);

				if (mapped.cause instanceof DeviceAuthorizationRequestError) {
					expect({
						name: mapped.name,
						causeStatus: mapped.cause.status
					}).toStrictEqual({
						name: 'DeviceGrantNotEnabledError',
						causeStatus: status
					});
				}
			}
		}
	);

	it('passes the error through for other clients', () => {
		const error = new DeviceAuthorizationRequestError(403);
		const mapped = mapDeviceLoginError(error, 'someone-else');

		expect(mapped).toBeInstanceOf(DeviceAuthorizationRequestError);

		if (mapped instanceof DeviceAuthorizationRequestError) {
			expect({
				name: mapped.name,
				status: mapped.status,
				passedThrough: mapped === error
			}).toStrictEqual({
				name: 'DeviceAuthorizationRequestError',
				status: 403,
				passedThrough: true
			});
		}
	});

	it.each([
		['a server error', new DeviceAuthorizationRequestError(500)],
		['an unrelated failure', new Error('network down')]
	])('passes %s through for the built-in client', (_name, error) => {
		const mapped = mapDeviceLoginError(error, cloudflareOauthClientId);

		expect(mapped).toBeInstanceOf(Error);

		if (mapped instanceof Error) {
			expect({
				name: mapped.name,
				passedThrough: mapped === error
			}).toStrictEqual({
				name: error.name,
				passedThrough: true
			});
		}
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

/**
An unsigned id_token whose payload carries the given expiry (seconds).
*/
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

function idTokenDependencies(world: IdTokenWorld): {
	deps: Parameters<typeof cupboardIdToken>[0];
	calls: { logins: CloudflareGrant[]; written: CloudflareGrant[] };
} {
	const defaultLoginGrant = grantWith(tokenExpiringAt(now / 1000 + 7200));
	const logins: CloudflareGrant[] = [];
	const written: CloudflareGrant[] = [];

	return {
		calls: {
			logins,
			written
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
				const loginGrant = world.loginGrant ?? defaultLoginGrant;
				logins.push(loginGrant);

				return Promise.resolve(loginGrant);
			}
		}
	};
}

describe('cupboardIdToken', () => {
	it('answers from the cached grant without a browser', async () => {
		const idToken = tokenExpiringAt(now / 1000 + 3600);
		const { deps, calls } = idTokenDependencies({
			storedGrant: grantWith(idToken)
		});

		expect({
			token: await cupboardIdToken(deps),
			logins: calls.logins,
			written: calls.written
		}).toStrictEqual({
			token: idToken,
			logins: [],
			written: []
		});
	});

	it('logs in afresh when the cached token is expired and unrefreshable', async () => {
		const expired = tokenExpiringAt(now / 1000 - 60);
		const fresh = tokenExpiringAt(now / 1000 + 3600);
		const loginGrant = grantWith(fresh);
		const { deps, calls } = idTokenDependencies({
			storedGrant: grantWith(expired),
			loginGrant
		});

		expect({
			token: await cupboardIdToken(deps),
			logins: calls.logins,
			// The new grant is persisted, so the deploy shares the login.
			written: calls.written
		}).toStrictEqual({
			token: fresh,
			logins: [loginGrant],
			written: [loginGrant]
		});
	});

	it('logs in afresh when no grant is cached', async () => {
		const fresh = tokenExpiringAt(now / 1000 + 3600);
		const loginGrant = grantWith(fresh);
		const { deps, calls } = idTokenDependencies({ loginGrant });

		expect({
			token: await cupboardIdToken(deps),
			logins: calls.logins,
			written: calls.written
		}).toStrictEqual({
			token: fresh,
			logins: [loginGrant],
			written: [loginGrant]
		});
	});

	it('rejects a login that carried no id_token', async () => {
		const { deps, calls } = idTokenDependencies({ loginGrant: grantWith() });
		const outcome = await (async () => {
			try {
				const token = await cupboardIdToken(deps);
				return { token };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(LoginIdTokenMissingError);

				const name =
					error_ instanceof LoginIdTokenMissingError
						? error_.name
						: String(error_);

				return { error: { name } };
			}
		})();

		expect({
			outcome,
			logins: calls.logins,
			written: calls.written
		}).toStrictEqual({
			outcome: {
				error: {
					name: LoginIdTokenMissingError.name
				}
			},
			logins: [
				{
					accessToken: 'access-1',
					expiresAt: now + 3_600_000,
					idToken: undefined,
					refreshToken: 'refresh-1',
					subject: 'cf-user-1'
				}
			],
			written: [
				{
					accessToken: 'access-1',
					expiresAt: now + 3_600_000,
					idToken: undefined,
					refreshToken: 'refresh-1',
					subject: 'cf-user-1'
				}
			]
		});
	});
});
