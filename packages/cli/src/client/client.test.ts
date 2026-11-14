import { createServer as createHttpServer } from 'node:http';
import {
	createServer as createNetServer,
	type Server as NetServer,
	type Socket
} from 'node:net';

import {
	cacheNameSchema,
	type CacheScope,
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import type { SignupResponse } from '@cupboard/protocol/signup';
import {
	cacheRemovedVerdictCapability,
	commitAcceptCapabilitiesHeader,
	commitAuthenticationExpiredCloseCode,
	commitAuthenticationExpiredCloseReason,
	commitBatchCapability,
	commitCreditCapability,
	type CommitSessionFrame,
	publicationCapability,
	publicationRefusalReasonsCapability,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import { ProbeTimeoutError } from '@cupboard/shared/timeout';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../../../tests/support/manual-clock.ts';
import { abortReason } from '../abort.ts';
import { canonicalTarget } from '../auth/bound-sign-in.ts';
import {
	CupboardHttpError,
	InvalidCacheNameError,
	MalformedResponseError,
	QuotaExceededError,
	ResponseSchemaMismatchError,
	SessionRenewalExpiredError,
	SessionRenewalUnconfirmedError,
	UnreachableHostError
} from '../errors.ts';
import { RedirectingOrigin } from '../redirecting-origin.test-support.ts';

import { cacheNameFor, CupboardClient, type TokenProvider } from './client.ts';
import {
	FakeCommitSocket,
	FakeUpgradeFailure
} from './commit-socket.test-support.ts';
import { manualRefreshTiming } from './refresh-retry.test-support.ts';
import { type RefreshWindow } from './refresh-retry.ts';

// The window of a refresh token that no earlier attempt has sent.
const firstAttempt: RefreshWindow = {
	kind: 'new',
	onNotProcessed: () => Promise.resolve()
};

// A new window that counts the calls of its `onNotProcessed`.
function observedWindow(): {
	readonly window: RefreshWindow;
	readonly forgotten: () => number;
} {
	let forgotten = 0;

	return {
		window: {
			kind: 'new',
			onNotProcessed: () => {
				forgotten += 1;

				return Promise.resolve();
			}
		},
		forgotten: () => forgotten
	};
}

const publishedPublicKey =
	'cupboard-1:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

interface CapturedRequest {
	readonly url: string;
	readonly method: string | undefined;
	readonly authorization: string | undefined;
	readonly contentType: string | undefined;
	readonly body: unknown;
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

function capturingClient(
	response: unknown,
	cache: CacheScope
): {
	readonly client: CupboardClient;
	readonly captured: () => CapturedRequest | undefined;
} {
	let captured: CapturedRequest | undefined;

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		(input, init) => {
			const headers = new Headers(init?.headers);
			captured = {
				url: requestUrl(input),
				method: init?.method,
				authorization: headers.get('authorization') ?? undefined,
				contentType: headers.get('content-type') ?? undefined,
				body: init?.body
			};

			return Promise.resolve(Response.json(response));
		},
		cache,
		undefined,
		undefined,
		undefined,
		manualRefreshTiming(new ManualClock())
	);

	return { client, captured: () => captured };
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

function expectCupboardHttpError(
	error: unknown
): asserts error is CupboardHttpError {
	expect(error).toBeInstanceOf(CupboardHttpError);
}

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('CupboardClient.tokenExchange', () => {
	it('posts a urlencoded token-exchange request and returns the parsed token', async () => {
		const response: TokenResponse = {
			access_token: 'write-jwt',
			token_type: 'Bearer',
			expires_in: 900,
			issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
		};
		const { client, captured } = capturingClient(response, {
			kind: 'default'
		});

		const result = await client.tokenExchange(
			'subject.jwt',
			'urn:ietf:params:oauth:token-type:id_token'
		);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/token',
			method: 'POST',
			authorization: undefined,
			contentType: 'application/x-www-form-urlencoded',
			body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&subject_token=subject.jwt&subject_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token'
		});
	});

	it('sends the binding seed and targets of a bound ID token', async () => {
		const { client, captured } = capturingClient(
			{
				access_token: 'admin-jwt',
				token_type: 'Bearer',
				expires_in: 600
			},
			{ kind: 'default' }
		);

		await client.tokenExchange(
			'subject.jwt',
			'urn:ietf:params:oauth:token-type:id_token',
			undefined,
			{
				seed: 'seed-1',
				targets: [canonicalTarget(new URL('https://cupboard.test/t/acme'))]
			}
		);

		const form = new URLSearchParams(String(captured()?.body));

		expect(Object.fromEntries(form)).toStrictEqual({
			grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
			subject_token: 'subject.jwt',
			subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
			cupboard_binding_seed: 'seed-1',
			cupboard_binding_targets: '["https://cupboard.test/t/acme"]'
		});
	});

	it('posts a urlencoded refresh and returns the rotated session tokens', async () => {
		const response: TokenResponse = {
			access_token: 'admin-jwt-2',
			token_type: 'Bearer',
			expires_in: 600,
			refresh_token: 'refresh-2'
		};
		const { client, captured } = capturingClient(response, {
			kind: 'default'
		});

		const result = await client.tokenRefresh('refresh-1', firstAttempt);

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/token',
			method: 'POST',
			authorization: undefined,
			contentType: 'application/x-www-form-urlencoded',
			body: 'grant_type=refresh_token&refresh_token=refresh-1'
		});
	});

	it('passes a configured abort signal to the token exchange request', async () => {
		const controller = new AbortController();
		let signal: AbortSignal | null | undefined;
		const response: TokenResponse = {
			access_token: 'write-jwt',
			token_type: 'Bearer',
			expires_in: 900,
			issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
		};
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(_input, init) => {
				signal = init?.signal;

				return Promise.resolve(Response.json(response));
			},
			{ kind: 'default' },
			controller.signal
		);

		await client.tokenExchange(
			'subject.jwt',
			'urn:ietf:params:oauth:token-type:id_token'
		);

		expect(signal).toBe(controller.signal);
	});
});

const tokenResponse: TokenResponse = {
	access_token: 'write-jwt',
	token_type: 'Bearer',
	expires_in: 900,
	issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
};

