import { createHash } from 'node:crypto';

import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import { StatusCodes } from 'http-status-codes';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CliAbortError } from '../errors.ts';
import { RedirectingOrigin } from '../redirecting-origin.test-support.ts';

import {
	createPkce,
	discoverOidcLogin,
	isRedirectStatus,
	LoginTimeoutError,
	loopbackLogin,
	obtainAuthorizationCode,
	type OidcLoginEndpoints,
	OidcLoginError,
	type PastedRedirectReader
} from './oidc-login.ts';

const endpoints: OidcLoginEndpoints = {
	issuer: 'https://idp.example.com',
	authorizationEndpoint: 'https://idp.example.com/authorize',
	tokenEndpoint: 'https://idp.example.com/token'
};

const providerCapabilities = {
	response_types_supported: ['id_token', 'code'],
	subject_types_supported: ['public'],
	id_token_signing_alg_values_supported: ['RS256']
} as const;

const discoveryCapabilities = {
	...providerCapabilities,
	authorization_response_iss_parameter_supported: true
} as const;

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
	callback.searchParams.set('iss', 'https://idp.example.com');
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

	it('reads the authorization and token endpoints', async () => {
		const discovered = await discoverOidcLogin('https://idp.example.com/', () =>
			Promise.resolve(
				Response.json({
					issuer: 'https://idp.example.com/',
					...discoveryCapabilities,
					authorization_endpoint: endpoints.authorizationEndpoint,
					token_endpoint: endpoints.tokenEndpoint
				})
			)
		);

		expect(discovered).toStrictEqual({
			...endpoints,
			issuer: 'https://idp.example.com/'
		});
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
						...discoveryCapabilities,
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: endpoints.tokenEndpoint
					})
				);
			},
			controller.signal
		);

		expect(signal).toBe(controller.signal);
	});

	it.each([
		{
			name: 'an authorization endpoint',
			metadata: {
				issuer: endpoints.issuer,
				...discoveryCapabilities,
				token_endpoint: endpoints.tokenEndpoint
			}
		},
		{
			name: 'a token endpoint',
			metadata: {
				issuer: endpoints.issuer,
				...discoveryCapabilities,
				authorization_endpoint: endpoints.authorizationEndpoint
			}
		}
	])('throws when the metadata lacks $name', async ({ metadata }) => {
		const requests: string[] = [];
		const caught = await rejectedBy(() =>
			discoverOidcLogin('https://idp.example.com', (input) => {
				requests.push(requestUrl(input));

				return Promise.resolve(Response.json(metadata));
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

	it.each([
		{
			name: 'authorization-code response support',
			response: () =>
				Response.json({
					issuer: endpoints.issuer,
					...discoveryCapabilities,
					response_types_supported: ['id_token'],
					authorization_endpoint: endpoints.authorizationEndpoint,
					token_endpoint: endpoints.tokenEndpoint
				})
		},
		{
			name: 'RS256 support',
			response: () =>
				Response.json({
					issuer: endpoints.issuer,
					...discoveryCapabilities,
					id_token_signing_alg_values_supported: ['ES256'],
					authorization_endpoint: endpoints.authorizationEndpoint,
					token_endpoint: endpoints.tokenEndpoint
				})
		},
		{
			name: 'an application/json media type',
			response: () =>
				Response.json(
					{
						issuer: endpoints.issuer,
						...discoveryCapabilities,
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: endpoints.tokenEndpoint
					},
					{ headers: { 'content-type': 'text/plain' } }
				)
		}
	])('rejects metadata without $name', async ({ response }) => {
		await expect(
			discoverOidcLogin(endpoints.issuer, () => Promise.resolve(response()))
		).rejects.toBeInstanceOf(OidcLoginError);
	});

	it.each([
		{ name: 'omits issuer response support', capability: {} },
		{
			name: 'disables issuer response support',
			capability: { authorization_response_iss_parameter_supported: false }
		},
		{
			name: 'uses a non-boolean issuer response support value',
			capability: { authorization_response_iss_parameter_supported: 'true' }
		}
	])('rejects metadata that $name', async ({ capability }) => {
		await expect(
			discoverOidcLogin(endpoints.issuer, () =>
				Promise.resolve(
					Response.json({
						issuer: endpoints.issuer,
						...providerCapabilities,
						...capability,
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: endpoints.tokenEndpoint
					})
				)
			)
		).rejects.toBeInstanceOf(OidcLoginError);
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
						...discoveryCapabilities,
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
						...discoveryCapabilities,
						authorization_endpoint: endpoints.authorizationEndpoint,
						token_endpoint: 'http://idp.example.com/token'
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
	it('requires the callback issuer before the token request', async () => {
		const tokenRequests: string[] = [];
		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				nonce: 'nonce-1',
				openBrowser: async (target) => {
					const { redirectUri, state } = authorizeParameters(target);
					const callback = new URL(redirectUri);
					callback.searchParams.set('code', 'unbound-code');
					callback.searchParams.set('state', state);
					await fetch(callback);
				},
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				}
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);
		expect(tokenRequests).toStrictEqual([]);
	});

	it('refuses a callback from another issuer before the token request', async () => {
		const tokenRequests: string[] = [];
		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints: { ...endpoints, issuer: 'https://idp.example.com' },
				clientId: 'client-123',
				nonce: 'nonce-1',
				openBrowser: async (target) => {
					const { redirectUri, state } = authorizeParameters(target);
					const callback = new URL(redirectUri);
					callback.searchParams.set('code', 'attacker-code');
					callback.searchParams.set('state', state);
					callback.searchParams.set('iss', 'https://evil.example.com');
					await fetch(callback);
				},
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				}
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);
		expect(tokenRequests).toStrictEqual([]);
	});

	it.each([
		{
			name: 'a duplicate issuer',
			responseIssuers: [endpoints.issuer, endpoints.issuer]
		},
		{ name: 'a malformed issuer', responseIssuers: ['not an issuer'] }
	])('refuses $name before the token request', async ({ responseIssuers }) => {
		const tokenRequests: string[] = [];
		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				nonce: 'nonce-1',
				openBrowser: async (target) => {
					const { redirectUri, state } = authorizeParameters(target);
					const callback = new URL(redirectUri);
					callback.searchParams.set('code', 'unbound-code');
					callback.searchParams.set('state', state);
					for (const responseIssuer of responseIssuers) {
						callback.searchParams.append('iss', responseIssuer);
					}
					await fetch(callback);
				},
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				}
			})
		);

		expect(caught).toBeInstanceOf(OidcLoginError);
		expect(tokenRequests).toStrictEqual([]);
	});

	it.each(['state', 'iss', 'code', 'error'] as const)(
		'refuses a repeated %s parameter before the token request',
		async (parameter) => {
			const tokenRequests: string[] = [];
			const caught = await rejectedBy(() =>
				loopbackLogin({
					endpoints,
					clientId: 'client-123',
					nonce: 'nonce-1',
					openBrowser: async (target) => {
						const { redirectUri, state } = authorizeParameters(target);
						const callback = new URL(redirectUri);
						callback.searchParams.set('code', 'auth-code');
						callback.searchParams.set('state', state);
						callback.searchParams.set('iss', endpoints.issuer);

						if (parameter === 'error') {
							callback.searchParams.set('error', 'access_denied');
						}

						const duplicateValues = {
							state,
							iss: endpoints.issuer,
							code: 'duplicate',
							error: 'duplicate'
						} as const;

						callback.searchParams.append(parameter, duplicateValues[parameter]);
						await fetch(callback);
					},
					fetcher: (input) => {
						tokenRequests.push(requestUrl(input));

						return Promise.resolve(Response.json({ id_token: 'unused' }));
					}
				})
			);

			expect(caught).toBeInstanceOf(OidcLoginError);

			if (!(caught instanceof OidcLoginError)) {
				return;
			}

			expect({ message: caught.message, tokenRequests }).toStrictEqual({
				message: `Authorization response includes repeated ${parameter} parameter`,
				tokenRequests: []
			});
		}
	);

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
			nonce: 'nonce-1',
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

	it('requests the nonce in the authorization URL', async () => {
		const requested: (string | null)[] = [];

		await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			nonce: 'nonce-1',
			openBrowser: async (target) => {
				requested.push(new URL(target).searchParams.get('nonce'));
				await approveLoopbackBrowser(target);
			},
			fetcher: () =>
				Promise.resolve(Response.json({ id_token: 'owner.id.token' }))
		});

		expect(requested).toStrictEqual(['nonce-1']);
	});

	it('times out when the browser never completes the login', async () => {
		const openedBrowsers: string[] = [];
		const tokenRequests: string[] = [];

		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				nonce: 'nonce-1',
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
				nonce: 'nonce-1',
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
			nonce: 'nonce-1',
			openBrowser: async (target) => {
				const parameters = authorizeParameters(target);
				redirectUri = parameters.redirectUri;
				const callback = new URL(redirectUri);
				callback.searchParams.set('code', 'auth-code');
				callback.searchParams.set('state', parameters.state);
				callback.searchParams.set('iss', 'https://idp.example.com');
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
			callback.searchParams.set('iss', 'https://idp.example.com');
			await fetch(callback);
		};

		const idToken = await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			nonce: 'nonce-1',
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
				nonce: 'nonce-1',
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

describe('obtainAuthorizationCode', () => {
	function browserReturning(
		issuer: string | undefined
	): (target: string) => Promise<void> {
		return async (target) => {
			const { redirectUri, state } = authorizeParameters(target);
			const callback = new URL(redirectUri);
			callback.searchParams.set('code', 'auth-code');
			callback.searchParams.set('state', state);

			if (issuer !== undefined) {
				callback.searchParams.set('iss', issuer);
			}

			await fetch(callback);
		};
	}

	it.each([
		{ name: 'without iss', issuer: undefined, outcome: 'auth-code' },
		{
			name: 'with the expected iss',
			issuer: 'https://idp.example.com',
			outcome: 'auth-code'
		},
		{
			name: 'with another iss',
			issuer: 'https://evil.example.com',
			outcome: 'OidcLoginError'
		}
	])(
		'for an issuer without RFC 9207 support, handles a callback $name',
		async ({ issuer, outcome }) => {
			let result: string;

			try {
				const obtained = await obtainAuthorizationCode({
					expectedIssuer: 'https://idp.example.com',
					isIssuerParameterOptional: true,
					authorizationEndpoint: endpoints.authorizationEndpoint,
					clientId: 'client-123',
					scope: 'openid',
					nonce: 'nonce-1',
					openBrowser: browserReturning(issuer)
				});
				result = obtained.code;
			} catch (error) {
				result = error instanceof OidcLoginError ? error.name : 'unexpected';
			}

			expect(result).toBe(outcome);
		}
	);
});

// The redirect URL for the authorisation URL `target`, as the issuer sends it,
// after `change`.
function redirectFor(
	target: string,
	change?: (callback: URL, state: string) => void
): string {
	const { redirectUri, state } = authorizeParameters(target);
	const callback = new URL(redirectUri);
	callback.searchParams.set('code', 'pasted-code');
	callback.searchParams.set('state', state);
	callback.searchParams.set('iss', endpoints.issuer);
	change?.(callback, state);

	return callback.href;
}

describe('pasted redirect', () => {
	interface PastingUser {
		readonly openBrowser: (target: string) => void;
		readonly readPastedRedirect: PastedRedirectReader;
		readonly promptSignals: AbortSignal[];
	}

	// Opens no browser. The paste prompt waits for the authorisation URL and
	// returns what `paste` builds from it, as a user would paste it.
	function pastingUser(
		paste: (authorize: string) => Promise<string | undefined>
	): PastingUser {
		const opened = Promise.withResolvers<string>();
		const promptSignals: AbortSignal[] = [];

		return {
			openBrowser: (target) => {
				opened.resolve(target);
			},
			readPastedRedirect: async (signal) => {
				promptSignals.push(signal);

				return paste(await opened.promise);
			},
			promptSignals
		};
	}

	it('completes the sign-in with a pasted redirect URL', async () => {
		const user = pastingUser((target) =>
			Promise.resolve(`  ${redirectFor(target)}\n`)
		);
		const codes: (string | null)[] = [];

		const idToken = await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			nonce: 'nonce-1',
			openBrowser: user.openBrowser,
			readPastedRedirect: user.readPastedRedirect,
			fetcher: (_input, init) => {
				codes.push(requestBody(init).get('code'));

				return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
			}
		});

		expect({
			idToken,
			codes,
			promptsClosed: user.promptSignals.map((signal) => signal.aborted)
		}).toStrictEqual({
			idToken: 'owner.id.token',
			codes: ['pasted-code'],
			promptsClosed: [true]
		});
	});

	it.each([
		{
			name: 'the state of another sign-in',
			paste: (target: string) =>
				redirectFor(target, (callback) => {
					callback.searchParams.set('state', 'another-sign-in');
				}),
			problem: 'other-sign-in'
		},
		{
			name: 'another issuer',
			paste: (target: string) =>
				redirectFor(target, (callback) => {
					callback.searchParams.set('iss', 'https://evil.example.com');
				}),
			problem: 'issuer-mismatch'
		},
		{
			name: 'a repeated state',
			paste: (target: string) =>
				redirectFor(target, (callback, state) => {
					callback.searchParams.append('state', state);
				}),
			problem: 'repeated-parameter'
		},
		{
			name: 'a repeated code',
			paste: (target: string) =>
				redirectFor(target, (callback) => {
					callback.searchParams.append('code', 'another-code');
				}),
			problem: 'repeated-parameter'
		},
		{
			name: 'no code',
			paste: (target: string) =>
				redirectFor(target, (callback) => {
					callback.searchParams.delete('code');
				}),
			problem: 'missing-code'
		},
		{
			name: 'text that is not a URL',
			paste: () => 'pasted-code',
			problem: 'not-a-url'
		}
	])(
		'refuses a pasted URL with $name before the token request',
		async ({ paste, problem }) => {
			const opened = Promise.withResolvers<string>();
			const refusals: unknown[] = [];
			const tokenRequests: string[] = [];

			// The user pastes once and cancels the prompt that reports the refusal.
			const caught = await rejectedBy(() =>
				loopbackLogin({
					endpoints,
					clientId: 'client-123',
					nonce: 'nonce-1',
					openBrowser: (target) => {
						opened.resolve(target);
					},
					readPastedRedirect: async (_signal, refusal) => {
						if (refusal !== undefined) {
							refusals.push({
								name: refusal.name,
								kind: refusal.kind,
								problem: refusal.problem
							});

							return;
						}

						return paste(await opened.promise);
					},
					fetcher: (input) => {
						tokenRequests.push(requestUrl(input));

						return Promise.resolve(Response.json({ id_token: 'unused' }));
					}
				})
			);

			expect({
				aborted: caught instanceof CliAbortError,
				refusals,
				tokenRequests
			}).toStrictEqual({
				aborted: true,
				refusals: [
					{
						name: 'PastedRedirectRefusedError',
						kind: 'pasted-redirect-refused',
						problem
					}
				],
				tokenRequests: []
			});
		}
	);

	it.each([
		{
			name: 'a second paste',
			// The second answer is the redirect itself.
			second: (target: string) => Promise.resolve(redirectFor(target)),
			code: 'pasted-code'
		},
		{
			name: 'the loopback redirect',
			// The browser reaches the loopback server while the second prompt is
			// open, and the prompt then closes.
			second: async (target: string, signal: AbortSignal) => {
				const closed = Promise.withResolvers<undefined>();
				signal.addEventListener('abort', () => {
					closed.resolve(undefined);
				});
				await approveLoopbackBrowser(target);

				return closed.promise;
			},
			code: 'auth-code'
		}
	])(
		'reports a refused paste and completes with $name',
		async ({ second, code }) => {
			const opened = Promise.withResolvers<string>();
			const refusals: (string | undefined)[] = [];
			const codes: (string | null)[] = [];

			const idToken = await loopbackLogin({
				endpoints,
				clientId: 'client-123',
				nonce: 'nonce-1',
				openBrowser: (target) => {
					opened.resolve(target);
				},
				readPastedRedirect: async (signal, refusal) => {
					refusals.push(refusal?.problem);
					const target = await opened.promise;

					return refusal === undefined
						? redirectFor(target, (callback) => {
								callback.searchParams.set('state', 'another-sign-in');
							})
						: second(target, signal);
				},
				fetcher: (_input, init) => {
					codes.push(requestBody(init).get('code'));

					return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
				}
			});

			expect({ idToken, refusals, codes }).toStrictEqual({
				idToken: 'owner.id.token',
				refusals: [undefined, 'other-sign-in'],
				codes: [code]
			});
		}
	);

	it('completes on a loopback redirect that arrives before a paste, and closes the prompt', async () => {
		const promptSignals: AbortSignal[] = [];
		const codes: (string | null)[] = [];

		const idToken = await loopbackLogin({
			endpoints,
			clientId: 'client-123',
			nonce: 'nonce-1',
			openBrowser: approveLoopbackBrowser,
			// Like a terminal prompt, this resolves without an answer once its
			// signal aborts.
			readPastedRedirect: (signal) => {
				promptSignals.push(signal);
				const closed = Promise.withResolvers<undefined>();
				signal.addEventListener('abort', () => {
					closed.resolve(undefined);
				});

				return closed.promise;
			},
			fetcher: (_input, init) => {
				codes.push(requestBody(init).get('code'));

				return Promise.resolve(Response.json({ id_token: 'owner.id.token' }));
			}
		});

		expect({
			idToken,
			codes,
			promptsClosed: promptSignals.map((signal) => signal.aborted)
		}).toStrictEqual({
			idToken: 'owner.id.token',
			codes: ['auth-code'],
			promptsClosed: [true]
		});
	});

	it('aborts the sign-in when the user cancels the paste prompt', async () => {
		const user = pastingUser(() => Promise.resolve(undefined));
		const tokenRequests: string[] = [];

		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints,
				clientId: 'client-123',
				nonce: 'nonce-1',
				openBrowser: user.openBrowser,
				readPastedRedirect: user.readPastedRedirect,
				fetcher: (input) => {
					tokenRequests.push(requestUrl(input));

					return Promise.resolve(Response.json({ id_token: 'unused' }));
				}
			})
		);

		expect({
			aborted: caught instanceof CliAbortError,
			tokenRequests
		}).toStrictEqual({ aborted: true, tokenRequests: [] });
	});
});

