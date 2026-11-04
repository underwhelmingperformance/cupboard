import { startCapture } from '@cupboard/logger/testing';
import {
	type CacheScope,
	firstCacheGeneration,
	type StorePathHash,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	createExecutionContext,
	waitOnExecutionContext
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { firstCacheReadRevision } from '../db/cache-generation.ts';
import { boundedWorkerEnv } from '../do/bounded-io.ts';
import { narInfoObjectKey } from '../http/http.ts';
import {
	drain,
	passThrough,
	recordKeptPromises,
	stallingBlobs,
	streamRecords
} from '../http/stalled-body.test-support.ts';
import {
	minimumBodyBudgetMs,
	readRequestBudgetMs
} from '../policy/streaming.ts';
import { canonicalCacheRequest } from '../routing/cache-request.ts';
import { tenantReadFetch } from '../routing/tenant-read-handler.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	bootstrap,
	currentOrigin,
	defaultCache,
	namedCache,
	narBytes,
	provisionFixtureTenant,
	pushPath,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';
import worker from '../worker.ts';

const privateCache = namedCache('builds');
const reader = { user: 'alice', password: 'secret' };
const credentials = `Basic ${btoa(`${reader.user}:${reader.password}`)}`;

// The stalled body is released, in real time, well after every deadline in
// these tests, so only a deadline can end it first.
const stallReleaseMs = readRequestBudgetMs + 10_000;
const sentBytes = 4;

// The narinfo's `get()` takes this long, on the test's fake clock, so the body
// receives what remains of the read's deadline.
const readDelayMs = 5000;

// The request ID differs on every request.
const variableFields = ['requestId'];

interface ReadRoute {
	readonly name: string;
	readonly cache: CacheScope;
	// The control Worker gives each request an ID, which its records include.
	readonly recordContext: Readonly<Record<string, string>>;
	readonly read: (
		storePathHash: StorePathHash,
		blobs: R2Bucket,
		ctx: ExecutionContext,
		method?: string
	) => Promise<Response>;
}

/**
Reads a public narinfo through the tenant read app, which the tenant
Worker's cached entrypoint runs.
*/
function publicRead(
	storePathHash: StorePathHash,
	blobs: R2Bucket,
	ctx: ExecutionContext,
	method = 'GET'
): Promise<Response> {
	const url = new URL(
		`/t/${fixtureTenant}/${storePathHash}.narinfo`,
		currentOrigin()
	);
	const request = canonicalCacheRequest(new Request(url, { method }), {
		generation: firstCacheGeneration,
		readRevision: firstCacheReadRevision
	});
	const bindings = boundedWorkerEnv(Object.assign({}, env, { BLOBS: blobs }));

	return tenantReadFetch(request, bindings, ctx);
}

/**
Reads a private narinfo through the control Worker.
*/
function privateRead(
	storePathHash: StorePathHash,
	blobs: R2Bucket,
	ctx: ExecutionContext,
	method = 'GET'
): Promise<Response> {
	const request = new Request<unknown, IncomingRequestCfProperties>(
		new URL(
			`/t/${fixtureTenant}/cache/builds/${storePathHash}.narinfo`,
			currentOrigin()
		),
		{ method, headers: { authorization: credentials } }
	);

	return worker.fetch(request, Object.assign({}, env, { BLOBS: blobs }), ctx);
}

const routes: readonly ReadRoute[] = [
	{
		name: 'a public cache, through the tenant read app',
		cache: defaultCache(),
		recordContext: {},
		read: publicRead
	},
	{
		name: 'a private cache, through the control Worker',
		cache: privateCache,
		recordContext: { requestId: 'string' },
		read: privateRead
	}
];

async function publishPath(): Promise<StorePathHash> {
	const { token } = await bootstrap({
		caches: [{ scope: privateCache, access: 'private' }]
	});
	const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

	for (const cache of [defaultCache(), privateCache]) {
		await pushPath(token, metadata, cache);
	}

	await provisionFixtureTenant({ read: reader });

	return storePathHashSchema.parse(metadata.storePathHash);
}

async function storedSize(key: string): Promise<number> {
	const object = await env.BLOBS.head(key);

	if (object === null) {
		throw new TypeError(`${key} is not stored`);
	}

	return object.size;
}

function runTimersFor(delayMs: number): void {
	vi.advanceTimersByTime(delayMs);
}

// The timers do not run, so a delay longer than the `get()` cap does not end
// the read.
function moveClockOnly(delayMs: number): void {
	vi.setSystemTime(Date.now() + delayMs);
}

/**
A bucket whose `get()` of `key` moves the fake clock on by `delayMs` with
`delay` before it returns, as a slow read would.
*/
function delayedReads(
	bucket: R2Bucket,
	key: string,
	delayMs = readDelayMs,
	delay = runTimersFor
): R2Bucket {
	return new Proxy(bucket, {
		get(target, property) {
			if (property !== 'get') {
				return passThrough(target, property);
			}

			return (read: string, options?: R2GetOptions) => {
				if (read === key) {
					delay(delayMs);
				}

				return target.get(read, options);
			};
		}
	});
}

async function readWhole(
	route: ReadRoute,
	storePathHash: StorePathHash
): Promise<void> {
	const ctx = createExecutionContext();
	const response = await route.read(storePathHash, env.BLOBS, ctx);
	await drain(response.body);
	await waitOnExecutionContext(ctx);
}

describe('a narinfo body whose R2 source stalls', () => {
	beforeEach(resetTestServer);
	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(routes)(
		'ends a narinfo from $name at what remains of the read deadline',
		async (route) => {
			const storePathHash = await publishPath();
			const key = narInfoObjectKey(fixtureTenant, storePathHash, route.cache);
			const size = await storedSize(key);
			// The first read through the control Worker caches its membership
			// filter with `waitUntil`, so only the bounded body's pipe is kept
			// during the stalled read.
			await readWhole(route, storePathHash);
			const capture = startCapture();
			const ctx = createExecutionContext();
			const kept = recordKeptPromises(ctx);
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

			try {
				const response = await route.read(
					storePathHash,
					delayedReads(
						stallingBlobs(
							env.BLOBS,
							(read) => (read === key ? sentBytes : undefined),
							stallReleaseMs
						),
						key
					),
					ctx
				);
				const draining = drain(response.body);
				const bodyBudgetMs = readRequestBudgetMs - readDelayMs;
				await vi.advanceTimersByTimeAsync(bodyBudgetMs - 1);
				const keptBeforeDeadline = kept.settlements();
				await vi.advanceTimersByTimeAsync(readDelayMs + 1);
				const drained = await draining;
				await waitOnExecutionContext(ctx);

				expect({
					status: response.status,
					contentLength: response.headers.get('content-length'),
					cacheControl: response.headers.get('cache-control'),
					drained,
					keptBeforeDeadline,
					keptAfterDeadline: kept.settlements(),
					records: streamRecords(capture.logs, variableFields)
				}).toStrictEqual({
					status: StatusCodes.OK,
					contentLength: String(size),
					cacheControl:
						route.cache.kind === 'default'
							? 'public, max-age=3600, must-revalidate, no-transform'
							: 'no-store, no-transform',
					drained: {
						bytes: sentBytes,
						ending: { kind: 'deadline', operation: 'narinfo.body' }
					},
					keptBeforeDeadline: ['pending'],
					keptAfterDeadline: ['settled'],
					records: [
						{
							level: 'warning',
							category: ['cupboard', 'storage', 'stream'],
							message: 'response body deadline passed',
							properties: {
								...route.recordContext,
								operation: 'narinfo.body',
								objectKey: key,
								length: size,
								// The read's deadline less the time that its `get()` took.
								deadlineMs: bodyBudgetMs
							}
						}
					]
				});
			} finally {
				kept.stop();
				capture.stop();
			}
		}
	);

	it.each(routes)(
		'refuses a narinfo from $name when its reads leave the body too little time',
		async (route) => {
			const storePathHash = await publishPath();
			const key = narInfoObjectKey(fixtureTenant, storePathHash, route.cache);
			const capture = startCapture();
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

			try {
				const ctx = createExecutionContext();
				const response = await route.read(
					storePathHash,
					delayedReads(
						env.BLOBS,
						key,
						readRequestBudgetMs - minimumBodyBudgetMs / 2,
						moveClockOnly
					),
					ctx
				);
				await drain(response.body);
				await waitOnExecutionContext(ctx);

				expect({
					status: response.status,
					retryAfter: response.headers.get('retry-after'),
					cacheControl: response.headers.get('cache-control'),
					records: streamRecords(capture.logs, variableFields)
				}).toStrictEqual({
					status: StatusCodes.SERVICE_UNAVAILABLE,
					retryAfter: '5',
					cacheControl: 'no-store',
					records: []
				});
			} finally {
				capture.stop();
			}
		}
	);

	it.each(routes)(
		'serves a whole narinfo from $name without a record',
		async (route) => {
			const storePathHash = await publishPath();
			const key = narInfoObjectKey(fixtureTenant, storePathHash, route.cache);
			const size = await storedSize(key);
			const capture = startCapture();

			try {
				const ctx = createExecutionContext();
				const response = await route.read(storePathHash, env.BLOBS, ctx);
				const drained = await drain(response.body);
				await waitOnExecutionContext(ctx);

				expect({
					status: response.status,
					contentLength: response.headers.get('content-length'),
					drained,
					records: streamRecords(capture.logs, variableFields)
				}).toStrictEqual({
					status: StatusCodes.OK,
					contentLength: String(size),
					drained: { bytes: size, ending: { kind: 'complete' } },
					records: []
				});
			} finally {
				capture.stop();
			}
		}
	);

	it('answers HEAD for a public narinfo without a bounded body', async () => {
		const storePathHash = await publishPath();
		const key = narInfoObjectKey(fixtureTenant, storePathHash, defaultCache());
		const capture = startCapture();
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

		try {
			// A public HEAD reads the object as a GET does, and Hono discards the
			// body. A bounded body that nothing reads would end at its deadline and
			// write a record.
			const ctx = createExecutionContext();
			const response = await publicRead(
				storePathHash,
				stallingBlobs(
					env.BLOBS,
					(read) => (read === key ? sentBytes : undefined),
					stallReleaseMs
				),
				ctx,
				'HEAD'
			);
			await vi.advanceTimersByTimeAsync(readRequestBudgetMs);
			await waitOnExecutionContext(ctx);

			expect({
				status: response.status,
				contentLength: response.headers.get('content-length'),
				records: streamRecords(capture.logs, variableFields)
			}).toStrictEqual({
				status: StatusCodes.OK,
				contentLength: String(await storedSize(key)),
				records: []
			});
		} finally {
			capture.stop();
		}
	});
});
