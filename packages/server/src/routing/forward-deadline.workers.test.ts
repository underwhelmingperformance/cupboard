import { startCapture } from '@cupboard/logger/testing';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { firstCacheGeneration } from '@cupboard/nix-store/scalars';
import {
	tenantContract,
	type WorkBound,
	workBoundOf
} from '@cupboard/protocol/contract';
import { traverseContractProcedures } from '@orpc/server';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { tenantMemberKey } from '../control/tenant-member-key.ts';
import { firstCacheReadRevision } from '../db/cache-generation.ts';
import { maxOutgoingConnections } from '../do/bulk.ts';
import {
	type DeadlineClock,
	SharedDeadline,
	type TenantWorkerRead,
	withinReadDeadline,
	withinTenantWorkerRead
} from '../do/deadline.ts';
import {
	boundedTenantObjects,
	boundedTenantService
} from '../do/forward-deadline.ts';
import { passThrough } from '../do/pass-through.ts';
import { r2GetBudgetMs } from '../do/r2-read.ts';
import { committedPath } from '../do/reuse-view-read.test-support.ts';
import { narCacheControl } from '../http/http.ts';
import { streamRecords } from '../http/stalled-body.test-support.ts';
import {
	readRequestBudgetMs,
	tenantNarReadBudgetMs,
	tenantOperationBudgetMs,
	tenantWorkerNarBudgetMs
} from '../policy/streaming.ts';
import {
	bootstrap,
	currentOrigin,
	defaultCache,
	fixtureReaderAuthorization,
	handlerFetch,
	initialiseViaWorker,
	narBytes,
	nixSha256Hash,
	provisionFixtureReader,
	provisionFixtureTenant,
	pushPath,
	readFetch,
	recordTransition,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { canonicalCacheRequest } from './cache-request.ts';
import { controlWorker } from './handler.ts';
import { cachedTenantReadFetch } from './tenant-read-handler.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

const unpublishedHash = '0'.repeat(32);

// The control Worker gives each request an ID, which differs on every request.
const variableFields = ['requestId'];

type TenantObjects = DurableObjectNamespace;

/**
A tenant object namespace whose stubs answer every `fetch` with `answer`.
RPC calls reach the real object.
*/
function tenantObjectsAnswering(
	answer: (request: Request) => Promise<Response>
): TenantObjects {
	return new Proxy(env.CUPBOARD_DO, {
		get(target, property) {
			if (property !== 'get') {
				return passThrough(target, property);
			}

			return (id: DurableObjectId) =>
				new Proxy(target.get(id), {
					get(stub, member) {
						if (member === 'fetch') {
							return (input: RequestInfo | URL, init?: RequestInit) =>
								answer(new Request(input, init));
						}

						const value: unknown = Reflect.get(stub, member, stub);

						return value;
					}
				});
		}
	});
}

const answered = { answered: true };

function answerAtOnce(): Promise<Response> {
	return Promise.resolve(Response.json(answered));
}

/**
A stalled object's answer, as the runtime delivers it: the fetch stays
pending until the Worker aborts its signal, and then it rejects with an
`AbortError`.
*/
function stalledUntilCancelled(request: Request): Promise<Response> {
	return new Promise((_resolve, reject) => {
		request.signal.addEventListener(
			'abort',
			() => {
				reject(new DOMException('The request was cancelled', 'AbortError'));
			},
			{ once: true }
		);
	});
}

function stalledTenantObjects(): TenantObjects {
	return tenantObjectsAnswering(stalledUntilCancelled);
}

interface TestClock {
	readonly clock: DeadlineClock;
	readonly requested: number[];
	readonly advance: (ms: number) => void;
}

/**
A clock that moves only when the test advances it. Its delay records each
wait that the Worker requests and passes when `passes` resolves.
*/
function manualClock(passes: Promise<unknown>): TestClock {
	let nowMs = 0;
	const requested: number[] = [];

	return {
		requested,
		advance: (ms) => {
			nowMs += ms;
		},
		clock: {
			now: () => nowMs,
			delay: async (ms) => {
				requested.push(ms);
				await passes;
			}
		}
	};
}

function passingClock(): TestClock {
	return manualClock(Promise.resolve());
}

function heldClock(): TestClock & { readonly pass: () => void } {
	const passed = Promise.withResolvers<undefined>();

	return {
		...manualClock(passed.promise),
		pass: () => {
			passed.resolve(undefined);
		}
	};
}

interface ForwardedRequest {
	readonly name: string;
	readonly path: string;
	readonly init: RequestInit;
}

const jsonPost = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		authorization: fixtureReaderAuthorization
	},
	body: JSON.stringify(body)
});

