import type { TextEditOptions } from '@cupboard/cli-ui';
import type { TokenResponse } from '@cupboard/protocol/oidc';
import { subjectBindingNonce } from '@cupboard/protocol/subject-binding';
import lockfile from 'proper-lockfile';
import { describe, expect, it, vi } from 'vitest';

import { BoundSignIn } from '../auth/bound-sign-in.ts';
import { PastedRedirectRefusedError } from '../auth/oidc-login.ts';
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
	identitySignIn,
	LoginIdTokenMissingError,
	loginScopeForClient,
	pastedRedirectReader,
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
				infos: infos.length,
				grant: await readCachedGrant()
			}).toStrictEqual({
				rejected: true,
				infos: 1,
				grant: undefined
			});
		}
	);
});

describe('headless identitySignIn', () => {
	const pasteHint =
		'After you authorise, the browser opens a localhost URL. If that page ' +
		'does not load, copy the URL from the address bar and paste it here.';

	it.each([
		{
			name: 'the Cloudflare client',
			options: {
				oidcIssuer: cloudflareDashIssuer,
				clientId: cloudflareOauthClientId,
				headless: true
			},
			redirect: { host: 'localhost', path: '/oauth/callback' },
			scope: signInScopes.join(' '),
			requests: ['https://dash.cloudflare.com/oauth2/token']
		},
		{
			name: 'an --oidc-issuer client',
			options: {
				oidcIssuer: 'https://idp.example.com',
				clientId: 'cupboard-cli',
				headless: true
			},
			redirect: { host: '127.0.0.1', path: '/callback' },
			scope: 'openid',
			requests: [
				'https://idp.example.com/.well-known/openid-configuration',
				'https://idp.example.com/token'
			]
		}
	])(
		'signs in with $name from a pasted redirect, and opens no browser',
		async ({ options, redirect, scope, requests }) => {
			const infos: string[] = [];
			const opened: string[] = [];
			const requested: string[] = [];
			const authorizeUrl = (): URL =>
				new URL(/https:\/\/\S+/u.exec(infos[0] ?? '')?.[0] ?? '');
			const fetcher: typeof fetch = (input) => {
				const url = requestUrl(input);
				requested.push(url);

				if (url.endsWith('/.well-known/openid-configuration')) {
					return Promise.resolve(
						Response.json({
							issuer: 'https://idp.example.com',
							authorization_endpoint: 'https://idp.example.com/authorize',
							token_endpoint: 'https://idp.example.com/token',
							authorization_response_iss_parameter_supported: true,
							response_types_supported: ['code'],
							subject_types_supported: ['public'],
							id_token_signing_alg_values_supported: ['RS256']
						})
					);
				}

				return Promise.resolve(
					Response.json({
						access_token: 'access',
						expires_in: 3600,
						id_token: 'headless.id.token'
					})
				);
			};
			const method = identitySignIn(options, {
				openBrowser: (target) => {
					opened.push(target);
				},
				info: (message) => {
					infos.push(message);
				},
				readPastedRedirect: () => {
					const authorize = authorizeUrl();
					const callback = new URL(
						authorize.searchParams.get('redirect_uri') ?? ''
					);
					callback.searchParams.set('code', 'pasted-code');
					callback.searchParams.set(
						'state',
						authorize.searchParams.get('state') ?? ''
					);
					callback.searchParams.set('iss', options.oidcIssuer);

					return Promise.resolve(callback.href);
				},
				fetcher,
				loopbackPorts: [0]
			});

			const idToken = await method.signIn('nonce-1');
			const authorize = authorizeUrl();
			const redirectUri = new URL(
				authorize.searchParams.get('redirect_uri') ?? ''
			);

			expect({
				idToken,
				opened,
				infos,
				authorize: {
					nonce: authorize.searchParams.get('nonce'),
					scope: authorize.searchParams.get('scope'),
					redirect: { host: redirectUri.hostname, path: redirectUri.pathname }
				},
				requested
			}).toStrictEqual({
				idToken: 'headless.id.token',
				opened: [],
				infos: [
					`To sign in, open this URL in a browser: ${authorize.href}`,
					pasteHint
				],
				authorize: { nonce: 'nonce-1', scope, redirect },
				requested: requests
			});
		}
	);
});

describe('pastedRedirectReader', () => {
	it('reads the URL through a prompt that the sign-in can close', async () => {
		const prompts: TextEditOptions[] = [];
		const read = pastedRedirectReader({
			interactive: true,
			editText: (options) => {
				prompts.push(options);

				return Promise.resolve({
					kind: 'set',
					value: 'http://localhost:8377/oauth/callback?code=c&state=s'
				});
			}
		});
		const controller = new AbortController();

		const pasted = await read?.(controller.signal);
		const [prompt] = prompts;

		expect({
			pasted,
			signal: prompt?.signal === controller.signal,
			problems: ['not a URL', 'http://localhost:8377/oauth/callback'].map(
				(value) => prompt?.problem?.(value)
			)
		}).toStrictEqual({
			pasted: 'http://localhost:8377/oauth/callback?code=c&state=s',
			signal: true,
			problems: [expect.any(String), undefined]
		});
	});

	it('reports the problem of a refused paste when it asks again', async () => {
		const messages: string[] = [];
		const read = pastedRedirectReader({
			interactive: true,
			editText: (options) => {
				messages.push(options.message);

				return Promise.resolve({ kind: 'cancelled' });
			}
		});
		const { signal } = new AbortController();

		await read?.(signal);
		await read?.(signal, new PastedRedirectRefusedError('other-sign-in'));

		expect({
			count: messages.length,
			reportsProblem: messages.map((message) =>
				message.includes('other-sign-in')
			)
		}).toStrictEqual({ count: 2, reportsProblem: [false, true] });
	});

	it('returns undefined when the prompt is cancelled', async () => {
		const read = pastedRedirectReader({
			interactive: true,
			editText: () => Promise.resolve({ kind: 'cancelled' })
		});

		expect(await read?.(new AbortController().signal)).toBeUndefined();
	});

	it('offers no prompt in a run that cannot prompt', () => {
		const read = pastedRedirectReader({
			interactive: false,
			editText: () => Promise.resolve({ kind: 'cancelled' })
		});

		expect(read).toBeUndefined();
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