function scriptedClient(attempts: (() => Response | Promise<Response>)[]): {
	readonly client: CupboardClient;
	readonly attempted: () => number;
} {
	let attempted = 0;

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		() => {
			const next = attempts[attempted];
			attempted += 1;

			if (next === undefined) {
				throw new Error('fetch script exhausted');
			}

			return Promise.resolve(next());
		},
		{ kind: 'default' },
		undefined,
		undefined,
		() => 0,
		manualRefreshTiming(new ManualClock())
	);

	return { client, attempted: () => attempted };
}

const exchange = (client: CupboardClient) =>
	client.tokenExchange(
		'subject.jwt',
		'urn:ietf:params:oauth:token-type:id_token'
	);

const boundExchange = (client: CupboardClient) =>
	client.tokenExchange(
		'subject.jwt',
		'urn:ietf:params:oauth:token-type:id_token',
		undefined,
		{
			seed: 'seed-1',
			targets: [canonicalTarget(new URL('https://cupboard.test'))]
		}
	);

type Outcome =
	| { readonly kind: 'resolved'; readonly value: unknown }
	| { readonly kind: 'rejected'; readonly error: unknown };

async function outcomeOf(run: () => Promise<unknown>): Promise<Outcome> {
	try {
		return { kind: 'resolved', value: await run() };
	} catch (error) {
		return { kind: 'rejected', error };
	}
}

function summarised(outcome: Outcome) {
	if (outcome.kind === 'resolved') {
		return outcome;
	}

	return {
		kind: outcome.kind,
		name: outcome.error instanceof Error ? outcome.error.constructor.name : '',
		status:
			outcome.error instanceof CupboardHttpError
				? outcome.error.status
				: undefined
	};
}

const readAccessResponse = {
	...tokenResponse,
	authorization_details: [],
	read_resources: [
		{
			type: 'cupboard_cache',
			cache: { kind: 'default' },
			mode: 'content',
			state: { kind: 'existing', access: 'private', priority: 40 }
		}
	]
};

// Each request shape, with whether the client repeats it after a transient
// failure.
const requestShapes = [
	{
		label: 'an exchange',
		request: exchange,
		response: tokenResponse,
		isRetried: true
	},
	{
		label: 'an exchange with authorization details',
		request: (client: CupboardClient) =>
			client.tokenExchange(
				'subject.jwt',
				'urn:ietf:params:oauth:token-type:id_token',
				[{ type: 'cupboard_wildcard' }]
			),
		response: tokenResponse,
		isRetried: true
	},
	{
		label: 'an attenuation',
		request: (client: CupboardClient) =>
			client.tokenExchangeAttenuate('issued.jwt', [
				{ type: 'cupboard_wildcard' }
			]),
		response: tokenResponse,
		isRetried: true
	},
	{
		label: 'a read access request',
		request: (client: CupboardClient) =>
			client.acquireReadAccess('subject.jwt', [
				{
					type: 'cupboard_cache',
					cache: { kind: 'default' },
					mode: 'content'
				}
			]),
		response: readAccessResponse,
		isRetried: true
	},
	{
		label: 'a bound exchange',
		request: boundExchange,
		response: tokenResponse,
		isRetried: false
	},
	{
		label: 'a refresh',
		request: (client: CupboardClient) =>
			client.tokenRefresh('refresh-1', firstAttempt),
		response: tokenResponse,
		isRetried: true
	}
];

describe('CupboardClient token replay', () => {
	it.each(
		requestShapes.map((shape) => ({
			...shape,
			attempts: shape.isRetried ? 2 : 1
		}))
	)(
		'makes $attempts attempts after a network fault on $label',
		async ({ request, response, attempts }) => {
			const { client, attempted } = scriptedClient([
				() =>
					Promise.reject(
						new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })
					),
				() => Response.json(response)
			]);

			const outcome = await outcomeOf(() => request(client));

			expect({
				attempts: attempted(),
				outcome: summarised(outcome)
			}).toStrictEqual({
				attempts,
				outcome:
					attempts === 2
						? { kind: 'resolved', value: response }
						: {
								kind: 'rejected',
								name: 'UnreachableHostError',
								status: undefined
							}
			});
		}
	);

	it.each(
		requestShapes.flatMap((shape) =>
			[
				StatusCodes.BAD_GATEWAY,
				StatusCodes.SERVICE_UNAVAILABLE,
				StatusCodes.GATEWAY_TIMEOUT,
				StatusCodes.TOO_MANY_REQUESTS
			].map((status) => ({
				...shape,
				status,
				attempts:
					shape.isRetried && status !== StatusCodes.TOO_MANY_REQUESTS ? 2 : 1
			}))
		)
	)(
		'makes $attempts attempts after a $status on $label',
		async ({ request, response, status, attempts }) => {
			const { client, attempted } = scriptedClient([
				() =>
					new Response('', {
						status,
						headers:
							status === StatusCodes.TOO_MANY_REQUESTS
								? { 'retry-after': '60' }
								: {}
					}),
				() => Response.json(response)
			]);

			const outcome = await outcomeOf(() => request(client));

			expect({
				attempts: attempted(),
				outcome: summarised(outcome)
			}).toStrictEqual({
				attempts,
				outcome:
					attempts === 2
						? { kind: 'resolved', value: response }
						: { kind: 'rejected', name: 'CupboardHttpError', status }
			});
		}
	);

	it.each([
		{ label: 'a 500 invariant', status: StatusCodes.INTERNAL_SERVER_ERROR },
		{ label: 'a 507 over quota', status: StatusCodes.INSUFFICIENT_STORAGE }
	])('does not retry $label, surfacing it at once', async ({ status }) => {
		const { client, attempted } = scriptedClient([
			() => new Response('boom\n', { status, headers: { 'cf-ray': 'ray-1' } })
		]);

		const error = await rejectedBy(() => exchange(client));

		expectCupboardHttpError(error);
		expect({
			attempts: attempted(),
			method: error.method,
			path: error.path,
			status: error.status,
			ray: error.ray
		}).toStrictEqual({
			attempts: 1,
			method: 'POST',
			path: '/token',
			status,
			ray: 'ray-1'
		});
	});
});