const authorisedGet: RequestInit = {
	headers: { authorization: fixtureReaderAuthorization }
};

const nixCacheInfo: ForwardedRequest = {
	name: 'nix-cache-info',
	path: '/nix-cache-info',
	init: authorisedGet
};

// Replay-safe reads whose capped worst case fits within the read budget. Each
// runs within what admission left of its budget.
const reads: readonly ForwardedRequest[] = [
	nixCacheInfo,
	{ name: 'the public key', path: '/pubkey', init: authorisedGet },
	{
		name: 'the JWKS document',
		path: '/.well-known/jwks.json',
		init: authorisedGet
	},
	{
		name: 'the tenant discovery document',
		path: '/.well-known/oauth-authorization-server',
		init: authorisedGet
	},
	{
		name: 'an attestation list',
		path: `/attestations/${unpublishedHash}`,
		init: authorisedGet
	},
	{
		name: 'an attestation bundle',
		path: `/attestation-bundles/${'0'.repeat(64)}`,
		init: authorisedGet
	}
];

// Replay-safe reads outside the contract whose work grows with the request,
// or whose capped worst case exceeds the read budget. The Worker merges the
// object's answers to the chunks of a `missing-paths` probe, so the object
// answers with an availability response.
const nothingMissing = { missingStorePathHashes: [] };

const readsWithoutDeadline: readonly (ForwardedRequest & {
	readonly answer: unknown;
})[] = [
	{
		name: 'the nix-cache-info of a reuse view',
		path: '/reuse/builds/nix-cache-info',
		init: authorisedGet,
		answer: answered
	},
	{
		name: 'a narinfo of a reuse view',
		path: `/reuse/builds/${unpublishedHash}.narinfo`,
		init: authorisedGet,
		answer: answered
	},
	{
		name: 'a NAR of a reuse view',
		path: `/reuse/builds/nar/${unpublishedHash}.nar.zst`,
		init: authorisedGet,
		answer: answered
	},
	{
		name: 'the missing-paths probe',
		path: '/api/v1/missing-paths',
		init: jsonPost({ storePathHashes: [unpublishedHash] }),
		answer: nothingMissing
	},
	{
		name: 'the missing-paths probe of a reuse view',
		path: '/reuse/builds/api/v1/missing-paths',
		init: jsonPost({ storePathHashes: [unpublishedHash] }),
		answer: nothingMissing
	},
	{
		name: 'the path-info probe of a reuse view',
		path: '/reuse/builds/api/v1/path-info',
		init: jsonPost({ storePaths: [`/nix/store/${unpublishedHash}-a`] }),
		answer: answered
	}
];

const commitUpgrade: ForwardedRequest = {
	name: 'the commit WebSocket upgrade',
	path: '/commit',
	init: { headers: { authorization: 'Bearer token', upgrade: 'websocket' } }
};

const tokenExchange: ForwardedRequest = {
	name: 'a token exchange',
	path: '/token',
	init: {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: 'grant_type=refresh_token&refresh_token=token'
	}
};

// Requests outside the contract whose work the object bounds in time. They
// have the operation budget.
const operations: readonly ForwardedRequest[] = [
	commitUpgrade,
	tokenExchange,
	{
		name: 'a token revocation',
		path: '/revoke',
		init: {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'token=token'
		}
	}
];

interface ProcedureRequest extends ForwardedRequest {
	readonly workBound: WorkBound | undefined;
}

/**
One request for each tenant procedure, at the procedure's own route.
*/
function procedureRequests(): readonly ProcedureRequest[] {
	const requests: ProcedureRequest[] = [];

	traverseContractProcedures(
		{ router: tenantContract, path: [] },
		({ contract: procedure, path }) => {
			const route = procedure['~orpc'].route;
			const method = route.method ?? 'POST';
			const headers = {
				'content-type': 'application/json',
				authorization: 'Bearer token'
			};

			requests.push({
				name: path.join('.'),
				path: (route.path ?? '').replaceAll(/\{(\w+)\}/gu, (_match, name) =>
					name === 'cacheName' ? 'builds' : 'app'
				),
				init:
					method === 'GET'
						? { headers }
						: { method, headers, body: JSON.stringify({ paths: [] }) },
				workBound: workBoundOf(procedure)
			});
		}
	);

	return requests;
}

