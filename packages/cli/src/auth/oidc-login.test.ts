import { createHash } from 'node:crypto';

import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CliAbortError } from '../errors.ts';

import {
	createPkce,
	deviceLogin,
	discoverOidcLogin,
	LoginTimeoutError,
	loopbackLogin,
	type OidcLoginEndpoints,
	OidcLoginError
} from './oidc-login.ts';

const endpoints: OidcLoginEndpoints = {
	authorizationEndpoint: 'https://idp.example.com/authorize',
	tokenEndpoint: 'https://idp.example.com/token',
	deviceAuthorizationEndpoint: 'https://idp.example.com/device'
};

function pendingPromise(): Promise<never> {
	return new Promise<never>(() => {
		// Intentionally pending.
	});
}

function requestBody(init: RequestInit | undefined): URLSearchParams {
	return new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

function authorizeParameters(target: string): {
	readonly redirectUri: string;
	readonly state: string;
} {
	const authorize = new URL(target);

	return z
		.object({
			redirectUri: z.string().min(1),
			state: z.string().min(1)
		})
		.parse({
			redirectUri: authorize.searchParams.get('redirect_uri'),
			state: authorize.searchParams.get('state')
		});
}

async function approveLoopbackBrowser(target: string): Promise<void> {
	const { redirectUri, state } = authorizeParameters(target);
	const callback = new URL(redirectUri);
	callback.searchParams.set('code', 'auth-code');
	callback.searchParams.set('state', state);
	await fetch(callback);
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
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
	it('rejects oversized discovery metadata through the bounded reader', async () => {
		const caught = await rejectedBy(() =>
			discoverOidcLogin('https://idp.example.com', () =>
				Promise.resolve(
					new Response('{}', {
						headers: { 'content-length': String(1024 * 1024 + 1) }
					})
				)
			)
		);

		expect(caught).toBeInstanceOf(RemoteBodyTooLargeError);
	});

	it('reads the authorization, token and device endpoints', async () => {
		const discovered = await discoverOidcLogin('https://idp.example.com/', () =>
			Promise.resolve(
				Response.json({
					issuer: 'https://idp.example.com/',
					authorization_endpoint: endpoints.authorizationEndpoint,
					token_endpoint: endpoints.tokenEndpoint,
					device_authorization_endpoint: endpoints.deviceAuthorizationEndpoint
				})
			)
		);

		expect(discovered).toStrictEqual(endpoints);
	});

	it('passes the abort signal to the metadata request', async () => {
		const controller = new AbortController();
		let signal: AbortSignal | null | undefined;

		await discoverOidcLogin(
			'https://idp.example.com/',
			(_input, init) => {
				signal = init?.signal;

				return Promise.resolve(
					Response.json({
						issuer: 'https://idp.example.com/',
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: endpoints.tokenEndpoint
					})
				);
			},
			controller.signal
		);

		expect(signal).toBe(controller.signal);
	});

	it('throws when the metadata lacks endpoints', async () => {
		const requests: string[] = [];
		const caught = await rejectedBy(() =>
			discoverOidcLogin('https://idp.example.com', (input) => {
				requests.push(requestUrl(input));

				return Promise.resolve(Response.json({}));
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: { name: caught.name, kind: caught.kind, issuer: caught.issuer },
			requests
		}).toStrictEqual({
			error: {
				name: 'OidcLoginError',
				kind: 'discovery-schema',
				issuer: 'https://idp.example.com'
			},
			requests: ['https://idp.example.com/.well-known/openid-configuration']
		});
	});

	it('rejects an issuer that is not an allowed URL before fetching', async () => {
		const requests: string[] = [];

		const caught = await rejectedBy(() =>
			discoverOidcLogin('http://idp.example.com', (input) => {
				requests.push(requestUrl(input));

				return Promise.resolve(Response.json({}));
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: { name: caught.name, kind: caught.kind, issuer: caught.issuer },
			requests
		}).toStrictEqual({
			error: {
				name: 'OidcLoginError',
				kind: 'invalid-issuer',
				issuer: 'http://idp.example.com'
			},
			requests: []
		});
	});

	it('rejects metadata whose issuer does not match the requested one', async () => {
		const requests: string[] = [];
		const caught = await rejectedBy(() =>
			discoverOidcLogin('https://idp.example.com', (input) => {
				requests.push(requestUrl(input));

				return Promise.resolve(
					Response.json({
						issuer: 'https://evil.example.com',
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: endpoints.tokenEndpoint
					})
				);
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: {
				name: caught.name,
				kind: caught.kind,
				issuer: caught.issuer,
				metadataIssuer: caught.metadataIssuer
			},
			requests
		}).toStrictEqual({
			error: {
				name: 'OidcLoginError',
				kind: 'issuer-mismatch',
				issuer: 'https://idp.example.com',
				metadataIssuer: 'https://evil.example.com'
			},
			requests: ['https://idp.example.com/.well-known/openid-configuration']
		});
	});

	it('rejects a redirect away from the metadata endpoint', async () => {
		const requests: string[] = [];
		const caught = await rejectedBy(() =>
			discoverOidcLogin('https://idp.example.com', (input) => {
				requests.push(requestUrl(input));

				return Promise.resolve(
					new Response(undefined, {
						status: 302,
						headers: { location: 'https://evil.example.com/.well-known' }
					})
				);
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: {
				name: caught.name,
				kind: caught.kind,
				issuer: caught.issuer,
				status: caught.status
			},
			requests
		}).toStrictEqual({
			error: {
				name: 'OidcLoginError',
				kind: 'discovery-http',
				issuer: 'https://idp.example.com',
				status: 302
			},
			requests: ['https://idp.example.com/.well-known/openid-configuration']
		});
	});

	it('rejects an endpoint served over plain http', async () => {
		const requests: string[] = [];
		const caught = await rejectedBy(() =>
			discoverOidcLogin('https://idp.example.com', (input) => {
				requests.push(requestUrl(input));

				return Promise.resolve(
					Response.json({
						issuer: 'https://idp.example.com',
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: 'http://idp.example.com/token',
						device_authorization_endpoint: endpoints.deviceAuthorizationEndpoint
					})
				);
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: { name: caught.name, kind: caught.kind, issuer: caught.issuer },
			requests
		}).toStrictEqual({
			error: {
				name: 'OidcLoginError',
				kind: 'discovery-schema',
				issuer: 'https://idp.example.com'
			},
			requests: ['https://idp.example.com/.well-known/openid-configuration']
		});
	});
});

describe('loopbackLogin', () => {
	it('completes the PKCE loopback flow and exchanges the code', async () => {
		let exchange: URLSearchParams | undefined;
		const tokenRequests: unknown[] = [];
		const fetcher: typeof fetch = (input, init) => {
			tokenRequests.push(input);

			exchange = requestBody(init);

			return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
		};

		const idToken = await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			openBrowser: approveLoopbackBrowser,
			fetcher
		});

		expect({
			idToken,
			tokenRequests,
			grantType: exchange?.get('grant_type'),
			code: exchange?.get('code'),
			clientId: exchange?.get('client_id'),
			hasVerifier: (exchange?.get('code_verifier') ?? '').length > 0,
			loopbackRedirect: (exchange?.get('redirect_uri') ?? '').startsWith(
				'http://127.0.0.1:'
			)
		}).toStrictEqual({
			idToken: 'owner.id.token',
			tokenRequests: [endpoints.tokenEndpoint],
			grantType: 'authorization_code',
			code: 'auth-code',
			clientId: 'client-123',
			hasVerifier: true,
			loopbackRedirect: true
		});
	});

	it('times out when the browser never completes the login', async () => {
		const openedBrowsers: string[] = [];
		const tokenRequests: string[] = [];

		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				openBrowser: (target) => {
					openedBrowsers.push(target);
					return Promise.resolve();
				},
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				},
				timeoutMs: 1
			})
		);

		expect(caught).toBeInstanceOf(LoginTimeoutError);

		if (!(caught instanceof LoginTimeoutError)) {
			return;
		}

		expect({
			error: { name: caught.name },
			openedBrowsers: openedBrowsers.map((target) => {
				const url = new URL(target);
				return url.origin;
			}),
			tokenRequests
		}).toStrictEqual({
			error: { name: 'LoginTimeoutError' },
			openedBrowsers: ['https://idp.example.com'],
			tokenRequests: []
		});
	});

	it('aborts while waiting for the browser callback', async () => {
		const controller = new AbortController();
		const openedBrowsers: string[] = [];
		const tokenRequests: string[] = [];

		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				openBrowser: (target) => {
					openedBrowsers.push(target);
					controller.abort(new CliAbortError());
				},
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				},
				timeoutMs: 60_000,
				signal: controller.signal
			})
		);

		expect(caught).toBeInstanceOf(CliAbortError);

		if (!(caught instanceof CliAbortError)) {
			return;
		}

		expect({
			error: { name: caught.name },
			openedBrowsers: openedBrowsers.map((target) => {
				const url = new URL(target);
				return url.origin;
			}),
			tokenRequests,
			aborted: controller.signal.aborted
		}).toStrictEqual({
			error: { name: 'CliAbortError' },
			openedBrowsers: ['https://idp.example.com'],
			tokenRequests: [],
			aborted: true
		});
	});

	it('serves a fixed redirect registration when one is given', async () => {
		let redirectUri = '';

		await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			openBrowser: async (target) => {
				const parameters = authorizeParameters(target);
				redirectUri = parameters.redirectUri;
				const callback = new URL(redirectUri);
				callback.searchParams.set('code', 'auth-code');
				callback.searchParams.set('state', parameters.state);
				await fetch(callback);
			},
			fetcher: () =>
				Promise.resolve(Response.json({ id_token: 'owner.id.token' })),
			loopback: { ports: [0], host: 'localhost', path: '/oauth/callback' }
		});

		const redirectUrl = new URL(redirectUri);

		expect({
			host: redirectUrl.hostname,
			path: redirectUrl.pathname
		}).toStrictEqual({ host: 'localhost', path: '/oauth/callback' });
	});

	it('ignores a stray callback and completes on the matching one', async () => {
		let strayStatus = 0;
		const openBrowser = async (target: string): Promise<void> => {
			const { redirectUri, state } = authorizeParameters(target);

			const stray = new URL(redirectUri);
			stray.searchParams.set('code', 'stray-code');
			stray.searchParams.set('state', 'not-the-state');
			const strayResponse = await fetch(stray);
			strayStatus = strayResponse.status;

			const callback = new URL(redirectUri);
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

	it('reports a non-JSON token response as token-non-json', async () => {
		const tokenRequests: string[] = [];
		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				openBrowser: approveLoopbackBrowser,
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(
						new Response('<html>nope</html>', { status: 200 })
					);
				}
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: { name: caught.name, kind: caught.kind },
			tokenRequests
		}).toStrictEqual({
			error: { name: 'OidcLoginError', kind: 'token-non-json' },
			tokenRequests: [endpoints.tokenEndpoint]
		});
	});
});