interface RefreshAttempt {
	readonly startedAtMs: number;
	readonly body: unknown;
	readonly signal: AbortSignal | undefined;
}

type RefreshScript = (
	signal: AbortSignal | undefined
) => Response | Promise<Response>;

// A refresh client whose nth request plays the nth script. Its retry timing
// runs on `clock`, and it records each delay that it requests.
function refreshClient(
	clock: ManualClock,
	scripts: readonly RefreshScript[],
	signal?: AbortSignal
): {
	readonly client: CupboardClient;
	readonly attempts: RefreshAttempt[];
	readonly delays: number[];
} {
	const attempts: RefreshAttempt[] = [];
	const delays: number[] = [];
	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		async (_input, init) => {
			const script = scripts[attempts.length];
			const signal = init?.signal ?? undefined;
			attempts.push({ startedAtMs: clock.now(), body: init?.body, signal });

			if (script === undefined) {
				throw new Error('fetch script exhausted');
			}

			return script(signal);
		},
		{ kind: 'default' },
		signal,
		undefined,
		() => 0,
		manualRefreshTiming(clock, delays)
	);

	return { client, attempts, delays };
}

// Answers after `clock` reaches `delayMs` past the start of the attempt.
function answeredAfter(
	clock: ManualClock,
	delayMs: number,
	response: () => Response
): RefreshScript {
	return async (signal) => {
		await clock.wait(delayMs, signal ?? new AbortController().signal);

		return response();
	};
}

function statusResponse(status: number, retryAfter?: string): Response {
	return new Response('', {
		status,
		headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter }
	});
}

const badGateway: RefreshScript = () => statusResponse(StatusCodes.BAD_GATEWAY);

// The failure of a fetch that had no connection to send the request on.
function connectionRefusal(): TypeError {
	const refused = Object.assign(new Error('connect ECONNREFUSED'), {
		code: 'ECONNREFUSED',
		syscall: 'connect'
	});

	return new TypeError('fetch failed', { cause: refused });
}

const connectionRefused: RefreshScript = () =>
	Promise.reject(connectionRefusal());

const forbidden: RefreshScript = () => statusResponse(StatusCodes.FORBIDDEN);

// Settles only when the attempt's signal aborts, as fetch does for a
// connection that never answers.
function unanswered(signal: AbortSignal | undefined): Promise<Response> {
	return new Promise((_resolve, reject) => {
		signal?.addEventListener(
			'abort',
			() => {
				reject(abortReason(signal));
			},
			{ once: true }
		);
	});
}

function truncatedBody(): Response {
	const reset = Object.assign(new Error('read ECONNRESET'), {
		code: 'ECONNRESET'
	});

	return new Response(
		new ReadableStream({
			start(controller) {
				controller.error(new TypeError('terminated', { cause: reset }));
			}
		}),
		{ headers: { 'content-type': 'application/json' } }
	);
}

const refreshResponse: TokenResponse = {
	access_token: 'admin-jwt-2',
	token_type: 'Bearer',
	expires_in: 600,
	refresh_token: 'refresh-2'
};

const refreshForm = 'grant_type=refresh_token&refresh_token=refresh-1';

function expectUnconfirmed(
	error: unknown
): asserts error is SessionRenewalUnconfirmedError {
	expect(error).toBeInstanceOf(SessionRenewalUnconfirmedError);
}

function expectExpired(
	error: unknown
): asserts error is SessionRenewalExpiredError {
	expect(error).toBeInstanceOf(SessionRenewalExpiredError);
}

// The class and status of a failure, for a whole-object comparison.
function failureSummary(failure: unknown) {
	return {
		name: failure instanceof Error ? failure.constructor.name : undefined,
		status: failure instanceof CupboardHttpError ? failure.status : undefined
	};
}