const procedures = procedureRequests();

function deadlineRecord(
	kind: 'read' | 'operation',
	deadlineMs: number
): unknown {
	return {
		level: 'warning',
		category: ['cupboard', 'tenant-object'],
		message: 'tenant object response deadline passed',
		properties: { requestId: 'string', kind, deadlineMs }
	};
}

function upgradeResponse(webSocket: WebSocket): Response {
	return new Response(undefined, {
		status: StatusCodes.SWITCHING_PROTOCOLS,
		webSocket
	});
}

function refusalFacts(
	response: Response,
	logs: Parameters<typeof streamRecords>[0]
): Record<string, unknown> {
	return {
		status: response.status,
		retryAfter: response.headers.get('retry-after') ?? undefined,
		cacheControl: response.headers.get('cache-control') ?? undefined,
		records: streamRecords(logs, variableFields)
	};
}

const readRefusal = {
	status: StatusCodes.SERVICE_UNAVAILABLE,
	retryAfter: '5',
	cacheControl: 'no-store',
	records: [deadlineRecord('read', readRequestBudgetMs)],
	requested: [readRequestBudgetMs]
};

const operationTimeout = {
	status: StatusCodes.GATEWAY_TIMEOUT,
	retryAfter: undefined,
	cacheControl: undefined,
	records: [deadlineRecord('operation', tenantOperationBudgetMs)],
	requested: [tenantOperationBudgetMs]
};

/**
A KV namespace whose read of the tenant's membership marker runs `onRead`
first.
*/
function onMarkerRead(onRead: () => void): KVNamespace {
	const marker = tenantMemberKey(fixtureTenant);

	return new Proxy(env.TENANT_CACHE, {
		get(target, property) {
			const value = passThrough(target, property);

			if (property !== 'get' || typeof value !== 'function') {
				return value;
			}

			return (key: string, ...options: unknown[]): unknown => {
				if (key === marker) {
					onRead();
				}

				return Reflect.apply(value, undefined, [key, ...options]);
			};
		}
	});
}

async function stalledResponse(
	request: ForwardedRequest
): Promise<Record<string, unknown>> {
	const { clock, requested } = passingClock();
	const capture = startCapture();

	try {
		const response = await readFetch(
			request.path,
			request.init,
			{ CUPBOARD_DO: stalledTenantObjects() },
			controlWorker(clock)
		);

		return { ...refusalFacts(response, capture.logs), requested };
	} finally {
		capture.stop();
	}
}

async function unboundedResponse(
	request: ForwardedRequest,
	answer: unknown = answered
): Promise<Record<string, unknown>> {
	const { clock, requested } = passingClock();
	const response = await readFetch(
		request.path,
		request.init,
		{
			CUPBOARD_DO: tenantObjectsAnswering(() =>
				Promise.resolve(Response.json(answer))
			)
		},
		controlWorker(clock)
	);

	return { status: response.status, body: await response.json(), requested };
}

const answeredWithoutDeadline = {
	status: StatusCodes.OK,
	body: answered,
	requested: []
};

