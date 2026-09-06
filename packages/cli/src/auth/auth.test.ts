import { setTimeout as delay } from 'node:timers/promises';

import { canonicalHref } from '@cupboard/nix-store/url';
import type {
	TokenResponse,
	TokenResponseInput
} from '@cupboard/protocol/oidc';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { abortReason } from '../abort.ts';
import { audienceSchema } from '../audience.ts';
import { CupboardClient } from '../client/client.ts';
import type { CloudflareGrant } from '../deploy/cloudflare-oauth.ts';
import {
	readCachedGrant,
	withCachedGrantLock,
	writeCachedGrant
} from '../deploy/grant-store.ts';
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

function federatingClient(): CupboardClient {
	let issued = 0;

	return new CupboardClient(
		new URL('https://cupboard.test'),
		(input) => {
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
				} satisfies TokenResponseInput)
			);
		},
		{ kind: 'default' }
	);
}

function renewingClient(): {
	readonly client: CupboardClient;
	readonly exchanged: () => readonly string[];
} {
	let issued = 0;
	const subjects: string[] = [];

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		(input, init) => {
			const url = new URL(requestUrl(input));

			if (url.origin === 'https://actions.example.com') {
				issued += 1;

				return Promise.resolve(
					Response.json({ value: `subject-${String(issued)}` })
				);
			}

			const form = new URLSearchParams(
				typeof init?.body === 'string' ? init.body : ''
			);
			subjects.push(form.get('subject_token') ?? '');

			return Promise.resolve(
				Response.json({
					access_token: `write-${String(issued)}`,
					token_type: 'Bearer',
					expires_in: 900,
					issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
				} satisfies TokenResponseInput)
			);
		},
		{ kind: 'default' }
	);

	return { client, exchanged: () => subjects };
}

const target = new URL('https://cupboard.test');
const audience = audienceSchema.parse('https://cache.example.workers.dev');

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
			audience,
			{
				environment: githubEnvironment
			}
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

	// The exchanged token lives for 900s and the renewal margin is five
	// minutes, so it stays fresh until 600s have passed.
	it.each([
		{
			name: 'keeps serving a token comfortably clear of expiry',
			advanceMs: 599_000,
			expected: {
				token: 'write-1',
				subsequent: 'write-1',
				exchanged: ['subject-1']
			}
		},
		{
			name: 're-exchanges a token within the renewal margin before use',
			advanceMs: 601_000,
			expected: {
				token: 'write-2',
				subsequent: 'write-2',
				exchanged: ['subject-1', 'subject-2']
			}
		}
	])('$name', async ({ advanceMs, expected }) => {
		let clock = 0;
		const { client, exchanged } = renewingClient();
		const provider = await authenticateGithubOidc(client, audience, {
			environment: githubEnvironment,
			now: () => clock
		});

		clock = advanceMs;

		const token = await provider.get();
		const subsequent = await provider.get();

		expect({ token, subsequent, exchanged: exchanged() }).toStrictEqual(
			expected
		);
	});
});

describe('authenticateForPush', () => {
	it('federates via GitHub OIDC when --github-oidc is given', async () => {
		const provider = await authenticateForPush(federatingClient(), {
			githubOidc: true,
			audience,
			environment: githubEnvironment
		});

		expect(await provider.get()).toBe('write-1');
	});

	testWithConfigHome(
		'otherwise uses the cached owner session, prompting a login when absent',
		async () => {
			const provider = await authenticateForPush(federatingClient(), {
				audience
			});

			const outcome = await (async () => {
				try {
					const token = await provider.get();
					return { token };
				} catch (error_: unknown) {
					expect(error_).toBeInstanceOf(OwnerLoginRequiredError);

					if (!(error_ instanceof OwnerLoginRequiredError)) {
						return {};
					}

					return { error: { name: error_.name } };
				}
			})();

			expect(outcome).toStrictEqual({
				error: { name: 'OwnerLoginRequiredError' }
			});
		}
	);
});

const farFuture = 4_000_000_000;
const past = 1_000_000_000;

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