describe('CupboardClient.tokenRefresh retries', () => {
	it('repeats the same refresh after its response body is cut off', async () => {
		const clock = new ManualClock();
		const { client, attempts, delays } = refreshClient(clock, [
			() => truncatedBody(),
			() => Response.json(refreshResponse)
		]);

		const result = await client.tokenRefresh('refresh-1', firstAttempt);

		expect({
			result,
			attempts: attempts.map(({ startedAtMs, body }) => ({
				startedAtMs,
				body
			})),
			delays
		}).toStrictEqual({
			result: refreshResponse,
			attempts: [
				{ startedAtMs: 0, body: refreshForm },
				{ startedAtMs: 0, body: refreshForm }
			],
			delays: [10_000, 10_000]
		});
	});

	it('abandons an unanswered attempt at its deadline and repeats it', async () => {
		const clock = new ManualClock();
		const { client, attempts, delays } = refreshClient(clock, [
			unanswered,
			() => Response.json(refreshResponse)
		]);

		const pending = client.tokenRefresh('refresh-1', firstAttempt);
		await clock.advanceThroughDelay(10_000);
		const result = await pending;

		expect({
			result,
			attempts: attempts.map(({ startedAtMs, body, signal }) => ({
				startedAtMs,
				body,
				aborted: signal?.aborted
			})),
			delays
		}).toStrictEqual({
			result: refreshResponse,
			attempts: [
				{ startedAtMs: 0, body: refreshForm, aborted: true },
				{ startedAtMs: 10_000, body: refreshForm, aborted: false }
			],
			delays: [10_000, 10_000]
		});
	});

	it('starts no attempt 30 seconds after the first one', async () => {
		const clock = new ManualClock();
		const { client, attempts, delays } = refreshClient(clock, [
			unanswered,
			unanswered,
			unanswered,
			() => Response.json(refreshResponse)
		]);

		const pending = rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);
		await clock.advanceThroughDelay(10_000);
		await clock.advanceThroughDelay(10_000);
		await clock.advanceThroughDelay(10_000);
		const error = await pending;

		expectExpired(error);
		expect({
			host: error.host,
			cause: failureSummary(error.cause),
			started: attempts.map(({ startedAtMs, signal }) => ({
				startedAtMs,
				aborted: signal?.aborted
			})),
			delays
		}).toStrictEqual({
			host: 'cupboard.test',
			cause: failureSummary(new ProbeTimeoutError('')),
			started: [
				{ startedAtMs: 0, aborted: true },
				{ startedAtMs: 10_000, aborted: true },
				{ startedAtMs: 20_000, aborted: true }
			],
			delays: [10_000, 10_000, 10_000]
		});
	});

	it('stops without waiting when a backoff would end after 30 seconds', async () => {
		const clock = new ManualClock();
		const { client, attempts, delays } = refreshClient(clock, [
			unanswered,
			unanswered,
			answeredAfter(clock, 6000, () =>
				statusResponse(StatusCodes.SERVICE_UNAVAILABLE, '5')
			),
			() => Response.json(refreshResponse)
		]);

		const pending = rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);
		await clock.advanceThroughDelay(10_000);
		await clock.advanceThroughDelay(10_000);
		await clock.advanceThroughDelay(6000);
		const error = await pending;

		expectUnconfirmed(error);
		expect({
			attempts: error.attempts,
			cause: failureSummary(error.cause),
			started: attempts.map(({ startedAtMs }) => startedAtMs),
			delays,
			nowMs: clock.now()
		}).toStrictEqual({
			attempts: 3,
			cause: {
				name: 'CupboardHttpError',
				status: StatusCodes.SERVICE_UNAVAILABLE
			},
			started: [0, 10_000, 20_000],
			delays: [10_000, 10_000, 10_000],
			nowMs: 26_000
		});
	});

	it('limits a later attempt with the same refresh token to the rest of its window', async () => {
		const clock = new ManualClock();
		const { client, attempts, delays } = refreshClient(clock, [
			() => Response.json(refreshResponse)
		]);

		const result = await client.tokenRefresh('refresh-1', {
			kind: 'continued',
			sinceFirstAttemptMs: 25_000
		});

		expect({ result, attempts: attempts.length, delays }).toStrictEqual({
			result: refreshResponse,
			attempts: 1,
			delays: [5000]
		});
	});

	it.each([
		{ label: 'its window has passed', sinceFirstAttemptMs: 30_000 },
		{ label: 'the clock is before its first attempt', sinceFirstAttemptMs: -1 }
	])(
		'does not send the refresh token when $label',
		async ({ sinceFirstAttemptMs }) => {
			const clock = new ManualClock();
			const { client, attempts } = refreshClient(clock, [
				() => Response.json(refreshResponse)
			]);

			const error = await rejectedBy(() =>
				client.tokenRefresh('refresh-1', {
					kind: 'continued',
					sinceFirstAttemptMs
				})
			);

			expectExpired(error);
			expect({
				host: error.host,
				cause: error.cause,
				attempts: attempts.length
			}).toStrictEqual({
				host: 'cupboard.test',
				cause: undefined,
				attempts: 0
			});
		}
	);

	it('reports an unconfirmed renewal when fast failures use up the attempts', async () => {
		const clock = new ManualClock();
		const { client, attempts } = refreshClient(
			clock,
			Array.from({ length: 5 }, () => badGateway)
		);

		const error = await rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);

		expectUnconfirmed(error);
		expect({
			host: error.host,
			attempts: error.attempts,
			cause: failureSummary(error.cause),
			sent: attempts.length
		}).toStrictEqual({
			host: 'cupboard.test',
			attempts: 5,
			cause: { name: 'CupboardHttpError', status: StatusCodes.BAD_GATEWAY },
			sent: 5
		});
	});

	it('reports an unconfirmed renewal for a 429 after an earlier attempt', async () => {
		const clock = new ManualClock();
		const { client, attempts } = refreshClient(clock, [
			() => statusResponse(StatusCodes.BAD_GATEWAY),
			() => statusResponse(StatusCodes.TOO_MANY_REQUESTS, '60'),
			() => Response.json(refreshResponse)
		]);

		const error = await rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);

		expectUnconfirmed(error);
		expect({
			attempts: error.attempts,
			cause: failureSummary(error.cause),
			sent: attempts.length
		}).toStrictEqual({
			attempts: 2,
			cause: {
				name: 'CupboardHttpError',
				status: StatusCodes.TOO_MANY_REQUESTS
			},
			sent: 2
		});
	});

	it.each([
		{
			label: 'a 403',
			response: () => statusResponse(StatusCodes.FORBIDDEN),
			cause: { name: 'CupboardHttpError', status: StatusCodes.FORBIDDEN }
		},
		{
			label: 'a 200 that is not a token response',
			response: () =>
				new Response('<html>sign in to the network</html>', {
					headers: { 'content-type': 'text/html' }
				}),
			cause: { name: 'MalformedResponseError', status: undefined }
		}
	])(
		'reports an unconfirmed renewal for $label after an earlier attempt',
		async ({ response, cause }) => {
			const clock = new ManualClock();
			const { client, attempts } = refreshClient(clock, [
				badGateway,
				response,
				() => Response.json(refreshResponse)
			]);

			const error = await rejectedBy(() =>
				client.tokenRefresh('refresh-1', firstAttempt)
			);

			expectUnconfirmed(error);
			expect({
				attempts: error.attempts,
				cause: failureSummary(error.cause),
				sent: attempts.length
			}).toStrictEqual({ attempts: 2, cause, sent: 2 });
		}
	);

	it('returns an invalid_grant refusal of a later attempt unchanged', async () => {
		const clock = new ManualClock();
		const { client, attempts } = refreshClient(clock, [
			badGateway,
			() =>
				Response.json(
					{ error: 'invalid_grant' },
					{ status: StatusCodes.BAD_REQUEST }
				),
			() => Response.json(refreshResponse)
		]);

		const error = await rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);

		expect({
			failure: failureSummary(error),
			sent: attempts.length
		}).toStrictEqual({
			failure: {
				name: 'CupboardHttpError',
				status: StatusCodes.BAD_REQUEST
			},
			sent: 2
		});
	});

	it.each([
		{
			label: 'a 400',
			response: () =>
				Response.json(
					{ error: 'invalid_grant' },
					{ status: StatusCodes.BAD_REQUEST }
				),
			status: StatusCodes.BAD_REQUEST
		},
		{
			label: 'a 429',
			response: () => statusResponse(StatusCodes.TOO_MANY_REQUESTS, '60'),
			status: StatusCodes.TOO_MANY_REQUESTS
		},
		{
			label: 'a 500',
			response: () => statusResponse(StatusCodes.INTERNAL_SERVER_ERROR),
			status: StatusCodes.INTERNAL_SERVER_ERROR
		}
	])(
		'returns $label to the first attempt at once',
		async ({ response, status }) => {
			const clock = new ManualClock();
			const { client, attempts } = refreshClient(clock, [
				response,
				() => Response.json(refreshResponse)
			]);

			const error = await rejectedBy(() =>
				client.tokenRefresh('refresh-1', firstAttempt)
			);

			expect({
				failure: failureSummary(error),
				sent: attempts.length
			}).toStrictEqual({
				failure: { name: 'CupboardHttpError', status },
				sent: 1
			});
		}
	);

	it('stops after a backoff that ends past the window while the machine sleeps', async () => {
		const clock = new ManualClock();
		const { client, attempts } = refreshClient(clock, [
			() => statusResponse(StatusCodes.SERVICE_UNAVAILABLE, '1'),
			() => Response.json(refreshResponse)
		]);

		const pending = rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);
		await clock.waitForDelay(1000);
		clock.advanceTo(40_000);
		const error = await pending;

		expectExpired(error);
		expect({
			cause: failureSummary(error.cause),
			sent: attempts.length
		}).toStrictEqual({
			cause: {
				name: 'CupboardHttpError',
				status: StatusCodes.SERVICE_UNAVAILABLE
			},
			sent: 1
		});
	});

	it('stops when it is aborted during an attempt', async () => {
		const clock = new ManualClock();
		const controller = new AbortController();
		const reason = new Error('stop renewing');
		const sent = Promise.withResolvers<undefined>();
		const { client, attempts } = refreshClient(
			clock,
			[
				(signal) => {
					sent.resolve(undefined);

					return unanswered(signal);
				},
				() => Response.json(refreshResponse)
			],
			controller.signal
		);

		const pending = rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);
		await sent.promise;
		controller.abort(reason);

		expect({ error: await pending, sent: attempts.length }).toStrictEqual({
			error: reason,
			sent: 1
		});
	});

	it('stops when it is aborted during a backoff', async () => {
		const clock = new ManualClock();
		const controller = new AbortController();
		const reason = new Error('stop renewing');
		const { client, attempts } = refreshClient(
			clock,
			[
				() => statusResponse(StatusCodes.SERVICE_UNAVAILABLE, '1'),
				() => Response.json(refreshResponse)
			],
			controller.signal
		);

		const pending = rejectedBy(() =>
			client.tokenRefresh('refresh-1', firstAttempt)
		);
		await clock.waitForDelay(1000);
		controller.abort(reason);

		expect({ error: await pending, sent: attempts.length }).toStrictEqual({
			error: reason,
			sent: 1
		});
	});
});