describe('a request that the control Worker forwards to the tenant object', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
		await initialiseViaWorker();
		await provisionFixtureTenant({ defaultCacheAccess: 'private' });
		await provisionFixtureReader();
	});

	it.each(reads)(
		'refuses $name retryably when the object returns no headers within the read budget',
		async (request) => {
			expect(await stalledResponse(request)).toStrictEqual(readRefusal);
		}
	);

	it('refuses the deployment discovery document of a tenant retryably when the object returns no headers within the read budget', async () => {
		const { clock, requested } = passingClock();
		const capture = startCapture();

		try {
			const response = await handlerFetch(
				`/.well-known/oauth-authorization-server/t/${fixtureTenant}`,
				{},
				{ CUPBOARD_DO: stalledTenantObjects() },
				controlWorker(clock)
			);

			expect({
				...refusalFacts(response, capture.logs),
				requested
			}).toStrictEqual(readRefusal);
		} finally {
			capture.stop();
		}
	});

	it('gives a read what remains of the admission budget', async () => {
		const { clock, requested, advance } = passingClock();
		const admissionMs = 7000;
		const capture = startCapture();

		try {
			const response = await readFetch(
				nixCacheInfo.path,
				nixCacheInfo.init,
				{
					CUPBOARD_DO: stalledTenantObjects(),
					TENANT_CACHE: onMarkerRead(() => {
						advance(admissionMs);
					})
				},
				controlWorker(clock)
			);

			expect({
				...refusalFacts(response, capture.logs),
				requested
			}).toStrictEqual({
				...readRefusal,
				records: [deadlineRecord('read', readRequestBudgetMs - admissionMs)],
				requested: [readRequestBudgetMs - admissionMs]
			});
		} finally {
			capture.stop();
		}
	});

	it('does not forward a read when admission used the whole budget', async () => {
		const { clock, requested, advance } = passingClock();
		const sent: string[] = [];
		const capture = startCapture();

		try {
			const response = await readFetch(
				'/pubkey',
				authorisedGet,
				{
					CUPBOARD_DO: tenantObjectsAnswering((request) => {
						sent.push(new URL(request.url).pathname);

						return answerAtOnce();
					}),
					TENANT_CACHE: onMarkerRead(() => {
						advance(readRequestBudgetMs);
					})
				},
				controlWorker(clock)
			);

			expect({
				...refusalFacts(response, capture.logs),
				requested,
				sent
			}).toStrictEqual({
				...readRefusal,
				records: [deadlineRecord('read', 0)],
				requested: [],
				sent: []
			});
		} finally {
			capture.stop();
		}
	});

	it.each(readsWithoutDeadline)(
		'forwards $name without a deadline',
		async ({ answer, ...request }) => {
			expect(await unboundedResponse(request, answer)).toStrictEqual({
				status: StatusCodes.OK,
				body: answer,
				requested: []
			});
		}
	);

	it.each(operations)(
		'answers $name with 504 when the object returns no headers within the operation budget',
		async (request) => {
			expect(await stalledResponse(request)).toStrictEqual(operationTimeout);
		}
	);

	it.each(procedures.filter(({ workBound }) => workBound === 'time'))(
		'answers the $name procedure with 504 when the object returns no headers within the operation budget',
		async (request) => {
			expect(await stalledResponse(request)).toStrictEqual(operationTimeout);
		}
	);

	it.each(procedures.filter(({ workBound }) => workBound === 'size'))(
		'forwards the $name procedure without a deadline',
		async (request) => {
			expect(await unboundedResponse(request)).toStrictEqual(
				answeredWithoutDeadline
			);
		}
	);

	it.each([
		{ kind: 'read', request: nixCacheInfo },
		{ kind: 'operation', request: tokenExchange }
	])(
		'streams the body of a $kind response after its deadline passes',
		async ({ request }) => {
			const { clock, requested, pass } = heldClock();
			const bytes = new TextEncoder().encode('body after the deadline\n');
			const answer = (): Promise<Response> =>
				Promise.resolve(
					new Response(
						new ReadableStream<Uint8Array>({
							async pull(controller) {
								pass();
								await Promise.resolve();
								controller.enqueue(bytes);
								controller.close();
							}
						})
					)
				);

			const response = await readFetch(
				request.path,
				request.init,
				{ CUPBOARD_DO: tenantObjectsAnswering(answer) },
				controlWorker(clock)
			);

			expect({
				status: response.status,
				body: await response.text(),
				requests: requested.length
			}).toStrictEqual({
				status: StatusCodes.OK,
				body: 'body after the deadline\n',
				requests: 1
			});
		}
	);

	it('keeps an upgraded commit WebSocket open after its deadline passes', async () => {
		const { clock, pass } = heldClock();
		const { 0: client, 1: server } = new WebSocketPair();
		const answer = (): Promise<Response> => {
			server.accept();

			return Promise.resolve(upgradeResponse(client));
		};

		const response = await readFetch(
			commitUpgrade.path,
			commitUpgrade.init,
			{ CUPBOARD_DO: tenantObjectsAnswering(answer) },
			controlWorker(clock)
		);
		pass();
		const received = Promise.withResolvers<unknown>();
		response.webSocket?.accept();
		response.webSocket?.addEventListener('message', (event) => {
			received.resolve(event.data);
		});
		server.send('frame');

		try {
			expect({
				status: response.status,
				message: await received.promise
			}).toStrictEqual({
				status: StatusCodes.SWITCHING_PROTOCOLS,
				message: 'frame'
			});
		} finally {
			response.webSocket?.close();
			server.close();
		}
	});

	it('cancels a forward at its deadline and ignores its rejection', async () => {
		const { clock } = passingClock();
		const signals: AbortSignal[] = [];

		const response = await readFetch(
			nixCacheInfo.path,
			nixCacheInfo.init,
			{
				CUPBOARD_DO: tenantObjectsAnswering((request) => {
					signals.push(request.signal);

					return stalledUntilCancelled(request);
				})
			},
			controlWorker(clock)
		);

		expect({
			status: response.status,
			cancelled: signals.map((signal) => signal.aborted)
		}).toStrictEqual({
			status: StatusCodes.SERVICE_UNAVAILABLE,
			cancelled: [true]
		});
	});
});

