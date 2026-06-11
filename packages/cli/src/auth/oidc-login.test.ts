import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
	createPkce,
	deviceLogin,
	discoverOidcLogin,
	loopbackLogin,
	type OidcLoginEndpoints,
	OidcLoginError
} from './oidc-login.ts';

const endpoints: OidcLoginEndpoints = {
	authorizationEndpoint: 'https://idp.example.com/authorize',
	tokenEndpoint: 'https://idp.example.com/token',
	deviceAuthorizationEndpoint: 'https://idp.example.com/device'
};

function requestBody(init: RequestInit | undefined): URLSearchParams {
	return new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
}

describe('createPkce', () => {
	it('derives the S256 challenge from the verifier', () => {
		const { verifier, challenge } = createPkce();

		expect({ hasVerifier: verifier.length > 0, challenge }).toStrictEqual({
			hasVerifier: true,
			challenge: createHash('sha256').update(verifier).digest('base64url')
		});
	});
});

describe('discoverOidcLogin', () => {
	it('reads the authorization, token and device endpoints', async () => {
		const discovered = await discoverOidcLogin('https://idp.example.com/', () =>
			Promise.resolve(
				Response.json({
					issuer: 'https://idp.example.com',
					authorization_endpoint: endpoints.authorizationEndpoint,
					token_endpoint: endpoints.tokenEndpoint,
					device_authorization_endpoint: endpoints.deviceAuthorizationEndpoint
				})
			)
		);

		expect(discovered).toStrictEqual(endpoints);
	});

	it('throws when the metadata lacks endpoints', async () => {
		await expect(
			discoverOidcLogin('https://idp.example.com', () =>
				Promise.resolve(Response.json({}))
			)
		).rejects.toBeInstanceOf(OidcLoginError);
	});

	it('rejects an issuer that is not an allowed URL before fetching', async () => {
		let fetched = false;

		await expect(
			discoverOidcLogin('http://idp.example.com', () => {
				fetched = true;

				return Promise.resolve(Response.json({}));
			})
		).rejects.toBeInstanceOf(OidcLoginError);
		expect(fetched).toBe(false);
	});

	it('rejects metadata whose issuer does not match the requested one', async () => {
		await expect(
			discoverOidcLogin('https://idp.example.com', () =>
				Promise.resolve(
					Response.json({
						issuer: 'https://evil.example.com',
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: endpoints.tokenEndpoint
					})
				)
			)
		).rejects.toBeInstanceOf(OidcLoginError);
	});

	it('rejects a redirect away from the metadata endpoint', async () => {
		await expect(
			discoverOidcLogin('https://idp.example.com', () =>
				Promise.resolve(
					new Response(undefined, {
						status: 302,
						headers: { location: 'https://evil.example.com/.well-known' }
					})
				)
			)
		).rejects.toBeInstanceOf(OidcLoginError);
	});

	it('rejects an endpoint served over plain http', async () => {
		await expect(
			discoverOidcLogin('https://idp.example.com', () =>
				Promise.resolve(
					Response.json({
						issuer: 'https://idp.example.com',
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: 'http://idp.example.com/token',
						device_authorization_endpoint: endpoints.deviceAuthorizationEndpoint
					})
				)
			)
		).rejects.toBeInstanceOf(OidcLoginError);
	});
});