describe('CupboardClient.tokenRefresh window record', () => {
	const unconfirmed = {
		name: 'SessionRenewalUnconfirmedError',
		status: undefined
	};

	it.each([
		{
			label: 'is released when every attempt fails to connect',
			scripts: Array.from({ length: 5 }, () => connectionRefused),
			expected: {
				failure: { name: 'UnreachableHostError', status: undefined },
				forgotten: 1
			}
		},
		{
			label: 'is kept after a body cut off after the headers',
			scripts: [
				() => truncatedBody(),
				...Array.from({ length: 4 }, () => connectionRefused)
			],
			expected: { failure: unconfirmed, forgotten: 0 }
		},
		{
			label: 'is kept when a later attempt is refused after an unsent one',
			scripts: [connectionRefused, forbidden],
			expected: { failure: unconfirmed, forgotten: 0 }
		},
		{
			label: 'is kept when connection failures follow a processed attempt',
			scripts: [
				badGateway,
				...Array.from({ length: 4 }, () => connectionRefused)
			],
			expected: { failure: unconfirmed, forgotten: 0 }
		}
	])('$label', async ({ scripts, expected }) => {
		const { client } = refreshClient(new ManualClock(), scripts);
		const { window, forgotten } = observedWindow();

		const error = await rejectedBy(() =>
			client.tokenRefresh('refresh-1', window)
		);

		expect({
			failure: failureSummary(error),
			forgotten: forgotten()
		}).toStrictEqual(expected);
	});

	it('reports a rerun whose attempts all fail to connect as unconfirmed', async () => {
		const { client, attempts } = refreshClient(
			new ManualClock(),
			Array.from({ length: 5 }, () => connectionRefused)
		);

		const error = await rejectedBy(() =>
			client.tokenRefresh('refresh-1', {
				kind: 'continued',
				sinceFirstAttemptMs: 5000
			})
		);

		expect({
			failure: failureSummary(error),
			sent: attempts.length
		}).toStrictEqual({ failure: unconfirmed, sent: 5 });
	});

	it('is kept when it is aborted during an attempt that may have been sent', async () => {
		const controller = new AbortController();
		const reason = new Error('stop renewing');
		const sent = Promise.withResolvers<undefined>();
		const { client } = refreshClient(
			new ManualClock(),
			[
				(signal) => {
					sent.resolve(undefined);

					return unanswered(signal);
				}
			],
			controller.signal
		);
		const { window, forgotten } = observedWindow();

		const pending = rejectedBy(() => client.tokenRefresh('refresh-1', window));
		await sent.promise;
		controller.abort(reason);

		expect({ error: await pending, forgotten: forgotten() }).toStrictEqual({
			error: reason,
			forgotten: 0
		});
	});
});

// Counts events and lets a test wait until a given number has happened.
function eventCounter(): {
	readonly record: () => void;
	readonly reach: (count: number) => Promise<void>;
	readonly count: () => number;
} {
	let count = 0;
	let changed = Promise.withResolvers<undefined>();

	return {
		record: () => {
			count += 1;
			changed.resolve(undefined);
			changed = Promise.withResolvers<undefined>();
		},
		reach: async (target) => {
			while (count < target) {
				await changed.promise;
			}
		},
		count: () => count
	};
}

async function listenOnLoopback(server: NetServer): Promise<number> {
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});

	const address = server.address();

	if (typeof address !== 'object' || address === null) {
		throw new Error('the server has no port');
	}

	return address.port;
}