/**
The name of the error that `pending` rejects with, or `answered`.
*/
async function outcomeOf(pending: Promise<Response>): Promise<string> {
	try {
		await pending;

		return 'answered';
	} catch (error) {
		return error instanceof Error ? error.name : 'other';
	}
}

describe('a forward that has a deadline', () => {
	const url = 'https://tenant.test/nix-cache-info';

	it.each([
		{
			carrier: 'its init',
			send: (stub: Fetcher, signal: AbortSignal) => stub.fetch(url, { signal })
		},
		{
			carrier: 'its request',
			send: (stub: Fetcher, signal: AbortSignal) =>
				stub.fetch(new Request(url, { signal }))
		}
	])(
		'is cancelled when the caller aborts the signal of $carrier',
		async ({ send }) => {
			const { clock } = heldClock();
			const signals: AbortSignal[] = [];
			const objects = boundedTenantObjects(
				tenantObjectsAnswering((request) => {
					signals.push(request.signal);

					return stalledUntilCancelled(request);
				}),
				clock.delay
			);
			const caller = new AbortController();
			const pending = send(
				objects.get(objects.idFromName('caller')),
				caller.signal
			);
			caller.abort();

			expect({
				rejection: await outcomeOf(pending),
				cancelled: signals.map((signal) => signal.aborted)
			}).toStrictEqual({ rejection: 'AbortError', cancelled: [true] });
		}
	);
});

describe('a read that the tenant Worker forwards to the tenant object', () => {
	beforeEach(resetTestServer);

	it('is refused retryably when the object returns no headers within the read budget', async () => {
		const { clock, requested } = passingClock();
		const url = new URL(
			`/t/${fixtureTenant}/attestation-bundles/${'0'.repeat(64)}`,
			currentOrigin()
		);
		const request = canonicalCacheRequest(new Request(url), {
			generation: firstCacheGeneration,
			readRevision: firstCacheReadRevision
		});
		const ctx = createExecutionContext();
		const capture = startCapture();

		try {
			const response = await cachedTenantReadFetch(
				request,
				{ ...env, CUPBOARD_DO: stalledTenantObjects() },
				ctx,
				clock
			);
			await waitOnExecutionContext(ctx);

			expect({
				status: response.status,
				retryAfter: response.headers.get('retry-after'),
				cacheControl: response.headers.get('cache-control'),
				records: streamRecords(capture.logs),
				requested
			}).toStrictEqual({
				status: StatusCodes.SERVICE_UNAVAILABLE,
				retryAfter: '5',
				cacheControl: 'no-store',
				records: [
					{
						level: 'warning',
						category: ['cupboard', 'tenant-object'],
						message: 'tenant object response deadline passed',
						properties: { kind: 'read', deadlineMs: readRequestBudgetMs }
					}
				],
				requested: [readRequestBudgetMs]
			});
		} finally {
			capture.stop();
		}
	});
});

/**
A tenant Worker service binding that answers every `fetch` with `answer`.
*/
function tenantWorkerAnswering(
	answer: (request: Request) => Promise<Response>
): Env['CUPBOARD_TENANT'] {
	return {
		fetch: (input: RequestInfo | URL, init?: RequestInit) =>
			answer(new Request(input, init)),
		connect() {
			throw new Error('unexpected tenant connection');
		}
	};
}

const publicNarinfo: ForwardedRequest = {
	name: 'a narinfo',
	path: `/${unpublishedHash}.narinfo`,
	init: {}
};

const publicNar: ForwardedRequest = {
	name: 'a NAR',
	path: `/nar/${nixSha256Hash('0')}.nar.zst`,
	init: {}
};

function tenantWorkerDeadlineRecord(
	kind: TenantWorkerRead,
	deadlineMs: number
): unknown {
	return {
		level: 'warning',
		category: ['cupboard', 'tenant-worker'],
		message: 'tenant Worker response deadline passed',
		properties: { requestId: 'string', kind, deadlineMs }
	};
}