function heldResponseFetch(): {
	readonly fetcher: typeof fetch;
	readonly started: Promise<AbortSignal | undefined>;
	readonly resolve: (response: Response) => void;
} {
	const started = Promise.withResolvers<AbortSignal | undefined>();
	const response = Promise.withResolvers<Response>();
	const fetcher = (
		_input: string | URL | Request,
		init?: RequestInit
	): Promise<Response> => {
		const signal = init?.signal ?? undefined;
		started.resolve(signal);
		signal?.addEventListener(
			'abort',
			() => {
				response.reject(abortReason(signal));
			},
			{ once: true }
		);

		return response.promise;
	};

	return {
		fetcher,
		started: started.promise,
		resolve(value) {
			response.resolve(value);
		}
	};
}

function accessToken(name: string, expSeconds: number): string {
	const issuer = canonicalHref(target);

	return jwt({ iss: issuer, aud: issuer, exp: expSeconds, name });
}

function tokenResponse(name: string): TokenResponse {
	return {
		access_token: accessToken(name, farFuture),
		token_type: 'Bearer',
		expires_in: 600,
		refresh_token: `refresh-${name}`
	};
}

interface FakeSessionClient {
	readonly tokenRefresh: (refreshToken: string) => Promise<TokenResponse>;
	readonly tokenExchange: (
		subjectToken: string,
		subjectTokenType: string
	) => Promise<TokenResponse>;
}