describe('CupboardClient.tokenRefresh over loopback connections', () => {
	it.each([
		{
			label: 'releases the record when no TLS handshake finishes',
			protocol: 'https',
			expected: { failure: 'ProbeTimeoutError', forgotten: 1 }
		},
		{
			label: 'keeps the record when the server received the requests',
			protocol: 'http',
			expected: { failure: 'SessionRenewalExpiredError', forgotten: 0 }
		}
	])('$label', async ({ protocol, expected }) => {
		const arrivals = eventCounter();
		const sockets = new Set<Socket>();
		const server =
			protocol === 'https'
				? createNetServer((socket) => {
						sockets.add(socket);
						arrivals.record();
					})
				: createHttpServer(() => {
						arrivals.record();
					});
		server.on('connection', (socket: Socket) => {
			sockets.add(socket);
		});
		const port = await listenOnLoopback(server);
		const clock = new ManualClock();
		const client = new CupboardClient(
			new URL(`${protocol}://127.0.0.1:${String(port)}`),
			fetch,
			{ kind: 'default' },
			undefined,
			undefined,
			() => 0,
			manualRefreshTiming(clock)
		);
		const { window, forgotten } = observedWindow();

		try {
			const pending = rejectedBy(() =>
				client.tokenRefresh('refresh-1', window)
			);

			for (const attempt of [1, 2, 3]) {
				await arrivals.reach(attempt);
				await clock.advanceThroughDelay(10_000);
			}

			const error = await pending;

			expect({
				failure: failureSummary(error).name,
				forgotten: forgotten(),
				arrivals: arrivals.count()
			}).toStrictEqual({ ...expected, arrivals: 3 });
		} finally {
			for (const socket of sockets) {
				socket.destroy();
			}

			await new Promise((resolve) => server.close(resolve));
		}
	});

	it('releases the record when every TLS handshake fails', async () => {
		const connections = eventCounter();
		// Answers the TLS ClientHello with bytes that are not TLS, so the client
		// fails the handshake.
		const server = createNetServer((socket) => {
			connections.record();
			socket.once('data', () => {
				socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
			});
		});
		const port = await listenOnLoopback(server);
		const client = new CupboardClient(
			new URL(`https://127.0.0.1:${String(port)}`),
			fetch,
			{ kind: 'default' },
			undefined,
			undefined,
			() => 0,
			manualRefreshTiming(new ManualClock())
		);
		const { window, forgotten } = observedWindow();

		try {
			const error = await rejectedBy(() =>
				client.tokenRefresh('refresh-1', window)
			);
			await connections.reach(5);

			expect({
				failure: failureSummary(error).name,
				forgotten: forgotten(),
				connections: connections.count()
			}).toStrictEqual({
				failure: 'UnreachableHostError',
				forgotten: 1,
				connections: 5
			});
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});

	it('releases the record when it is interrupted before the request is written', async () => {
		const connections = eventCounter();
		const sockets = new Set<Socket>();
		const server = createNetServer((socket) => {
			sockets.add(socket);
			connections.record();
		});
		const port = await listenOnLoopback(server);
		const controller = new AbortController();
		const reason = new Error('stop renewing');
		const client = new CupboardClient(
			new URL(`https://127.0.0.1:${String(port)}`),
			fetch,
			{ kind: 'default' },
			controller.signal,
			undefined,
			() => 0,
			manualRefreshTiming(new ManualClock())
		);
		const { window, forgotten } = observedWindow();

		try {
			const pending = rejectedBy(() =>
				client.tokenRefresh('refresh-1', window)
			);
			await connections.reach(1);
			controller.abort(reason);

			expect({ error: await pending, forgotten: forgotten() }).toStrictEqual({
				error: reason,
				forgotten: 1
			});
		} finally {
			for (const socket of sockets) {
				socket.destroy();
			}

			await new Promise((resolve) => server.close(resolve));
		}
	});
});

describe('CupboardClient.signup', () => {
	const response: SignupResponse = {
		access_token: 'admin-jwt',
		token_type: 'Bearer',
		expires_in: 600,
		refresh_token: 'refresh-1',
		issuer: oidcIssuerSchema.parse('https://dash.cloudflare.com'),
		subject: oidcSubjectSchema.parse('cf-user-1'),
		audience: oidcAudienceSchema.parse('cupboard-client'),
		claimed: true
	};

	it('posts a urlencoded claim and returns the principal and its session', async () => {
		const { client, captured } = capturingClient(response, {
			kind: 'default'
		});

		const result = await client.signup({ subject_token: 'subject.jwt' });

		expect(result).toStrictEqual(response);
		expect(captured()).toStrictEqual({
			url: 'https://cupboard.test/signup',
			method: 'POST',
			authorization: undefined,
			contentType: 'application/x-www-form-urlencoded',
			body: 'subject_token=subject.jwt'
		});
	});

	it('sends the claim secret when one is given', async () => {
		const { client, captured } = capturingClient(response, {
			kind: 'default'
		});

		await client.signup({
			subject_token: 'subject.jwt',
			claim_secret: 'secret-1'
		});

		expect(captured()?.body).toBe(
			'subject_token=subject.jwt&claim_secret=secret-1'
		);
	});

	it('sends the binding seed and targets of a bound ID token', async () => {
		const { client, captured } = capturingClient(response, {
			kind: 'default'
		});

		await client.signup(
			{ subject_token: 'subject.jwt', claim_secret: 'secret-1' },
			{
				seed: 'seed-1',
				targets: [
					canonicalTarget(new URL('https://cupboard.test')),
					canonicalTarget(new URL('https://cupboard.test/t/acme'))
				]
			}
		);

		const form = new URLSearchParams(String(captured()?.body));

		expect(Object.fromEntries(form)).toStrictEqual({
			subject_token: 'subject.jwt',
			claim_secret: 'secret-1',
			cupboard_binding_seed: 'seed-1',
			cupboard_binding_targets:
				'["https://cupboard.test","https://cupboard.test/t/acme"]'
		});
	});

	it('throws a CupboardHttpError when the gate declines the claim', async () => {
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			() =>
				Promise.resolve(
					new Response('claimed by another principal', { status: 409 })
				),
			{ kind: 'default' }
		);
		const error = await rejectedBy(() =>
			client.signup({ subject_token: 'subject.jwt' })
		);

		expectCupboardHttpError(error);
		expect({
			name: error.name,
			method: error.method,
			path: error.path,
			status: error.status
		}).toStrictEqual({
			name: 'CupboardHttpError',
			method: 'POST',
			path: '/signup',
			status: 409
		});
	});

	it('makes one attempt when the connection fails, because the claim retries it', async () => {
		let attempts = 0;
		const refused = Object.assign(new Error('connect ECONNREFUSED'), {
			code: 'ECONNREFUSED',
			syscall: 'connect'
		});
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			() => {
				attempts += 1;

				return Promise.reject(
					new TypeError('fetch failed', { cause: refused })
				);
			},
			{ kind: 'default' }
		);

		vi.useFakeTimers();
		try {
			const pending = rejectedBy(() =>
				client.signup({ subject_token: 'subject.jwt' })
			);
			await vi.advanceTimersByTimeAsync(60_000);
			const error = await pending;

			expect({
				unreachable: error instanceof UnreachableHostError,
				attempts
			}).toStrictEqual({ unreachable: true, attempts: 1 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects an oversized signup response before parsing it', async () => {
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			() =>
				Promise.resolve(
					Response.json(response, {
						headers: { 'content-length': String(16 * 1024 * 1024 + 1) }
					})
				),
			{ kind: 'default' }
		);

		await expect(
			client.signup({ subject_token: 'subject.jwt' })
		).rejects.toBeInstanceOf(RemoteBodyTooLargeError);
	});
});

describe('CupboardClient token endpoint redirects', () => {
	it.each([
		{
			name: 'a token exchange',
			path: '/token',
			request: (client: CupboardClient) => exchange(client)
		},
		{
			name: 'a refresh',
			path: '/token',
			request: (client: CupboardClient) =>
				client.tokenRefresh('refresh-1', firstAttempt)
		},
		{
			name: 'a read access request',
			path: '/token',
			request: (client: CupboardClient) =>
				client.acquireReadAccess('subject.jwt', [
					{
						type: 'cupboard_cache',
						cache: { kind: 'default' },
						mode: 'content'
					}
				])
		},
		{
			name: 'a signup',
			path: '/signup',
			request: (client: CupboardClient) =>
				client.signup({
					subject_token: 'subject.jwt',
					claim_secret: 'secret-1'
				})
		}
	])(
		'fails on a redirect from $name without following it',
		async ({ path, request }) => {
			const origin = await RedirectingOrigin.start([path]);

			try {
				const client = new CupboardClient(
					new URL(origin.origin),
					fetch,
					{ kind: 'default' },
					undefined,
					undefined,
					undefined,
					manualRefreshTiming(new ManualClock())
				);
				const error = await rejectedBy(() => request(client));

				expectCupboardHttpError(error);
				expect({
					method: error.method,
					path: error.path,
					status: error.status,
					requests: origin.requests
				}).toStrictEqual({
					method: 'POST',
					path,
					status: StatusCodes.TEMPORARY_REDIRECT,
					requests: [path]
				});
			} finally {
				await origin.close();
			}
		}
	);
});

interface CapturedConnection {
	readonly url: string;
	readonly authorization: string | undefined;
	readonly capabilities: string | undefined;
}

const acceptedCommitCapabilities = `${commitBatchCapability},${commitCreditCapability},${publicationCapability},${publicationRefusalReasonsCapability},${cacheRemovedVerdictCapability}`;

// A client whose commit sockets are scripted: the nth connection plays the nth
// script against its listeners once they are attached.
function commitClient(
	scripts: readonly ((socket: FakeCommitSocket) => void)[],
	cache: CacheScope
): {
	readonly client: CupboardClient;
	readonly connections: () => readonly CapturedConnection[];
} {
	const connections: CapturedConnection[] = [];

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		fetch,
		cache,
		undefined,
		(url, headers) => {
			const script = scripts[connections.length];
			connections.push({
				url: url.href,
				authorization: headers.authorization,
				capabilities: headers[commitAcceptCapabilitiesHeader]
			});

			const socket = new FakeCommitSocket();

			if (script !== undefined) {
				queueMicrotask(() => {
					script(socket);
				});
			}

			return socket;
		}
	);

	return { client, connections: () => connections };
}

