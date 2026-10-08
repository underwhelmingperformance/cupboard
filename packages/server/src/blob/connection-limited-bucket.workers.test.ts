import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import { type R2ObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import { clearBlobStorage } from '../test-support.ts';

import {
	ConnectionLimitedBucket,
	type R2ObjectStore
} from './connection-limited-bucket.ts';

const limit = 2;

type RequestKind = 'get' | 'put';

interface GatedStore {
	readonly store: R2ObjectStore;
	readonly started: RequestKind[];
	readonly answer: (index: number) => void;
	readonly fail: (index: number) => void;
}

// Sends each request to R2 only after the test lets it through. Until the test
// answers or fails a request, the request stays open and keeps its connection.
function gatedStore(): GatedStore {
	const started: RequestKind[] = [];
	const gates: PromiseWithResolvers<undefined>[] = [];
	const open = async (kind: RequestKind): Promise<void> => {
		const gate = Promise.withResolvers<undefined>();
		started.push(kind);
		gates.push(gate);
		await gate.promise;
	};

	return {
		started,
		store: {
			get: async (key) => {
				await open('get');

				return env.BLOBS.get(key);
			},
			put: async (key, value, options) => {
				await open('put');

				return env.BLOBS.put(key, value, options);
			}
		},
		answer: (index) => {
			gates[index]?.resolve(undefined);
		},
		fail: (index) => {
			gates[index]?.reject(new Error('R2 failed'));
		}
	};
}

function key(name: string): R2ObjectKey {
	return r2ObjectKeySchema.parse(`staging/connection-limit/${name}`);
}

function fixedBody(bytes: Uint8Array): ReadableStream {
	const stream = new FixedLengthStream(bytes.byteLength);
	const writer = stream.writable.getWriter();
	void writer.write(bytes).then(() => writer.close());

	return stream.readable;
}

async function settled(promise: Promise<unknown>): Promise<void> {
	try {
		await promise;
	} catch {
		// The test inspects which requests started, not their results.
	}
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) {
		await Promise.resolve();
	}
}

describe('ConnectionLimitedBucket', () => {
	beforeEach(async () => {
		await clearBlobStorage();
		await env.BLOBS.put(key('source'), new Uint8Array([1, 2, 3]));
	});

	it.each([
		{ request: 'get', ends: 'is answered' },
		{ request: 'get', ends: 'fails' },
		{ request: 'put', ends: 'is answered' },
		{ request: 'put', ends: 'fails' }
	] as const)(
		'keeps a connection for an open $request until it $ends',
		async ({ request, ends }) => {
			const gated = gatedStore();
			const bucket = new ConnectionLimitedBucket(gated.store, limit);
			const first: Promise<unknown> =
				request === 'get'
					? bucket.get(key('source'))
					: bucket.put(key('put'), fixedBody(new Uint8Array([1])), {});
			// Gets take the other connections, because puts never take the last
			// one.
			const others = Array.from({ length: limit - 1 }, () =>
				bucket.get(key('source'))
			);
			const queued = bucket.get(key('source'));

			await flushMicrotasks();
			const startedAtLimit = [...gated.started];

			if (ends === 'is answered') {
				gated.answer(0);
			} else {
				gated.fail(0);
			}

			await settled(first);
			await flushMicrotasks();
			const startedAfterOne = [...gated.started];

			for (let index = 1; index <= limit; index += 1) {
				gated.answer(index);
			}
			await Promise.all(
				[...others, queued].map(async (request) => settled(request))
			);

			expect({ startedAtLimit, startedAfterOne }).toStrictEqual({
				startedAtLimit: [request, 'get'],
				startedAfterOne: [request, 'get', 'get']
			});
		}
	);

	it('completes reads that feed writes when there are more of them than connections', async () => {
		const bucket = new ConnectionLimitedBucket(env.BLOBS, limit);
		const copies = Array.from({ length: limit * 3 }, (_, index) =>
			key(`copy-${String(index)}`)
		);

		await Promise.all(
			copies.map(async (target) => {
				const source = await bucket.get(key('source'));

				if (source === null) {
					throw new Error('the source object must exist');
				}

				const stream = new FixedLengthStream(source.size);
				void source.body.pipeTo(stream.writable);
				await bucket.put(target, stream.readable, {});
			})
		);
		const stored = await env.BLOBS.list({
			prefix: 'staging/connection-limit/copy-'
		});

		expect(
			stored.objects.map((object) => object.key).toSorted(byCodeUnit)
		).toStrictEqual(copies.toSorted(byCodeUnit));
	});

	// A put keeps its connection until its body is complete, so puts that
	// filled every connection would wait for reads that can never start.
	it('completes writes whose bodies come from reads that start after them', async () => {
		// R2 answers a put only after it has received the whole body.
		const store: R2ObjectStore = {
			get: (target) => env.BLOBS.get(target),
			put: async (target, value, options) =>
				env.BLOBS.put(target, await new Response(value).arrayBuffer(), options)
		};
		const bucket = new ConnectionLimitedBucket(store, limit);
		const puts = Array.from({ length: limit }, (_, index) => {
			const stream = new FixedLengthStream(3);

			return {
				stream,
				put: bucket.put(key(`fed-${String(index)}`), stream.readable, {})
			};
		});
		const writes = Promise.all(
			puts.map(async ({ stream, put }) => {
				const source = await bucket.get(key('source'));

				if (source === null) {
					throw new Error('the source object must exist');
				}

				await source.body.pipeTo(stream.writable);
				await put;
			})
		);

		const completed = async (): Promise<string> => {
			await writes;

			return 'completed';
		};
		const timedOut = async (): Promise<string> => {
			await scheduler.wait(2000);

			return 'still waiting';
		};

		const outcome = await Promise.race([completed(), timedOut()]);

		expect(outcome).toBe('completed');
	});
});
