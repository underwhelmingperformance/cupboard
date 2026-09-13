import { setTimeout as delay } from 'node:timers/promises';

import type { TokenResponse } from '@cupboard/protocol/oidc';
import { describe, expect, it, vi } from 'vitest';

import { DeviceAuthorizationRequestError } from '../auth/oidc-login.ts';
import {
	type CachedSession,
	readCachedSession,
	withCachedSessionLock,
	writeCachedSession
} from '../auth/token-store.ts';
import {
	type CloudflareGrant,
	cloudflareOauthClientId,
	deployScopes
} from '../deploy/cloudflare-oauth.ts';
import { testWithConfigHome } from '../test-support.ts';

import {
	cacheLoginSession,
	cupboardIdToken,
	DeviceGrantNotEnabledError,
	LoginIdTokenMissingError,
	loginScopeForClient,
	mapDeviceLoginError
} from './login.ts';

const sessionTarget = new URL('https://cupboard.test/t/acme');

function sessionToken(name: string): string {
	const header = Buffer.from(
		JSON.stringify({ alg: 'EdDSA', typ: 'cupboard-access+jwt' })
	).toString('base64url');
	const issuer = sessionTarget.href.replace(/\/$/u, '');
	const payload = Buffer.from(
		JSON.stringify({ iss: issuer, aud: issuer, name })
	).toString('base64url');

	return `${header}.${payload}.signature`;
}

function tokenResponse(name: string): TokenResponse {
	return {
		access_token: sessionToken(name),
		token_type: 'Bearer',
		expires_in: 600,
		refresh_token: `refresh-${name}`
	};
}

type Outcome<T> =
	| { readonly kind: 'resolved'; readonly value: T }
	| { readonly kind: 'rejected'; readonly error: unknown };

async function outcomeOf<T>(promise: Promise<T>): Promise<Outcome<T>> {
	try {
		return { kind: 'resolved', value: await promise };
	} catch (error) {
		return { kind: 'rejected', error };
	}
}

async function pendingAfter(ms: number): Promise<{ readonly kind: 'pending' }> {
	await delay(ms);

	return { kind: 'pending' };
}

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
				withGrantLock: (action, signal) => action(signal),
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
	it('returns the ID token from a cached grant without opening a browser', async () => {
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

	it('reuses a grant written before the fallback login lock', async () => {
		const winner = grantWith(tokenExpiringAt(now / 1000 + 3600));
		const login = vi.fn<() => Promise<CloudflareGrant>>(() =>
			Promise.reject(new Error('browser login was not expected'))
		);
		const writeGrant = vi.fn<(grant: CloudflareGrant) => Promise<void>>(() =>
			Promise.resolve()
		);
		let reads = 0;
		let locks = 0;

		const token = await cupboardIdToken({
			chain: {
				readGrant: () => {
					reads += 1;

					return Promise.resolve(reads === 1 ? undefined : winner);
				},
				writeGrant,
				withGrantLock: (action, signal) => {
					locks += 1;

					return action(signal);
				},
				refreshGrant: () => Promise.resolve(undefined),
				now: () => now
			},
			login
		});

		expect({
			token,
			reads,
			locks,
			loginCalls: login.mock.calls.length,
			writeCalls: writeGrant.mock.calls.length
		}).toStrictEqual({
			token: winner.idToken,
			reads: 2,
			locks: 2,
			loginCalls: 0,
			writeCalls: 0
		});
	});

	it('rejects a login response without an id_token', async () => {
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

describe('login session cache', () => {
	testWithConfigHome(
		'serialises explicit login after an in-flight session renewal',
		async () => {
			const renewalEntered = Promise.withResolvers<undefined>();
			const releaseRenewal = Promise.withResolvers<undefined>();
			const renewed: CachedSession = {
				accessToken: sessionToken('renewal'),
				refreshToken: 'refresh-renewal'
			};
			const renewal = withCachedSessionLock(sessionTarget, async (signal) => {
				renewalEntered.resolve(undefined);
				await releaseRenewal.promise;
				await writeCachedSession(renewed, sessionTarget, signal);
			});

			await renewalEntered.promise;
			const login = cacheLoginSession(
				tokenResponse('explicit-login'),
				sessionTarget
			);
			const beforeRenewalFinishes = await Promise.race([
				outcomeOf(login),
				pendingAfter(50)
			]);

			releaseRenewal.resolve(undefined);
			await Promise.all([renewal, login]);

			expect({
				beforeRenewalFinishes,
				session: await readCachedSession(sessionTarget)
			}).toStrictEqual({
				beforeRenewalFinishes: { kind: 'pending' },
				session: {
					accessToken: sessionToken('explicit-login'),
					refreshToken: 'refresh-explicit-login'
				}
			});
		}
	);

	testWithConfigHome(
		'refuses the final session rename when login is cancelled after exchange',
		async () => {
			const previous: CachedSession = {
				accessToken: sessionToken('previous'),
				refreshToken: 'refresh-previous'
			};
			const writeStarted = Promise.withResolvers<AbortSignal | undefined>();
			const continueWrite = Promise.withResolvers<undefined>();
			const controller = new AbortController();
			const reason = new Error('stop after token exchange');

			await writeCachedSession(previous, sessionTarget);
			const login = cacheLoginSession(
				tokenResponse('cancelled-login'),
				sessionTarget,
				controller.signal,
				{
					withSessionLock: withCachedSessionLock,
					writeSession: async (session, target, signal) => {
						writeStarted.resolve(signal);
						await continueWrite.promise;
						await writeCachedSession(session, target, signal);
					}
				}
			);

			const writeSignal = await writeStarted.promise;
			controller.abort(reason);
			continueWrite.resolve(undefined);

			await expect(login).rejects.toBe(reason);
			const writeSignalReason: unknown = writeSignal?.reason;
			expect({
				writeSignalAborted: writeSignal?.aborted,
				writeSignalReason,
				session: await readCachedSession(sessionTarget)
			}).toStrictEqual({
				writeSignalAborted: true,
				writeSignalReason: reason,
				session: previous
			});
		}
	);
});
