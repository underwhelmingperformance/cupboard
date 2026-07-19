import type { TokenResponse } from '@cupboard/protocol/oidc';
import type { SignupResponse } from '@cupboard/protocol/signup';
import type { CommitSessionFrame } from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it, vi } from 'vitest';

import {
	CliAbortError,
	CupboardHttpError,
	InvalidCacheNameError,
	MalformedResponseError,
	ResponseSchemaMismatchError
} from '../errors.ts';

import { CupboardClient, type TokenProvider } from './client.ts';
import {
	FakeCommitSocket,
	FakeUpgradeFailure
} from './commit-socket.test-support.ts';
import { resilientFetcher } from './transport.ts';

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
	cachePrefix = ''
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
		cachePrefix
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
		const { client, captured } = capturingClient(response);

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

	it('posts a urlencoded refresh and returns the rotated session tokens', async () => {
		const response: TokenResponse = {
			access_token: 'admin-jwt-2',
			token_type: 'Bearer',
			expires_in: 600,
			refresh_token: 'refresh-2'
		};
		const { client, captured } = capturingClient(response);

		const result = await client.tokenRefresh('refresh-1');

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
			'',
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

function scriptedClient(
	attempts: (() => Response | Promise<Response>)[],
	signal?: AbortSignal
): { readonly client: CupboardClient; readonly attempted: () => number } {
	let attempted = 0;

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		resilientFetcher(() => {
			const next = attempts[attempted];
			attempted += 1;

			if (next === undefined) {
				throw new Error('fetch script exhausted');
			}

			return Promise.resolve(next());
		}),
		'',
		signal
	);

	return { client, attempted: () => attempted };
}

const exchange = (client: CupboardClient) =>
	client.tokenExchange(
		'subject.jwt',
		'urn:ietf:params:oauth:token-type:id_token'
	);

const marked = (status: number) => () =>
	new Response('Temporarily unavailable\n', {
		status,
		headers: { 'retry-after': '5' }
	});
const bare = (status: number) => () => new Response('', { status });

describe('CupboardClient token retry', () => {
	it.each([
		{
			label: 'a 503 carrying Retry-After',
			failure: marked(StatusCodes.SERVICE_UNAVAILABLE)
		},
		{ label: 'a bare 503', failure: bare(StatusCodes.SERVICE_UNAVAILABLE) },
		{ label: 'a 502', failure: bare(StatusCodes.BAD_GATEWAY) },
		{ label: 'a 504', failure: bare(StatusCodes.GATEWAY_TIMEOUT) },
		{ label: 'a 429', failure: bare(StatusCodes.TOO_MANY_REQUESTS) }
	])('retries $label and returns the eventual token', async ({ failure }) => {
		vi.useFakeTimers();

		try {
			const { client, attempted } = scriptedClient([
				failure,
				failure,
				() => Response.json(tokenResponse)
			]);

			const pending = exchange(client);
			await vi.advanceTimersByTimeAsync(60_000);

			expect({ result: await pending, attempts: attempted() }).toStrictEqual({
				result: tokenResponse,
				attempts: 3
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('retries a network fault and returns the eventual token', async () => {
		vi.useFakeTimers();

		try {
			const { client, attempted } = scriptedClient([
				() => Promise.reject(new TypeError('fetch failed')),
				() => Response.json(tokenResponse)
			]);

			const pending = exchange(client);
			await vi.advanceTimersByTimeAsync(60_000);

			expect({ result: await pending, attempts: attempted() }).toStrictEqual({
				result: tokenResponse,
				attempts: 2
			});
		} finally {
			vi.useRealTimers();
		}
	});

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

	it('surfaces the failure once the retry budget is spent', async () => {
		vi.useFakeTimers();

		try {
			// One attempt plus the four retries, all refused.
			const { client, attempted } = scriptedClient(
				Array.from({ length: 5 }, () => marked(StatusCodes.SERVICE_UNAVAILABLE))
			);

			const pending = rejectedBy(() => exchange(client));
			await vi.advanceTimersByTimeAsync(60_000);
			const error = await pending;

			expectCupboardHttpError(error);
			expect({ attempts: attempted(), status: error.status }).toStrictEqual({
				attempts: 5,
				status: StatusCodes.SERVICE_UNAVAILABLE
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops retrying when the signal aborts during the wait', async () => {
		vi.useFakeTimers();

		try {
			const controller = new AbortController();
			const { client, attempted } = scriptedClient(
				[marked(StatusCodes.SERVICE_UNAVAILABLE)],
				controller.signal
			);

			const pending = rejectedBy(() => exchange(client));
			controller.abort(new CliAbortError());
			await vi.advanceTimersByTimeAsync(60_000);

			expect(await pending).toBeInstanceOf(CliAbortError);
			expect(attempted()).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('CupboardClient.signup', () => {
	const response: SignupResponse = {
		issuer: 'https://dash.cloudflare.com',
		subject: 'cf-user-1',
		claimed: true
	};

	it('posts a urlencoded claim and returns the established principal', async () => {
		const { client, captured } = capturingClient(response);

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
		const { client, captured } = capturingClient(response);

		await client.signup({
			subject_token: 'subject.jwt',
			claim_secret: 'secret-1'
		});

		expect(captured()?.body).toBe(
			'subject_token=subject.jwt&claim_secret=secret-1'
		);
	});

	it('throws a CupboardHttpError when the gate declines the claim', async () => {
		const client = new CupboardClient(new URL('https://cupboard.test'), () =>
			Promise.resolve(
				new Response('claimed by another principal', { status: 409 })
			)
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
});

interface CapturedConnection {
	readonly url: string;
	readonly authorization: string | undefined;
}

// A client whose commit sockets are scripted: the nth connection plays the nth
// script against its listeners once they are attached.
function commitClient(
	scripts: readonly ((socket: FakeCommitSocket) => void)[],
	cachePrefix = ''
): {
	readonly client: CupboardClient;
	readonly connections: () => readonly CapturedConnection[];
} {
	const connections: CapturedConnection[] = [];

	const client = new CupboardClient(
		new URL('https://cupboard.test'),
		fetch,
		cachePrefix,
		undefined,
		(url, headers) => {
			const script = scripts[connections.length];
			connections.push({
				url: url.href,
				authorization: headers.authorization
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
		storePathHash: '0123456789abcdfghijklmnpqrsvwxyz',
		narHash: `sha256:${'1'.repeat(52)}`,
		status: 'committed'
	} as const;
	const target = (uploadId: string) => ({
		uploadId,
		storePathHash: response.storePathHash,
		narHash: response.narHash
	});

	it('closes the one-shot session when the server rejects with an error frame', async () => {
		let socket: FakeCommitSocket | undefined;
		const { client } = commitClient([
			(scripted) => {
				socket = scripted;
				sendFrame(scripted, {
					ev: 'error',
					uploadId: 'upload-app',
					status: 507,
					message: 'over quota'
				});
			}
		]);

		await expect(
			client.commit('write-token', target('upload-app'))
		).rejects.toBeInstanceOf(CupboardHttpError);
		expect(socket?.closed).toBe(true);
	});

	it('commits over a wss socket carrying the bearer token on the upgrade', async () => {
		const { client, connections } = commitClient([
			(socket) => {
				sendFrame(socket, { ev: 'settled', uploadId: 'upload-app', response });
			}
		]);

		const { settled, settledGrace, ...result } = await client.commit(
			'write-token',
			target('upload-app')
		);

		expect({
			result,
			settledGraceKind: typeof settledGrace,
			connections: connections()
		}).toStrictEqual({
			result: response,
			settledGraceKind: 'function',
			connections: [
				{
					url: 'wss://cupboard.test/cache/_default/commit',
					authorization: 'Bearer write-token'
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
						uploadId: 'upload-build',
						response
					});
				}
			],
			'/cache/builds'
		);

		await client.commit('write-token', target('upload-build'));

		expect(connections()).toStrictEqual([
			{
				url: 'wss://cupboard.test/cache/builds/commit',
				authorization: 'Bearer write-token'
			}
		]);
	});

	it('refreshes the token and retries once when the upgrade is refused with a 401', async () => {
		const { client, connections } = commitClient([
			(socket) => {
				const refusal = new FakeUpgradeFailure(401);
				socket.emit('unexpected-response', {}, refusal);
				refusal.emit('end');
			},
			(socket) => {
				sendFrame(socket, { ev: 'settled', uploadId: 'upload-app', response });
			}
		]);
		const provider: TokenProvider = {
			get: () => Promise.resolve('stale-token'),
			refresh: () => Promise.resolve('fresh-token')
		};

		const { settled, settledGrace, ...result } = await client.commit(
			provider,
			target('upload-app')
		);

		expect({
			result,
			settledGraceKind: typeof settledGrace,
			connections: connections()
		}).toStrictEqual({
			result: response,
			settledGraceKind: 'function',
			connections: [
				{
					url: 'wss://cupboard.test/cache/_default/commit',
					authorization: 'Bearer stale-token'
				},
				{
					url: 'wss://cupboard.test/cache/_default/commit',
					authorization: 'Bearer fresh-token'
				}
			]
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

				return Promise.resolve(new Response('cupboard-1:key\n'));
			}
		);

		await client.publicKey();

		expect(requested).toBe('https://cupboard.test/t/acme/pubkey');
	});

	it('does not prefix a deployment-wide route', async () => {
		const { client, captured } = capturingClient(
			'cupboard-1:k\n',
			'/cache/builds'
		);

		await client.publicKey();

		expect(captured()?.url).toBe('https://cupboard.test/pubkey');
	});

	it('rejects an invalid cache name when building a scoped client', () => {
		const error = thrownBy(() =>
			CupboardClient.fromUrl('https://cupboard.test', 'Bad!')
		);

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
		const { client } = capturingClient({ token_type: 'Bearer' });

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
		const client = new CupboardClient(new URL('https://cupboard.test'), () =>
			Promise.resolve(new Response('{ not json', { status: 200 }))
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
