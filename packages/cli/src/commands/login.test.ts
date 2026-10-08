import type { TokenResponse } from '@cupboard/protocol/oidc';
import { subjectBindingNonce } from '@cupboard/protocol/subject-binding';
import lockfile from 'proper-lockfile';
import { describe, expect, it, vi } from 'vitest';

import { BoundSignIn } from '../auth/bound-sign-in.ts';
import { DeviceAuthorizationRequestError } from '../auth/oidc-login.ts';
import {
	type CachedSession,
	readCachedSession,
	withCachedSessionLock,
	writeCachedSession
} from '../auth/token-store.ts';
import { CupboardClient } from '../client/client.ts';
import {
	cloudflareDashIssuer,
	cloudflareOauthClientId,
	signInScopes
} from '../deploy/cloudflare-oauth.ts';
import { readCachedGrant } from '../deploy/grant-store.ts';
import { testWithConfigHome } from '../test-support.ts';

import {
	cacheLoginSession,
	DeviceGrantNotEnabledError,
	identitySignIn,
	LoginIdTokenMissingError,
	loginScopeForClient,
	mapDeviceLoginError,
	signInTo
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

describe('mapDeviceLoginError', () => {
	it.each([[400], [401], [403]])(
		'maps a refused device authorization (HTTP %i) for the built-in client',
		(status) => {
			const mapped = mapDeviceLoginError(
				new DeviceAuthorizationRequestError(status),
				cloudflareOauthClientId
			);

			expect(mapped).toBeInstanceOf(DeviceGrantNotEnabledError);

			if (!(mapped instanceof DeviceGrantNotEnabledError)) {
				return;
			}

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
	it('uses the registered Cloudflare scopes without offline_access for the built-in client', () => {
		expect(loginScopeForClient(cloudflareOauthClientId)).toBe(
			signInScopes.join(' ')
		);
	});

	it('leaves custom OIDC clients on the generic login default', () => {
		expect(loginScopeForClient('someone-else')).toBeUndefined();
	});
});

const nowSeconds = 1_700_000_000;

function idToken(claims: Record<string, unknown>): string {
	const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');

	return `e30.${payload}.signature`;
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	return input instanceof URL ? input.href : input.url;
}

interface RecordedRequest {
	readonly url: string;
	readonly form: Readonly<Record<string, string>>;
}

// Approves each Cloudflare authorisation request at its loopback redirect, and
// records the request's URL.
function approvingCloudflareBrowser(
	authorizeUrls: URL[]
): (url: string) => void {
	return (url) => {
		const authorize = new URL(url);
		const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
		callback.searchParams.set('code', 'code-1');
		callback.searchParams.set(
			'state',
			authorize.searchParams.get('state') ?? ''
		);
		authorizeUrls.push(authorize);
		void fetch(callback);
	};
}

describe('signInTo', () => {
	testWithConfigHome(
		'exchanges a new ID token bound to the URL and keeps no Cloudflare grant',
		async () => {
			const requests: RecordedRequest[] = [];
			const authorizeUrls: URL[] = [];
			const infos: string[] = [];
			const fetcher: typeof fetch = (input, init) => {
				const url = requestUrl(input);
				const body = new URLSearchParams(
					typeof init?.body === 'string' ? init.body : ''
				);
				requests.push({ url, form: Object.fromEntries(body) });

				if (url === 'https://dash.cloudflare.com/oauth2/token') {
					const issued = idToken({
						sub: 'cf-user-1',
						iat: nowSeconds,
						nonce: authorizeUrls.at(-1)?.searchParams.get('nonce')
					});

					return Promise.resolve(
						Response.json({
							access_token: 'cf-access',
							expires_in: 3600,
							id_token: issued
						})
					);
				}

				return Promise.resolve(Response.json(tokenResponse('login')));
			};
			const signIn = new BoundSignIn(
				identitySignIn(
					{
						oidcIssuer: cloudflareDashIssuer,
						clientId: cloudflareOauthClientId
					},
					{
						openBrowser: approvingCloudflareBrowser(authorizeUrls),
						info: (message) => {
							infos.push(message);
						},
						fetcher,
						loopbackPorts: [0]
					}
				),
				() => nowSeconds * 1000
			);

			await signInTo(sessionTarget, {
				signIn,
				client: new CupboardClient(sessionTarget, fetcher, {
					kind: 'default'
				}),
				cacheSession: (response, target) => cacheLoginSession(response, target)
			});

			const [authorize] = authorizeUrls;
			const exchange = requests.at(-1)?.form ?? {};
			const seed = exchange.cupboard_binding_seed ?? '';

			expect({
				infos,
				scope: authorize?.searchParams.get('scope'),
				nonce: authorize?.searchParams.get('nonce'),
				requests: requests.map(({ url, form }) => ({
					url,
					grantType: form.grant_type
				})),
				exchange,
				grant: await readCachedGrant(),
				session: await readCachedSession(sessionTarget)
			}).toStrictEqual({
				infos: ['Waiting for you to authorise in your browser…'],
				scope: signInScopes.join(' '),
				nonce: await subjectBindingNonce(
					['https://cupboard.test/t/acme'],
					seed
				),
				requests: [
					{
						url: 'https://dash.cloudflare.com/oauth2/token',
						grantType: 'authorization_code'
					},
					{
						url: 'https://cupboard.test/t/acme/token',
						grantType: 'urn:ietf:params:oauth:grant-type:token-exchange'
					}
				],
				exchange: {
					grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
					subject_token: idToken({
						sub: 'cf-user-1',
						iat: nowSeconds,
						nonce: authorize?.searchParams.get('nonce')
					}),
					subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
					cupboard_binding_seed: seed,
					cupboard_binding_targets: '["https://cupboard.test/t/acme"]'
				},
				grant: undefined,
				session: {
					accessToken: sessionToken('login'),
					refreshToken: 'refresh-login'
				}
			});
		}
	);
});

describe('identitySignIn', () => {
	testWithConfigHome(
		'rejects a Cloudflare sign-in without an ID token and keeps no grant',
		async () => {
			const infos: string[] = [];
			const method = identitySignIn(
				{ oidcIssuer: cloudflareDashIssuer, clientId: cloudflareOauthClientId },
				{
					openBrowser: approvingCloudflareBrowser([]),
					info: (message) => {
						infos.push(message);
					},
					fetcher: () =>
						Promise.resolve(
							Response.json({ access_token: 'cf-access', expires_in: 3600 })
						),
					loopbackPorts: [0]
				}
			);

			let rejected: unknown;

			try {
				await method.signIn('nonce-1');
			} catch (error) {
				rejected = error;
			}

			expect({
				rejected: rejected instanceof LoginIdTokenMissingError,
				bindsNonce: method.bindsNonce,
				infos: infos.length,
				grant: await readCachedGrant()
			}).toStrictEqual({
				rejected: true,
				bindsNonce: true,
				infos: 1,
				grant: undefined
			});
		}
	);
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
			const blocked = Promise.withResolvers<'blocked'>();
			const originalLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi
				.spyOn(lockfile, 'lock')
				.mockImplementation(async (file, options) => {
					try {
						return await originalLock(file, options);
					} catch (error) {
						if (
							error instanceof Error &&
							'code' in error &&
							error.code === 'ELOCKED'
						) {
							blocked.resolve('blocked');
						}

						throw error;
					}
				});
			const login = cacheLoginSession(
				tokenResponse('explicit-login'),
				sessionTarget
			);

			try {
				async function completedLogin(): Promise<'completed'> {
					await login;

					return 'completed';
				}

				const beforeRenewalFinishes = await Promise.race([
					completedLogin(),
					blocked.promise
				]);

				releaseRenewal.resolve(undefined);
				await Promise.all([renewal, login]);

				expect({
					beforeRenewalFinishes,
					session: await readCachedSession(sessionTarget)
				}).toStrictEqual({
					beforeRenewalFinishes: 'blocked',
					session: {
						accessToken: sessionToken('explicit-login'),
						refreshToken: 'refresh-explicit-login'
					}
				});
			} finally {
				releaseRenewal.resolve(undefined);
				await Promise.allSettled([renewal, login]);
				lockSpy.mockRestore();
			}
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