function tenantWorkerRefusal(
	kind: TenantWorkerRead,
	deadlineMs: number
): Record<string, unknown> {
	return {
		status: StatusCodes.SERVICE_UNAVAILABLE,
		retryAfter: '5',
		cacheControl: 'no-store',
		records: [tenantWorkerDeadlineRecord(kind, deadlineMs)],
		requested: [deadlineMs]
	};
}

describe('a public read that the control Worker sends to the tenant Worker', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
		await initialiseViaWorker();
		await provisionFixtureTenant({ defaultCacheAccess: 'public' });
	});

	it.each([
		{
			request: publicNarinfo,
			expected: tenantWorkerRefusal('narinfo', readRequestBudgetMs)
		},
		{
			request: publicNar,
			expected: tenantWorkerRefusal('nar', tenantNarReadBudgetMs)
		}
	])(
		'refuses $request.name retryably and cancels it when the tenant Worker returns no headers within its budget',
		async ({ request, expected }) => {
			const { clock, requested } = passingClock();
			const signals: AbortSignal[] = [];
			const capture = startCapture();

			try {
				const response = await readFetch(
					request.path,
					request.init,
					{
						CUPBOARD_TENANT: tenantWorkerAnswering((forwarded) => {
							signals.push(forwarded.signal);

							return stalledUntilCancelled(forwarded);
						})
					},
					controlWorker(clock)
				);

				expect({
					...refusalFacts(response, capture.logs),
					requested,
					cancelled: signals.map((signal) => signal.aborted)
				}).toStrictEqual({ ...expected, cancelled: [true] });
			} finally {
				capture.stop();
			}
		}
	);

	it('gives a narinfo read what remains of the admission budget', async () => {
		const { clock, requested, advance } = passingClock();
		const admissionMs = 7000;
		const capture = startCapture();

		try {
			const response = await readFetch(
				publicNarinfo.path,
				publicNarinfo.init,
				{
					CUPBOARD_TENANT: tenantWorkerAnswering(stalledUntilCancelled),
					TENANT_CACHE: onMarkerRead(() => {
						advance(admissionMs);
					})
				},
				controlWorker(clock)
			);

			expect({
				...refusalFacts(response, capture.logs),
				requested
			}).toStrictEqual(
				tenantWorkerRefusal('narinfo', readRequestBudgetMs - admissionMs)
			);
		} finally {
			capture.stop();
		}
	});

	it('streams a NAR body after the deadline passes', async () => {
		const { clock, requested, pass } = heldClock();
		const bytes = new TextEncoder().encode('NAR bytes after the deadline\n');
		const answer = (): Promise<Response> =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						async pull(controller) {
							pass();
							await Promise.resolve();
							controller.enqueue(bytes);
							controller.close();
						}
					})
				)
			);

		const response = await readFetch(
			publicNar.path,
			publicNar.init,
			{ CUPBOARD_TENANT: tenantWorkerAnswering(answer) },
			controlWorker(clock)
		);

		expect({
			status: response.status,
			body: await response.text(),
			requested
		}).toStrictEqual({
			status: StatusCodes.OK,
			body: 'NAR bytes after the deadline\n',
			requested: [tenantNarReadBudgetMs]
		});
	});
});

function pathInfoProbe(storePaths: readonly string[]): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ storePaths })
	};
}