describe('loopbackLogin', () => {
	it('completes the PKCE loopback flow and exchanges the code', async () => {
		let exchange: URLSearchParams | undefined;
		const fetcher: typeof fetch = (input, init) => {
			if (input !== endpoints.tokenEndpoint) {
				throw new OidcLoginError('unexpected token endpoint call');
			}

			exchange = requestBody(init);

			return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
		};

		// The browser stand-in plays the identity provider: it follows the
		// authorize URL straight back to the loopback redirect with a code.
		const openBrowser = async (target: string): Promise<void> => {
			const authorize = new URL(target);
			const redirect = authorize.searchParams.get('redirect_uri');
			const state = authorize.searchParams.get('state');

			if (redirect === null || state === null) {
				throw new OidcLoginError('authorize URL missing parameters');
			}

			const callback = new URL(redirect);
			callback.searchParams.set('code', 'auth-code');
			callback.searchParams.set('state', state);
			await fetch(callback);
		};

		const idToken = await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			openBrowser,
			fetcher
		});

		expect({
			idToken,
			grantType: exchange?.get('grant_type'),
			code: exchange?.get('code'),
			clientId: exchange?.get('client_id'),
			hasVerifier: (exchange?.get('code_verifier') ?? '').length > 0,
			loopbackRedirect: (exchange?.get('redirect_uri') ?? '').startsWith(
				'http://127.0.0.1:'
			)
		}).toStrictEqual({
			idToken: 'owner.id.token',
			grantType: 'authorization_code',
			code: 'auth-code',
			clientId: 'client-123',
			hasVerifier: true,
			loopbackRedirect: true
		});
	});

	it('times out when the browser never completes the login', async () => {
		await expect(
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				openBrowser: () => Promise.resolve(),
				fetcher: () => Promise.reject(new Error('should not exchange a code')),
				timeoutMs: 1
			})
		).rejects.toBeInstanceOf(OidcLoginError);
	});

	it('serves a fixed redirect registration when one is given', async () => {
		let redirectUri = '';

		await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			openBrowser: async (target) => {
				const authorize = new URL(target);
				redirectUri = authorize.searchParams.get('redirect_uri') ?? '';
				const callback = new URL(redirectUri);
				callback.searchParams.set('code', 'auth-code');
				callback.searchParams.set(
					'state',
					authorize.searchParams.get('state') ?? ''
				);
				await fetch(callback);
			},
			fetcher: () =>
				Promise.resolve(Response.json({ id_token: 'owner.id.token' })),
			loopback: { ports: [0], host: 'localhost', path: '/oauth/callback' }
		});

		expect({
			host: new URL(redirectUri).hostname,
			path: new URL(redirectUri).pathname
		}).toStrictEqual({ host: 'localhost', path: '/oauth/callback' });
	});

	it('ignores a stray callback and completes on the matching one', async () => {
		let strayStatus = 0;
		const openBrowser = async (target: string): Promise<void> => {
			const authorize = new URL(target);
			const redirect = authorize.searchParams.get('redirect_uri');
			const state = authorize.searchParams.get('state');

			if (redirect === null || state === null) {
				throw new OidcLoginError('authorize URL missing parameters');
			}

			// A stray request with the wrong state must be answered but ignored.
			const stray = new URL(redirect);
			stray.searchParams.set('code', 'stray-code');
			stray.searchParams.set('state', 'not-the-state');
			const strayResponse = await fetch(stray);
			strayStatus = strayResponse.status;

			const callback = new URL(redirect);
			callback.searchParams.set('code', 'auth-code');
			callback.searchParams.set('state', state);
			await fetch(callback);
		};

		const idToken = await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			openBrowser,
			fetcher: () =>
				Promise.resolve(Response.json({ id_token: 'owner.id.token' }))
		});

		expect({ idToken, strayStatus }).toStrictEqual({
			idToken: 'owner.id.token',
			strayStatus: 400
		});
	});

	it('wraps a non-JSON token response as an OidcLoginError', async () => {
		const openBrowser = async (target: string): Promise<void> => {
			const authorize = new URL(target);
			const redirect = authorize.searchParams.get('redirect_uri');
			const state = authorize.searchParams.get('state');

			if (redirect === null || state === null) {
				throw new OidcLoginError('authorize URL missing parameters');
			}

			const callback = new URL(redirect);
			callback.searchParams.set('code', 'auth-code');
			callback.searchParams.set('state', state);
			await fetch(callback);
		};

		await expect(
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				openBrowser,
				fetcher: () =>
					Promise.resolve(new Response('<html>nope</html>', { status: 200 }))
			})
		).rejects.toBeInstanceOf(OidcLoginError);
	});
});

describe('deviceLogin', () => {
	it('polls through pending and slow_down to an id_token', async () => {
		const prompts: { userCode: string; verificationUri: string }[] = [];
		let polls = 0;
		const fetcher: typeof fetch = (input) => {
			if (input === endpoints.deviceAuthorizationEndpoint) {
				return Promise.resolve(
					Response.json({
						device_code: 'dev-code',
						user_code: 'WXYZ-1234',
						verification_uri: 'https://idp.example.com/activate',
						interval: 1
					})
				);
			}

			polls += 1;

			if (polls === 1) {
				return Promise.resolve(
					Response.json({ error: 'authorization_pending' }, { status: 400 })
				);
			}

			if (polls === 2) {
				return Promise.resolve(
					Response.json({ error: 'slow_down' }, { status: 400 })
				);
			}

			return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
		};

		const idToken = await deviceLogin({
			endpoints,
			clientId: 'client-123',
			prompt: (verification) => prompts.push(verification),
			fetcher,
			sleep: () => Promise.resolve()
		});

		expect({ idToken, prompts, polls }).toStrictEqual({
			idToken: 'owner.id.token',
			prompts: [
				{
					userCode: 'WXYZ-1234',
					verificationUri: 'https://idp.example.com/activate'
				}
			],
			polls: 3
		});
	});

	it('refuses the device flow when the issuer does not support it', async () => {
		await expect(
			deviceLogin({
				endpoints: {
					authorizationEndpoint: endpoints.authorizationEndpoint,
					tokenEndpoint: endpoints.tokenEndpoint
				},
				clientId: 'client-123',
				prompt: (verification) => void verification,
				fetcher: () => Promise.reject(new Error('should not be called'))
			})
		).rejects.toBeInstanceOf(OidcLoginError);
	});

	it('stops polling once the device code has expired', async () => {
		const fetcher: typeof fetch = (input) => {
			if (input === endpoints.deviceAuthorizationEndpoint) {
				return Promise.resolve(
					Response.json({
						device_code: 'dev-code',
						user_code: 'WXYZ-1234',
						verification_uri: 'https://idp.example.com/activate',
						expires_in: 1,
						interval: 1
					})
				);
			}

			return Promise.resolve(
				Response.json({ error: 'authorization_pending' }, { status: 400 })
			);
		};
		let elapsed = 0;

		await expect(
			deviceLogin({
				endpoints,
				clientId: 'client-123',
				prompt: (verification) => void verification,
				fetcher,
				sleep: () => Promise.resolve(),
				now: () => {
					const current = elapsed;
					elapsed += 2000;

					return current;
				}
			})
		).rejects.toBeInstanceOf(OidcLoginError);
	});
});