describe('deviceLogin', () => {
	it('polls through pending and slow_down to an id_token', async () => {
		const prompts: {
			userCode: string;
			verificationUri: string;
			verificationUriComplete?: string;
		}[] = [];
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
			prompt: (verification) => {
				prompts.push(verification);
			},
			fetcher,
			sleep: () => Promise.resolve()
		});

		expect({ idToken, prompts, polls }).toStrictEqual({
			idToken: 'owner.id.token',
			prompts: [
				{
					userCode: 'WXYZ-1234',
					verificationUri: 'https://idp.example.com/activate',
					verificationUriComplete: undefined
				}
			],
			polls: 3
		});
	});

	it('passes the complete verification URL through when the issuer sends one', async () => {
		const prompts: {
			userCode: string;
			verificationUri: string;
			verificationUriComplete?: string;
		}[] = [];
		const fetcher: typeof fetch = (input) => {
			if (input === endpoints.deviceAuthorizationEndpoint) {
				return Promise.resolve(
					Response.json({
						device_code: 'dev-code',
						user_code: 'WXYZ-1234',
						verification_uri: 'https://idp.example.com/activate',
						verification_uri_complete:
							'https://idp.example.com/activate?code=WXYZ-1234',
						interval: 1
					})
				);
			}

			return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
		};

		await deviceLogin({
			endpoints,
			clientId: 'client-123',
			prompt: (verification) => {
				prompts.push(verification);
			},
			fetcher,
			sleep: () => Promise.resolve()
		});

		expect(prompts).toStrictEqual([
			{
				userCode: 'WXYZ-1234',
				verificationUri: 'https://idp.example.com/activate',
				verificationUriComplete:
					'https://idp.example.com/activate?code=WXYZ-1234'
			}
		]);
	});

	it('refuses the device flow when the issuer does not support it', async () => {
		const prompts: unknown[] = [];
		const requests: string[] = [];
		const caught = await rejectedBy(() =>
			deviceLogin({
				endpoints: {
					authorizationEndpoint: endpoints.authorizationEndpoint,
					tokenEndpoint: endpoints.tokenEndpoint
				},
				clientId: 'client-123',
				prompt: (verification) => {
					prompts.push(verification);
				},
				fetcher: (input) => {
					requests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				}
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: { name: caught.name, kind: caught.kind },
			prompts,
			requests
		}).toStrictEqual({
			error: { name: 'OidcLoginError', kind: 'unsupported-device-flow' },
			prompts: [],
			requests: []
		});
	});

	it('stops polling once the device code has expired', async () => {
		const requests: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requests.push(requestUrl(input));

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

		const caught = await rejectedBy(() =>
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
		);

		expect(caught).toBeInstanceOf(OidcLoginError);

		if (!(caught instanceof OidcLoginError)) {
			return;
		}

		expect({
			error: { name: caught.name, kind: caught.kind },
			requests
		}).toStrictEqual({
			error: { name: 'OidcLoginError', kind: 'device-expired' },
			requests: [endpoints.deviceAuthorizationEndpoint]
		});
	});

	it('aborts while waiting between device token polls', async () => {
		const controller = new AbortController();
		const prompts: unknown[] = [];
		const requests: string[] = [];

		const caught = await rejectedBy(() =>
			deviceLogin({
				endpoints,
				clientId: 'client-123',
				prompt: (verification) => {
					prompts.push(verification);
					controller.abort(new CliAbortError());
				},
				fetcher: (input) => {
					requests.push(requestUrl(input));

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

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				},
				sleep: pendingPromise,
				signal: controller.signal
			})
		);

		expect(caught).toBeInstanceOf(CliAbortError);

		if (!(caught instanceof CliAbortError)) {
			return;
		}

		expect({
			error: { name: caught.name },
			prompts,
			requests,
			aborted: controller.signal.aborted
		}).toStrictEqual({
			error: { name: 'CliAbortError' },
			prompts: [
				{
					userCode: 'WXYZ-1234',
					verificationUri: 'https://idp.example.com/activate',
					verificationUriComplete: undefined
				}
			],
			requests: [endpoints.deviceAuthorizationEndpoint],
			aborted: true
		});
	});
});