describe('the path-info probe of a public cache', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it('refuses retryably when a narinfo read gets no headers from the tenant Worker within its budget', async () => {
		const path = await committedPath('path-info-deadline', defaultCache());
		const { clock, requested } = passingClock();
		const capture = startCapture();

		try {
			const response = await readFetch(
				'/api/v1/path-info',
				pathInfoProbe([path.storePath]),
				{ CUPBOARD_TENANT: tenantWorkerAnswering(stalledUntilCancelled) },
				controlWorker(clock)
			);

			expect({
				...refusalFacts(response, capture.logs),
				requested
			}).toStrictEqual({
				...tenantWorkerRefusal('path-info-narinfo', readRequestBudgetMs),
				records: [
					tenantWorkerDeadlineRecord('path-info-narinfo', readRequestBudgetMs),
					{
						level: 'warning',
						category: ['cupboard'],
						message: 'request refused: cache facts unavailable',
						properties: {
							requestId: 'string',
							method: 'POST',
							path: `/t/${fixtureTenant}/api/v1/path-info`,
							tenant: fixtureTenant,
							step: 'canonical-narinfo-read',
							error: 'ForwardedReadTimeoutError'
						}
					}
				]
			});
		} finally {
			capture.stop();
		}
	});

	it('gives the narinfo reads of every round what remains of the read budget', async () => {
		// Seven paths need two rounds of reads. The first read advances the
		// clock, so each later read, in either round, gets what remains of the
		// budget that admission started.
		const usedMs = 5000;
		const paths = await Array.fromAsync(
			Array.from(
				{ length: maxOutgoingConnections + 1 },
				(_value, index) => index
			),
			(index) =>
				committedPath(`path-info-round-${String(index)}`, defaultCache(), {
					storePathHash: `${'p'.repeat(31)}${String(index)}`
				})
		);
		const { clock, requested, advance } = heldClock();
		const sent: string[] = [];

		const response = await readFetch(
			'/api/v1/path-info',
			pathInfoProbe(paths.map((path) => path.storePath)),
			{
				CUPBOARD_TENANT: tenantWorkerAnswering((request) => {
					if (sent.length === 0) {
						advance(usedMs);
					}

					sent.push(new URL(request.url).pathname);

					return Promise.resolve(
						new Response(undefined, { status: StatusCodes.NOT_FOUND })
					);
				})
			},
			controlWorker(clock)
		);

		expect({
			status: response.status,
			sent: sent.length,
			requested
		}).toStrictEqual({
			status: StatusCodes.OK,
			sent: paths.length,
			requested: paths.map((_path, index) =>
				index === 0 ? readRequestBudgetMs : readRequestBudgetMs - usedMs
			)
		});
	});
});

/**
Publishes one NAR to the public default cache and returns a request for it
with `headers`, as the control Worker sends it to the tenant Worker on a
Workers Cache miss.
*/
async function publicNarRequest(
	headers: Record<string, string> = {}
): Promise<Request> {
	const { token } = await bootstrap();
	const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
	await pushPath(token, metadata);
	const narinfo = await readFetch(`/${metadata.storePathHash}.narinfo`);
	const url = new URL(
		`/t/${fixtureTenant}/${NarInfo.parse(await narinfo.text()).url}`,
		currentOrigin()
	);

	return canonicalCacheRequest(new Request(url, { headers }), {
		generation: firstCacheGeneration,
		readRevision: firstCacheReadRevision
	});
}

const narBudgetRecord = {
	level: 'warning',
	category: ['cupboard', 'tenant-worker'],
	message: 'tenant Worker NAR budget passed',
	properties: { budgetMs: tenantWorkerNarBudgetMs }
};

describe('a public NAR read in the tenant Worker', () => {
	beforeEach(async () => {
		await resetTestServer();
		await recordTransition('cache-identity', 'complete');
	});

	it.each([
		{
			// The ranged R2 get starts its own budget within the NAR budget, on the
			// same clock.
			name: 'answers within the NAR budget',
			passesAtHead: false,
			expected: {
				status: StatusCodes.PARTIAL_CONTENT,
				retryAfter: undefined,
				cacheControl: narCacheControl,
				records: [],
				requested: [tenantWorkerNarBudgetMs, r2GetBudgetMs]
			}
		},
		{
			name: 'refuses retryably when the NAR budget passes before its last storage call',
			passesAtHead: true,
			expected: {
				status: StatusCodes.SERVICE_UNAVAILABLE,
				retryAfter: '5',
				cacheControl: 'no-store',
				records: [narBudgetRecord],
				requested: [tenantWorkerNarBudgetMs]
			}
		}
	])('$name', async ({ passesAtHead, expected }) => {
		const request = await publicNarRequest({ range: 'bytes=0-0' });
		const { clock, requested, pass } = heldClock();
		const blobs = new Proxy(env.BLOBS, {
			get(target, property) {
				const value = passThrough(target, property);

				if (property !== 'head' || !passesAtHead) {
					return value;
				}

				return (...arguments_: Parameters<R2Bucket['head']>) => {
					pass();

					return target.head(...arguments_);
				};
			}
		});
		const ctx = createExecutionContext();
		const capture = startCapture();

		try {
			const response = await cachedTenantReadFetch(
				request,
				{ ...env, BLOBS: blobs },
				ctx,
				clock
			);
			await response.arrayBuffer();
			await waitOnExecutionContext(ctx);

			expect({
				status: response.status,
				retryAfter: response.headers.get('retry-after') ?? undefined,
				cacheControl: response.headers.get('cache-control') ?? undefined,
				records: streamRecords(capture.logs),
				requested
			}).toStrictEqual(expected);
		} finally {
			capture.stop();
		}
	});

	it('streams a NAR body after the NAR budget passes', async () => {
		const request = await publicNarRequest();
		const { clock, requested, pass } = heldClock();
		const ctx = createExecutionContext();

		const response = await cachedTenantReadFetch(request, env, ctx, clock);
		pass();
		const body = new Uint8Array(await response.arrayBuffer());
		await waitOnExecutionContext(ctx);

		expect({ status: response.status, body, requested }).toStrictEqual({
			status: StatusCodes.OK,
			body: narBytes,
			requested: [tenantWorkerNarBudgetMs, r2GetBudgetMs]
		});
	});
});