function sendFrame(socket: FakeCommitSocket, frame: CommitSessionFrame): void {
	socket.emit('message', JSON.stringify(frame));
}

describe('CupboardClient.commit', () => {
	const response = {
		storePathHash: storePathHashSchema.parse(
			'0123456789abcdfghijklmnpqrsvwxyz'
		),
		narHash: nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`),
		status: 'committed'
	} as const;
	const target = (uploadId: string) => ({
		uploadId: uploadIdSchema.parse(uploadId),
		storePathHash: response.storePathHash,
		narHash: response.narHash
	});

	it('closes the one-shot session when the server rejects with an error frame', async () => {
		let socket: FakeCommitSocket | undefined;
		const { client } = commitClient(
			[
				(scripted) => {
					socket = scripted;
					sendFrame(scripted, {
						ev: 'error',
						uploadId: uploadIdSchema.parse('upload-app'),
						status: 507,
						message: 'over quota'
					});
				}
			],
			{ kind: 'default' }
		);

		await expect(
			client.commit('write-token', target('upload-app'))
		).rejects.toStrictEqual(new QuotaExceededError('over quota'));
		expect(socket?.closed).toBe(true);
	});

	it('sends the bearer token on the commit WebSocket upgrade', async () => {
		const { client, connections } = commitClient(
			[
				(socket) => {
					sendFrame(socket, {
						ev: 'settled',
						uploadId: uploadIdSchema.parse('upload-app'),
						response
					});
				}
			],
			{ kind: 'default' }
		);

		const { settled, verdictGrace, ...result } = await client.commit(
			'write-token',
			target('upload-app')
		);

		expect({
			result,
			verdictGraceKind: typeof verdictGrace,
			connections: connections()
		}).toStrictEqual({
			result: response,
			verdictGraceKind: 'function',
			connections: [
				{
					url: 'wss://cupboard.test/commit',
					authorization: 'Bearer write-token',
					capabilities: acceptedCommitCapabilities
				}
			]
		});
		await expect(settled).resolves.toBeUndefined();
	});

	it('scopes the commit socket through a named cache', async () => {
		const { client, connections } = commitClient(
			[
				(socket) => {
					sendFrame(socket, {
						ev: 'settled',
						uploadId: uploadIdSchema.parse('upload-build'),
						response
					});
				}
			],
			{ kind: 'named', name: cacheNameSchema.parse('builds') }
		);

		await client.commit('write-token', target('upload-build'));

		expect(connections()).toStrictEqual([
			{
				url: 'wss://cupboard.test/cache/builds/commit',
				authorization: 'Bearer write-token',
				capabilities: acceptedCommitCapabilities
			}
		]);
	});

	it('refreshes the token and retries once when the upgrade is refused with a 401', async () => {
		const { client, connections } = commitClient(
			[
				(socket) => {
					const refusal = new FakeUpgradeFailure(401);
					socket.emit('unexpected-response', {}, refusal);
					refusal.emit('end');
				},
				(socket) => {
					sendFrame(socket, {
						ev: 'settled',
						uploadId: uploadIdSchema.parse('upload-app'),
						response
					});
				}
			],
			{ kind: 'default' }
		);
		const provider: TokenProvider = {
			get: () => Promise.resolve('stale-token'),
			refresh: () => Promise.resolve('fresh-token')
		};

		const { settled, verdictGrace, ...result } = await client.commit(
			provider,
			target('upload-app')
		);

		expect({
			result,
			verdictGraceKind: typeof verdictGrace,
			connections: connections()
		}).toStrictEqual({
			result: response,
			verdictGraceKind: 'function',
			connections: [
				{
					url: 'wss://cupboard.test/commit',
					authorization: 'Bearer stale-token',
					capabilities: acceptedCommitCapabilities
				},
				{
					url: 'wss://cupboard.test/commit',
					authorization: 'Bearer fresh-token',
					capabilities: acceptedCommitCapabilities
				}
			]
		});
		await expect(settled).resolves.toBeUndefined();
	});

	it("uses the provider's current token after the server closes a commit socket whose token expired", async () => {
		const { client, connections } = commitClient(
			[
				(socket) => {
					socket.emit('open');
					socket.emit(
						'close',
						commitAuthenticationExpiredCloseCode,
						commitAuthenticationExpiredCloseReason
					);
				},
				(socket) => {
					sendFrame(socket, {
						ev: 'settled',
						uploadId: uploadIdSchema.parse('upload-app'),
						response
					});
				}
			],
			{ kind: 'default' }
		);
		const get = vi
			.fn<() => Promise<string>>()
			.mockResolvedValueOnce('initial-token')
			.mockResolvedValue('renewed-token');
		const refresh = vi.fn(() => Promise.resolve('forced-token'));
		const provider: TokenProvider = { get, refresh };

		const { settled, verdictGrace, ...result } = await client.commit(
			provider,
			target('upload-app')
		);

		expect({
			result,
			verdictGraceKind: typeof verdictGrace,
			connections: connections(),
			getCalls: get.mock.calls.length,
			refreshCalls: refresh.mock.calls.length
		}).toStrictEqual({
			result: response,
			verdictGraceKind: 'function',
			connections: [
				{
					url: 'wss://cupboard.test/commit',
					authorization: 'Bearer initial-token',
					capabilities: acceptedCommitCapabilities
				},
				{
					url: 'wss://cupboard.test/commit',
					authorization: 'Bearer renewed-token',
					capabilities: acceptedCommitCapabilities
				}
			],
			getCalls: 2,
			refreshCalls: 0
		});
		await expect(settled).resolves.toBeUndefined();
	});
});

describe('CupboardClient cache prefix', () => {
	it('removes every trailing slash before resolving a route', async () => {
		let requested: string | undefined;
		const client = new CupboardClient(
			new URL('https://cupboard.test/t/acme///'),
			(input) => {
				requested = requestUrl(input);

				return Promise.resolve(new Response(`${publishedPublicKey}\n`));
			},
			{ kind: 'default' }
		);

		await client.publicKey();

		expect(requested).toBe('https://cupboard.test/t/acme/pubkey');
	});

	it('does not prefix a deployment-wide route', async () => {
		let requested: string | undefined;
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			(input) => {
				requested = requestUrl(input);

				return Promise.resolve(new Response(`${publishedPublicKey}\n`));
			},
			{ kind: 'named', name: cacheNameSchema.parse('builds') }
		);

		await client.publicKey();

		expect(requested).toBe('https://cupboard.test/pubkey');
	});

	it('rejects an invalid cache name when building a scoped client', () => {
		const error = thrownBy(() => cacheNameFor('Bad!'));

		expect(error).toBeInstanceOf(InvalidCacheNameError);

		if (error instanceof InvalidCacheNameError) {
			expect({ name: error.name, cache: error.cache }).toStrictEqual({
				name: 'InvalidCacheNameError',
				cache: 'Bad!'
			});
		}
	});
});

describe('CupboardClient response validation', () => {
	it('rejects a token response missing a required field', async () => {
		const { client } = capturingClient(
			{ token_type: 'Bearer' },
			{ kind: 'default' }
		);

		const error = await rejectedBy(() =>
			client.tokenExchange(
				'subject.jwt',
				'urn:ietf:params:oauth:token-type:id_token'
			)
		);

		expect(error).toBeInstanceOf(ResponseSchemaMismatchError);

		if (error instanceof ResponseSchemaMismatchError) {
			expect(error.path).toBe('/token');
		}
	});

	it('rejects a 200 response whose body is not valid JSON', async () => {
		const client = new CupboardClient(
			new URL('https://cupboard.test'),
			() => Promise.resolve(new Response('{ not json', { status: 200 })),
			{ kind: 'default' }
		);

		const error = await rejectedBy(() =>
			client.tokenExchange(
				'subject.jwt',
				'urn:ietf:params:oauth:token-type:id_token'
			)
		);

		expect(error).toBeInstanceOf(MalformedResponseError);

		if (error instanceof MalformedResponseError) {
			expect({ path: error.path, cause: error.cause.name }).toStrictEqual({
				path: '/token',
				cause: 'SyntaxError'
			});
		}
	});
});