describe('token endpoint redirects', () => {
	let origin: RedirectingOrigin | undefined;

	afterEach(async () => {
		await origin?.close();
		origin = undefined;
	});

	it('fails on a redirect from the authorisation code exchange without following it', async () => {
		const started = await RedirectingOrigin.start(['/token'], {});
		origin = started;

		const caught = await rejectedBy(() =>
			loopbackLogin({
				endpoints: { ...endpoints, tokenEndpoint: started.url('/token') },
				clientId: 'client-123',
				nonce: 'nonce-1',
				openBrowser: approveLoopbackBrowser,
				fetcher: fetch
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
				status: caught.status
			},
			requests: started.requests
		}).toStrictEqual({
			error: {
				name: 'OidcLoginError',
				kind: 'token-http',
				status: StatusCodes.TEMPORARY_REDIRECT
			},
			requests: ['/token']
		});
	});
});

describe('isRedirectStatus', () => {
	it.each([
		{ status: StatusCodes.MOVED_PERMANENTLY, redirect: true },
		{ status: StatusCodes.MOVED_TEMPORARILY, redirect: true },
		{ status: StatusCodes.SEE_OTHER, redirect: true },
		{ status: StatusCodes.TEMPORARY_REDIRECT, redirect: true },
		{ status: StatusCodes.PERMANENT_REDIRECT, redirect: true },
		{ status: StatusCodes.MULTIPLE_CHOICES, redirect: false },
		{ status: StatusCodes.NOT_MODIFIED, redirect: false },
		{ status: StatusCodes.OK, redirect: false }
	])('returns $redirect for $status', ({ status, redirect }) => {
		expect(isRedirectStatus(status)).toBe(redirect);
	});
});