describe('the tenant Worker binding that the control Worker uses', () => {
	it('calls `connect` with the binding as its receiver', () => {
		const receivers: unknown[] = [];
		const binding: Env['CUPBOARD_TENANT'] = {
			fetch: () => Promise.reject(new Error('unexpected tenant fetch')),
			connect(this: unknown) {
				receivers.push(this);
				throw new Error('unexpected tenant connection');
			}
		};
		const bounded = boundedTenantService(binding, passingClock().clock.delay);

		expect({
			thrown: outcomeOfCall(() => bounded.connect('tenant.test:443')),
			receivers: receivers.map((receiver) => receiver === binding)
		}).toStrictEqual({ thrown: 'Error', receivers: [true] });
	});

	it('refuses a read without sending it when the read deadline has passed', async () => {
		const { clock, requested, advance } = passingClock();
		const sent: string[] = [];
		const bounded = boundedTenantService(
			tenantWorkerAnswering((request) => {
				sent.push(new URL(request.url).pathname);

				return answerAtOnce();
			}),
			clock.delay
		);
		const deadline = new SharedDeadline(readRequestBudgetMs, clock.now);
		advance(readRequestBudgetMs);
		const capture = startCapture();

		try {
			const outcome = await outcomeOf(
				withinTenantWorkerRead({ read: 'narinfo', deadline }, () =>
					bounded.fetch('https://tenant.test/a.narinfo')
				)
			);

			expect({
				outcome,
				records: streamRecords(capture.logs),
				requested,
				sent
			}).toStrictEqual({
				outcome: 'ForwardedReadTimeoutError',
				records: [
					{
						level: 'warning',
						category: ['cupboard', 'tenant-worker'],
						message: 'tenant Worker response deadline passed',
						properties: { kind: 'narinfo', deadlineMs: 0 }
					}
				],
				requested: [],
				sent: []
			});
		} finally {
			capture.stop();
		}
	});

	it('refuses a fetch that does not specify its read and deadline', async () => {
		const { clock, requested } = passingClock();
		const sent: string[] = [];
		const bounded = boundedTenantService(
			tenantWorkerAnswering((request) => {
				sent.push(new URL(request.url).pathname);

				return answerAtOnce();
			}),
			clock.delay
		);

		expect({
			outcome: await outcomeOf(bounded.fetch('https://tenant.test/a.narinfo')),
			requested,
			sent
		}).toStrictEqual({
			outcome: 'TenantWorkerReadUnspecifiedError',
			requested: [],
			sent: []
		});
	});
});

describe('a read that the control Worker forwards to the tenant object', () => {
	it.each([
		{ name: 'no budget is left', usedMs: readRequestBudgetMs, requested: [] },
		{
			name: 'the deadline passes',
			usedMs: 0,
			requested: [readRequestBudgetMs]
		}
	])(
		'fails with the error of a forwarded read when $name',
		async ({ usedMs, requested: expectedRequested }) => {
			const { clock, requested, advance } = passingClock();
			const objects = boundedTenantObjects(stalledTenantObjects(), clock.delay);
			const deadline = new SharedDeadline(readRequestBudgetMs, clock.now);
			advance(usedMs);

			const outcome = await outcomeOf(
				withinReadDeadline(deadline, () =>
					objects
						.get(objects.idFromName('read'))
						.fetch('https://tenant.test/nix-cache-info')
				)
			);

			expect({ outcome, requested }).toStrictEqual({
				outcome: 'ForwardedReadTimeoutError',
				requested: expectedRequested
			});
		}
	);
});

function outcomeOfCall(call: () => unknown): string {
	try {
		call();

		return 'returned';
	} catch (error) {
		return error instanceof Error ? error.name : 'other';
	}
}
