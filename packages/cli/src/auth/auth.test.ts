import type {
	ParsedTokenResponse,
	TokenResponse
} from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../client/client.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import { CupboardHttpError, OwnerLoginRequiredError } from '../errors.ts';
import { testWithConfigHome } from '../test-support.ts';

import {
	authenticateForPush,
	authenticateGithubOidc,
	cachedOwnerProvider,
	type OwnerSessionDependencies
} from './auth.ts';
import type { GithubOidcEnvironment } from './github-oidc.ts';
import { type CachedSession, writeCachedSession } from './token-store.ts';

const githubEnvironment: GithubOidcEnvironment = {
	requestUrl: 'https://actions.example.com/token',
	requestToken: 'request-bearer'
};

function requestUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

// A fetcher answering the GitHub OIDC request with a fresh subject token and
// the cupboard exchange with a write token derived from it, so a refresh yields
// a distinct token end to end.
function federatingClient(): CupboardClient {
	let issued = 0;

	return new CupboardClient(new URL('https://cupboard.test'), (input) => {
		const url = new URL(requestUrl(input));

		if (url.origin === 'https://actions.example.com') {
			issued += 1;

			return Promise.resolve(
				Response.json({ value: `subject-${String(issued)}` })
			);
		}

		return Promise.resolve(
			Response.json({
				access_token: `write-${String(issued)}`,
				token_type: 'Bearer',
				expires_in: 900,
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
			} satisfies TokenResponse)
		);
	});
}

const target = 'https://cupboard.test';

function encodeJwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${encodeJwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${encodeJwtSegment(claims)}.signature`;
}

describe('authenticateGithubOidc', () => {
	it('federates a subject token into a write token, caching and refreshing it', async () => {
		const provider = await authenticateGithubOidc(
			federatingClient(),
			'https://cache.example.workers.dev',
			{ environment: githubEnvironment }
		);

		const eager = await provider.get();
		const refreshed = await provider.refresh();
		const afterRefresh = await provider.get();

		expect({ eager, refreshed, afterRefresh }).toStrictEqual({
			eager: 'write-1',
			refreshed: 'write-2',
			afterRefresh: 'write-2'
		});
	});
});

describe('authenticateForPush', () => {
	it('federates via GitHub OIDC when --github-oidc is given', async () => {
		const provider = await authenticateForPush(federatingClient(), {
			githubOidc: true,
			audience: 'https://cache.example.workers.dev',
			environment: githubEnvironment
		});

		expect(await provider.get()).toBe('write-1');
	});

	testWithConfigHome(
		'otherwise uses the cached owner session, prompting a login when absent',
		async () => {
			const provider = await authenticateForPush(federatingClient(), {
				audience: 'https://cache.example.workers.dev'
			});

			const outcome = await provider.get().then(
				(token) => ({ token }),
				(error_: unknown) => {
					expect(error_).toBeInstanceOf(OwnerLoginRequiredError);

					if (!(error_ instanceof OwnerLoginRequiredError)) {
						return {};
					}

					return { error: { name: error_.name } };
				}
			);

			expect(outcome).toStrictEqual({
				error: { name: 'OwnerLoginRequiredError' }
			});
		}
	);
});

const farFuture = 4_000_000_000;
const past = 1_000_000_000;

function accessToken(name: string, expSeconds: number): string {
	return jwt({ iss: target, aud: target, exp: expSeconds, name });
}

function tokenResponse(name: string): ParsedTokenResponse {
	return {
		access_token: accessToken(name, farFuture),
		token_type: 'Bearer',
		expires_in: 600,
		refresh_token: `refresh-${name}`
	};
}

interface FakeSessionClient {
	readonly tokenRefresh: (refreshToken: string) => Promise<ParsedTokenResponse>;
	readonly tokenExchange: (
		subjectToken: string,
		subjectTokenType: string
	) => Promise<ParsedTokenResponse>;
}

interface FakeGrantChain {
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly writeGrant: (grant: CloudflareGrant) => Promise<void>;
	readonly refreshGrant: (
		previous: CloudflareGrant
	) => Promise<CloudflareGrant | undefined>;
	readonly now: () => number;
}

interface SessionHarness extends OwnerSessionDependencies {
	readonly client: FakeSessionClient;
	readonly grantChain: FakeGrantChain;
	readonly now: () => number;
}

// An in-memory session store plus a grant chain with no stored grant; tests
// override the pieces the scenario needs.
function sessionHarness(initial?: CachedSession): {
	readonly harness: SessionHarness;
	readonly clientCalls: () => readonly {
		readonly method: keyof FakeSessionClient;
	}[];
	readonly sessions: () => readonly CachedSession[];
} {
	const written: CachedSession[] = [];
	const clientCalls: { readonly method: keyof FakeSessionClient }[] = [];
	const stored: {
		session: CachedSession | undefined;
		grant: CloudflareGrant | undefined;
	} = { session: initial, grant: undefined };

	return {
		harness: {
			client: {
				tokenRefresh: () => {
					clientCalls.push({ method: 'tokenRefresh' });

					return Promise.reject(new OwnerLoginRequiredError());
				},
				tokenExchange: () => {
					clientCalls.push({ method: 'tokenExchange' });

					return Promise.reject(new OwnerLoginRequiredError());
				}
			},
			grantChain: {
				readGrant: () => Promise.resolve(stored.grant),
				writeGrant: () => Promise.resolve(),
				refreshGrant: () => Promise.resolve(stored.grant),
				now: () => past * 1000
			},
			readSession: () => Promise.resolve(stored.session),
			writeSession: (session) => {
				written.push(session);
				stored.session = session;

				return Promise.resolve();
			},
			now: () => past * 1000
		},
		clientCalls: () => clientCalls,
		sessions: () => written
	};
}

function cloudflareGrant(idToken: string): CloudflareGrant {
	return {
		accessToken: 'cf-access',
		refreshToken: 'cf-refresh',
		expiresAt: farFuture * 1000,
		subject: 'cf-user',
		idToken
	};
}

describe('cachedOwnerProvider', () => {
	it('returns a fresh cached access token without renewing', async () => {
		const fresh = accessToken('cached', farFuture);
		const { clientCalls, harness, sessions } = sessionHarness({
			accessToken: fresh
		});

		const provider = cachedOwnerProvider(target, harness);

		expect({
			clientCalls: clientCalls(),
			token: await provider.get(),
			sessions: sessions()
		}).toStrictEqual({
			clientCalls: [],
			token: fresh,
			sessions: []
		});
	});

	it('renews an expired access token by rotating the refresh token', async () => {
		const { harness, sessions } = sessionHarness({
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-stale'
		});
		const rotatedWith: string[] = [];
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenRefresh: (refreshToken) => {
					rotatedWith.push(refreshToken);

					return Promise.resolve(tokenResponse('rotated'));
				}
			}
		});

		const token = await provider.get();

		expect({ token, rotatedWith, sessions: sessions() }).toStrictEqual({
			token: accessToken('rotated', farFuture),
			rotatedWith: ['refresh-stale'],
			sessions: [
				{
					accessToken: accessToken('rotated', farFuture),
					refreshToken: 'refresh-rotated'
				}
			]
		});
	});

	it('falls back to the Cloudflare grant when the refresh token is refused', async () => {
		const idToken = jwt({ sub: 'cf-user', exp: farFuture });
		const { harness, sessions } = sessionHarness({
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-spent'
		});
		const exchangedWith: string[] = [];
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				tokenRefresh: () =>
					Promise.reject(
						new CupboardHttpError('POST', '/token', 400, 'invalid_grant')
					),
				tokenExchange: (subjectToken) => {
					exchangedWith.push(subjectToken);

					return Promise.resolve(tokenResponse('exchanged'));
				}
			},
			grantChain: {
				...harness.grantChain,
				readGrant: () => Promise.resolve(cloudflareGrant(idToken))
			}
		});

		const token = await provider.refresh();

		expect({ token, exchangedWith, sessions: sessions() }).toStrictEqual({
			token: accessToken('exchanged', farFuture),
			exchangedWith: [idToken],
			sessions: [
				{
					accessToken: accessToken('exchanged', farFuture),
					refreshToken: 'refresh-exchanged'
				}
			]
		});
	});

	it('prompts a login when no silent path can mint', async () => {
		const { clientCalls, harness, sessions } = sessionHarness();

		const provider = cachedOwnerProvider(target, harness);
		const outcome = await provider.get().then(
			(token) => ({ token }),
			(error_: unknown) => {
				expect(error_).toBeInstanceOf(OwnerLoginRequiredError);

				if (!(error_ instanceof OwnerLoginRequiredError)) {
					return {};
				}

				return {
					error: {
						name: error_.name
					}
				};
			}
		);

		expect({
			outcome,
			clientCalls: clientCalls(),
			sessions: sessions()
		}).toStrictEqual({
			outcome: {
				error: {
					name: OwnerLoginRequiredError.name
				}
			},
			clientCalls: [],
			sessions: []
		});
	});

	it('prompts a login when the exchange refuses the id_token', async () => {
		const { harness } = sessionHarness();
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenExchange: () =>
					Promise.reject(
						new CupboardHttpError('POST', '/token', 400, 'invalid_grant')
					)
			},
			grantChain: {
				...harness.grantChain,
				readGrant: () =>
					Promise.resolve(cloudflareGrant(jwt({ exp: farFuture })))
			}
		});

		const outcome = await provider.refresh().then(
			(token) => ({ token }),
			(error_: unknown) => {
				expect(error_).toBeInstanceOf(OwnerLoginRequiredError);

				if (!(error_ instanceof OwnerLoginRequiredError)) {
					return {};
				}

				return { error: { name: error_.name } };
			}
		);

		expect(outcome).toStrictEqual({
			error: { name: 'OwnerLoginRequiredError' }
		});
	});

	it('propagates a server failure rather than prompting a login', async () => {
		const failure = new CupboardHttpError('POST', '/token', 503, 'down');
		const { harness } = sessionHarness({
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-1'
		});
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenRefresh: () => Promise.reject(failure)
			}
		});
		const error = await provider.get().catch((error_: unknown) => error_);

		expect(error).toBeInstanceOf(CupboardHttpError);

		if (!(error instanceof CupboardHttpError)) {
			return;
		}

		expect({
			name: error.name,
			method: error.method,
			path: error.path,
			status: error.status
		}).toStrictEqual({
			name: 'CupboardHttpError',
			method: 'POST',
			path: '/token',
			status: 503
		});
	});

	testWithConfigHome('reads the session the login command cached', async () => {
		const token = accessToken('login', farFuture);
		await writeCachedSession(
			{ accessToken: token, refreshToken: 'refresh-login' },
			target
		);
		const provider = cachedOwnerProvider(target, {
			now: () => past * 1000
		});

		expect(await provider.get()).toBe(token);
	});
});