interface FakeGrantChain {
	readonly readGrant: () => Promise<CloudflareGrant | undefined>;
	readonly writeGrant: (grant: CloudflareGrant) => Promise<void>;
	readonly withGrantLock: <T>(
		action: (signal?: AbortSignal) => Promise<T>,
		signal?: AbortSignal
	) => Promise<T>;
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
				withGrantLock: (action, signal) => action(signal),
				refreshGrant: () => Promise.resolve(stored.grant),
				now: () => past * 1000
			},
			readSession: () => Promise.resolve(stored.session),
			writeSession: (session) => {
				written.push(session);
				stored.session = session;

				return Promise.resolve();
			},
			withSessionLock: (_target, action) => action(),
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

	it('shares one refresh rotation between concurrent callers', async () => {
		const { promise, resolve } = Promise.withResolvers<TokenResponse>();
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

					return promise;
				}
			}
		});

		const first = provider.get();
		const second = provider.get();
		await Promise.resolve();
		resolve(tokenResponse('rotated'));

		expect({
			tokens: await Promise.all([first, second]),
			rotatedWith,
			sessions: sessions()
		}).toStrictEqual({
			tokens: [
				accessToken('rotated', farFuture),
				accessToken('rotated', farFuture)
			],
			rotatedWith: ['refresh-stale'],
			sessions: [
				{
					accessToken: accessToken('rotated', farFuture),
					refreshToken: 'refresh-rotated'
				}
			]
		});
	});

	it('serialises rotation between independent provider instances', async () => {
		const rotation = Promise.withResolvers<TokenResponse>();
		const bothEntered = Promise.withResolvers<undefined>();
		const { harness, sessions } = sessionHarness({
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-stale'
		});
		const rotatedWith: string[] = [];
		let entrants = 0;
		let tail: Promise<undefined> = Promise.resolve(undefined);
		const withSessionLock = async <T>(
			_unusedTarget: URL,
			action: () => Promise<T>
		): Promise<T> => {
			entrants += 1;

			if (entrants === 2) {
				bothEntered.resolve(undefined);
			}

			const preceding = tail;
			const next = Promise.withResolvers<undefined>();
			tail = next.promise;
			await preceding;

			try {
				return await action();
			} finally {
				next.resolve(undefined);
			}
		};
		const dependencies: OwnerSessionDependencies = {
			...harness,
			client: {
				...harness.client,
				tokenRefresh: (refreshToken) => {
					rotatedWith.push(refreshToken);

					return rotation.promise;
				}
			},
			withSessionLock
		};
		const firstProvider = cachedOwnerProvider(target, dependencies);
		const secondProvider = cachedOwnerProvider(target, dependencies);

		const first = firstProvider.get();
		const second = secondProvider.get();
		await bothEntered.promise;
		rotation.resolve(tokenResponse('rotated'));

		expect({
			tokens: await Promise.all([first, second]),
			entrants,
			rotatedWith,
			sessions: sessions()
		}).toStrictEqual({
			tokens: [
				accessToken('rotated', farFuture),
				accessToken('rotated', farFuture)
			],
			entrants: 2,
			rotatedWith: ['refresh-stale'],
			sessions: [
				{
					accessToken: accessToken('rotated', farFuture),
					refreshToken: 'refresh-rotated'
				}
			]
		});
	});

	testWithConfigHome(
		'serialises one Cloudflare grant refresh across different targets',
		async () => {
			const otherTarget = new URL('https://cupboard.test/t/other');
			const staleGrant = cloudflareGrant(
				jwt({ sub: 'cf-user', exp: past - 60 })
			);
			const renewedGrant = cloudflareGrant(
				jwt({ sub: 'cf-user', exp: farFuture })
			);
			const refresh = Promise.withResolvers<CloudflareGrant | undefined>();
			const refreshedWith: CloudflareGrant[] = [];
			const sessions = new Map<string, CachedSession>();
			const { harness } = sessionHarness();
			const grantChain = {
				readGrant: readCachedGrant,
				writeGrant: writeCachedGrant,
				withGrantLock: withCachedGrantLock,
				refreshGrant: (previous: CloudflareGrant) => {
					refreshedWith.push(previous);

					return refresh.promise;
				},
				now: harness.now
			};
			const dependencies: OwnerSessionDependencies = {
				client: {
					tokenRefresh: harness.client.tokenRefresh,
					tokenExchange: () => Promise.resolve(tokenResponse('exchanged'))
				},
				grantChain,
				readSession: (sessionTarget) =>
					Promise.resolve(sessions.get(canonicalHref(sessionTarget))),
				writeSession: (session, sessionTarget) => {
					sessions.set(canonicalHref(sessionTarget), session);

					return Promise.resolve();
				},
				now: harness.now
			};

			await writeCachedGrant(staleGrant);
			const first = cachedOwnerProvider(target, dependencies).get();
			const second = cachedOwnerProvider(otherTarget, dependencies).get();
			await vi.waitFor(() => {
				expect(refreshedWith).toStrictEqual([staleGrant]);
			});
			refresh.resolve(renewedGrant);

			expect({
				tokens: await Promise.all([first, second]),
				refreshedWith,
				grant: await readCachedGrant()
			}).toStrictEqual({
				tokens: [
					accessToken('exchanged', farFuture),
					accessToken('exchanged', farFuture)
				],
				refreshedWith: [staleGrant],
				grant: renewedGrant
			});
		}
	);

	it("does not return another process's session after the caller aborts", async () => {
		const enteredLock = Promise.withResolvers<undefined>();
		const releaseLock = Promise.withResolvers<undefined>();
		const stale = {
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-stale'
		};
		const winner = {
			accessToken: accessToken('winner', farFuture),
			refreshToken: 'refresh-winner'
		};
		const { harness } = sessionHarness(stale);
		const controller = new AbortController();
		const reason = new Error('stop renewing');
		let session = stale;
		let lockSignal: AbortSignal | undefined;
		const withSessionLock = async <T>(
			_unusedTarget: URL,
			action: () => Promise<T>,
			signal?: AbortSignal
		): Promise<T> => {
			lockSignal = signal;
			enteredLock.resolve(undefined);
			await releaseLock.promise;

			return action();
		};
		const provider = cachedOwnerProvider(target, {
			...harness,
			readSession: () => Promise.resolve(session),
			withSessionLock,
			signal: controller.signal
		});
		const renewing = provider.get();

		await enteredLock.promise;
		session = winner;
		controller.abort(reason);
		releaseLock.resolve(undefined);

		await expect(renewing).rejects.toBe(reason);
		expect(lockSignal).toBe(controller.signal);
	});

	it('cancels Cupboard session establishment when the lock is compromised', async () => {
		const exchange = heldResponseFetch();
		const compromise = new AbortController();
		const reason = new Error('session lock was compromised');
		const idToken = jwt({ sub: 'cf-user', exp: farFuture });
		const { harness } = sessionHarness();

		vi.stubGlobal('fetch', exchange.fetcher);

		const provider = cachedOwnerProvider(target, {
			grantChain: {
				...harness.grantChain,
				readGrant: () => Promise.resolve(cloudflareGrant(idToken))
			},
			readSession: harness.readSession,
			writeSession: harness.writeSession,
			withSessionLock: (_target, action) => action(compromise.signal),
			now: harness.now
		});
		const renewing = provider.get();

		try {
			const requestSignal = await exchange.started;
			compromise.abort(reason);

			const outcome = await Promise.race([
				outcomeOf(renewing),
				pendingAfter(50)
			]);

			expect(outcome).toStrictEqual({ kind: 'rejected', error: reason });
			expect(requestSignal).toMatchObject({ aborted: true });
		} finally {
			exchange.resolve(Response.json(tokenResponse('late')));
			await outcomeOf(renewing);
			vi.unstubAllGlobals();
		}
	});

	testWithConfigHome(
		'cancels Cloudflare grant refresh when the caller aborts',
		async () => {
			const refresh = heldResponseFetch();
			const controller = new AbortController();
			const reason = new Error('stop refreshing the Cloudflare grant');
			const { harness } = sessionHarness();

			await writeCachedGrant(
				cloudflareGrant(jwt({ sub: 'cf-user', exp: past - 60 }))
			);
			vi.stubGlobal('fetch', refresh.fetcher);

			const provider = cachedOwnerProvider(target, {
				client: harness.client,
				readSession: harness.readSession,
				writeSession: harness.writeSession,
				withSessionLock: harness.withSessionLock,
				now: harness.now,
				signal: controller.signal
			});
			const renewing = provider.get();

			try {
				const requestSignal = await refresh.started;
				controller.abort(reason);

				const outcome = await Promise.race([
					outcomeOf(renewing),
					pendingAfter(50)
				]);

				expect(outcome).toStrictEqual({ kind: 'rejected', error: reason });
				expect(requestSignal).toMatchObject({ aborted: true });
			} finally {
				refresh.resolve(
					Response.json({ access_token: 'late', expires_in: 3600 })
				);
				await outcomeOf(renewing);
				vi.unstubAllGlobals();
			}
		}
	);

	it('starts a new rotation after a shared renewal fails', async () => {
		const failed = Promise.withResolvers<TokenResponse>();
		const failure = new Error('refresh transport failed');
		const { harness, sessions } = sessionHarness({
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-stale'
		});
		let attempts = 0;
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenRefresh: () => {
					attempts += 1;

					return attempts === 1
						? failed.promise
						: Promise.resolve(tokenResponse('retried'));
				}
			}
		});

		const first = provider.get();
		const second = provider.get();
		await Promise.resolve();
		failed.reject(failure);
		const failedOutcomes = await Promise.allSettled([first, second]);
		const retried = await provider.get();

		expect({
			failed: failedOutcomes.map((outcome) => outcome.status),
			attempts,
			retried,
			sessions: sessions()
		}).toStrictEqual({
			failed: ['rejected', 'rejected'],
			attempts: 2,
			retried: accessToken('retried', farFuture),
			sessions: [
				{
					accessToken: accessToken('retried', farFuture),
					refreshToken: 'refresh-retried'
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
						new CupboardHttpError(
							'POST',
							'/token',
							400,
							JSON.stringify({ error: 'invalid_grant' })
						)
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

	it('surfaces an invalid refresh request instead of replacing the session', async () => {
		const failure = new CupboardHttpError(
			'POST',
			'/token',
			400,
			JSON.stringify({ error: 'invalid_request' })
		);
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

		await expect(provider.get()).rejects.toBe(failure);
	});

	it.each([
		{
			name: 'a non-400 invalid_grant response',
			failure: () =>
				new CupboardHttpError(
					'POST',
					'/token',
					503,
					JSON.stringify({ error: 'invalid_grant' })
				)
		},
		{
			name: 'an arbitrary OAuth-shaped object',
			failure: () =>
				Object.assign(new Error('arbitrary OAuth carrier'), {
					status: StatusCodes.BAD_REQUEST,
					oauthError: { error: 'invalid_grant' }
				})
		}
	])('surfaces $name during refresh rotation', async ({ failure }) => {
		const rejected = failure();
		const { harness } = sessionHarness({
			accessToken: accessToken('stale', past - 60),
			refreshToken: 'refresh-1'
		});
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenRefresh: () => Promise.reject(rejected)
			}
		});

		await expect(provider.get()).rejects.toBe(rejected);
	});

	it('prompts a login when no silent path can issue a token', async () => {
		const { clientCalls, harness, sessions } = sessionHarness();

		const provider = cachedOwnerProvider(target, harness);
		const outcome = await (async () => {
			try {
				const token = await provider.get();
				return { token };
			} catch (error_: unknown) {
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
		})();

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

	it.each([
		{
			name: 'a preceding server returns invalid_grant',
			body: { error: 'invalid_grant' }
		},
		{
			name: 'the subject token is invalid',
			body: {
				error: 'invalid_request',
				problem: 'subject-token-invalid'
			}
		},
		{
			name: 'the subject token is no longer trusted',
			body: {
				error: 'invalid_request',
				problem: 'subject-token-untrusted'
			}
		},
		{
			name: 'the subject token no longer matches its rule',
			body: {
				error: 'invalid_request',
				problem: 'subject-token-claim-mismatch'
			}
		}
	])('prompts a login when $name', async ({ body }) => {
		const { harness } = sessionHarness();
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenExchange: () =>
					Promise.reject(
						new CupboardHttpError('POST', '/token', 400, JSON.stringify(body))
					)
			},
			grantChain: {
				...harness.grantChain,
				readGrant: () =>
					Promise.resolve(cloudflareGrant(jwt({ exp: farFuture })))
			}
		});

		const outcome = await (async () => {
			try {
				const token = await provider.refresh();
				return { token };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(OwnerLoginRequiredError);

				if (!(error_ instanceof OwnerLoginRequiredError)) {
					return {};
				}

				return { error: { name: error_.name } };
			}
		})();

		expect(outcome).toStrictEqual({
			error: { name: 'OwnerLoginRequiredError' }
		});
	});

	it('surfaces an invalid exchange request instead of requesting a login', async () => {
		const failure = new CupboardHttpError(
			'POST',
			'/token',
			400,
			JSON.stringify({ error: 'invalid_request' })
		);
		const { harness } = sessionHarness();
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenExchange: () => Promise.reject(failure)
			},
			grantChain: {
				...harness.grantChain,
				readGrant: () =>
					Promise.resolve(cloudflareGrant(jwt({ exp: farFuture })))
			}
		});

		await expect(provider.refresh()).rejects.toBe(failure);
	});

	it.each([
		{
			name: 'a recognised problem with the wrong OAuth error',
			failure: () =>
				new CupboardHttpError(
					'POST',
					'/token',
					400,
					JSON.stringify({
						error: 'server_error',
						problem: 'subject-token-invalid'
					})
				)
		},
		{
			name: 'a recognised problem on a non-400 response',
			failure: () =>
				new CupboardHttpError(
					'POST',
					'/token',
					503,
					JSON.stringify({
						error: 'invalid_request',
						problem: 'subject-token-invalid'
					})
				)
		},
		{
			name: 'an unrecognised subject-token problem',
			failure: () =>
				new CupboardHttpError(
					'POST',
					'/token',
					400,
					JSON.stringify({
						error: 'invalid_request',
						problem: 'subject-token-new-problem'
					})
				)
		},
		{
			name: 'an arbitrary OAuth-shaped object',
			failure: () =>
				Object.assign(new Error('arbitrary OAuth carrier'), {
					status: StatusCodes.BAD_REQUEST,
					oauthError: {
						error: 'invalid_request',
						problem: 'subject-token-invalid'
					}
				})
		}
	])('surfaces $name during subject-token exchange', async ({ failure }) => {
		const rejected = failure();
		const { harness } = sessionHarness();
		const provider = cachedOwnerProvider(target, {
			...harness,
			client: {
				...harness.client,
				tokenExchange: () => Promise.reject(rejected)
			},
			grantChain: {
				...harness.grantChain,
				readGrant: () =>
					Promise.resolve(cloudflareGrant(jwt({ exp: farFuture })))
			}
		});

		await expect(provider.refresh()).rejects.toBe(rejected);
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
		const error = await (async () => {
			try {
				return await provider.get();
			} catch (error_: unknown) {
				return error_;
			}
		})();

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
