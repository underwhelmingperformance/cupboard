import { startCapture } from '@cupboard/logger/testing';
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
import { passThrough } from '../do/pass-through.ts';
import {
	boundedTenantObjects,
	type DeadlineClock
} from '../do/tenant-object-fetch.ts';
import { streamRecords } from '../http/stalled-body.test-support.ts';
import {
	readRequestBudgetMs,
	tenantOperationBudgetMs
} from '../policy/streaming.ts';
import {
	currentOrigin,
	handlerFetch,
	initialiseViaWorker,
	provisionFixtureTenant,
	readFetch,
	recordTransition,
	resetTestServer
} from '../test-support.ts';

import { canonicalCacheRequest } from './cache-request.ts';
import { controlWorker } from './handler.ts';
import { cachedTenantReadFetch } from './tenant-read-handler.ts';
import { fixtureTenant } from './tenant-routing.test-support.ts';

const reader = { user: 'alice', password: 'secret' };
const credentials = `Basic ${btoa(`${reader.user}:${reader.password}`)}`;
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
	headers: { 'content-type': 'application/json', authorization: credentials },
	body: JSON.stringify(body)
});

const authorisedGet: RequestInit = { headers: { authorization: credentials } };

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
		await provisionFixtureTenant({
			read: reader,
			defaultCacheAccess: 'private'
		});
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
