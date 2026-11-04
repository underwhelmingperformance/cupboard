import { startCapture } from '@cupboard/logger/testing';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';
import { minimumBodyBudgetMs } from '../policy/streaming.ts';

import {
	boundedBody,
	boundedBodyHeaders,
	forbidStoring
} from './bounded-body.ts';
import {
	drain,
	stalledBody,
	streamRecords
} from './stalled-body.test-support.ts';

const context = { operation: 'test.body', objectKey: 'test/object' };

async function storedBody(bytes: number): Promise<ReadableStream<Uint8Array>> {
	const key = `test/bounded-body/${crypto.randomUUID()}`;
	await env.BLOBS.put(key, new Uint8Array(bytes));
	const object = await env.BLOBS.get(key);

	if (object === null) {
		throw new TypeError('The stored object was not found');
	}

	return object.body;
}

describe('boundedBody', () => {
	it.each([
		{
			name: 'delivers a complete body without a record',
			source: () => storedBody(10_000),
			length: 10_000,
			deadlineMs: 5000,
			expected: {
				drained: { bytes: 10_000, ending: { kind: 'complete' } },
				records: []
			}
		},
		{
			name: 'ends a stalled body at its deadline with one record',
			source: () => stalledBody(4),
			length: 100,
			deadlineMs: minimumBodyBudgetMs,
			expected: {
				drained: {
					bytes: 4,
					ending: { kind: 'deadline', operation: 'test.body' }
				},
				records: [
					{
						level: 'warning',
						category: ['cupboard', 'storage', 'stream'],
						message: 'response body deadline passed',
						properties: {
							...context,
							length: 100,
							deadlineMs: minimumBodyBudgetMs
						}
					}
				]
			}
		},
		{
			name: 'ends a body whose source fails without a record',
			source: () => stalledBody(4, 50),
			length: 100,
			deadlineMs: 5000,
			expected: {
				drained: { bytes: 4, ending: { kind: 'failed', error: 'Error' } },
				records: []
			}
		}
	])('$name', async ({ source, length, deadlineMs, expected }) => {
		const capture = startCapture();
		const kept: Promise<void>[] = [];

		try {
			const drained = await drain(
				boundedBody(await source(), length, deadlineMs, context, (settled) => {
					kept.push(settled);
				})
			);
			await Promise.all(kept);

			expect({
				drained,
				kept: kept.length,
				records: streamRecords(capture.logs)
			}).toStrictEqual({ ...expected, kept: 1 });
		} finally {
			capture.stop();
		}
	});

	it('ends a body without a record when the client cancels it', async () => {
		const capture = startCapture();
		const kept: Promise<void>[] = [];

		try {
			const reader = boundedBody(
				await storedBody(1_000_000),
				1_000_000,
				5000,
				context,
				(settled) => {
					kept.push(settled);
				}
			).getReader();
			const first = await reader.read();
			await reader.cancel(new Error('The client disconnected'));
			await Promise.all(kept);

			expect({
				isFirstChunkRead: !first.done,
				kept: kept.length,
				records: streamRecords(capture.logs)
			}).toStrictEqual({ isFirstChunkRead: true, kept: 1, records: [] });
		} finally {
			capture.stop();
		}
	});
});

describe('boundedBody with too little time left', () => {
	it('throws before the response and cancels the source without a record', async () => {
		const capture = startCapture();
		const kept: Promise<void>[] = [];
		const source = { cancelled: false };

		try {
			const refusal = refusalOf(() =>
				boundedBody(
					new ReadableStream({
						cancel() {
							source.cancelled = true;
						}
					}),
					100,
					minimumBodyBudgetMs - 1,
					context,
					(settled) => {
						kept.push(settled);
					}
				)
			);
			await Promise.all(kept);

			expect({
				refusal,
				isSourceCancelled: source.cancelled,
				kept: kept.length,
				records: streamRecords(capture.logs)
			}).toStrictEqual({
				refusal: { isTimeout: true, subrequest: 'test.body' },
				isSourceCancelled: true,
				kept: 1,
				records: []
			});
		} finally {
			capture.stop();
		}
	});
});

function refusalOf(
	start: () => ReadableStream
): { isTimeout: boolean; subrequest?: string } | undefined {
	try {
		start();

		return undefined;
	} catch (error) {
		return error instanceof SubrequestTimeoutError
			? { isTimeout: true, subrequest: error.subrequest }
			: { isTimeout: false };
	}
}

describe('forbidStoring', () => {
	it.each([
		{ cacheControl: undefined, expected: 'no-store' },
		{ cacheControl: 'public, max-age=3600', expected: 'no-store' },
		{
			cacheControl: 'public, max-age=3600, no-transform',
			expected: 'no-store, no-transform'
		}
	])('replaces $cacheControl', ({ cacheControl, expected }) => {
		const headers = new Headers();

		if (cacheControl !== undefined) {
			headers.set('cache-control', cacheControl);
		}

		forbidStoring(headers);

		expect(Object.fromEntries(headers)).toStrictEqual({
			'cache-control': expected
		});
	});
});

describe('boundedBodyHeaders', () => {
	it.each([
		{ cacheControl: undefined, expected: 'no-transform' },
		{ cacheControl: 'no-store', expected: 'no-store, no-transform' },
		{
			cacheControl: 'public, max-age=3600, must-revalidate',
			expected: 'public, max-age=3600, must-revalidate, no-transform'
		},
		{
			cacheControl: 'no-transform, no-store',
			expected: 'no-transform, no-store'
		}
	])(
		'declares the length and forbids transformation of $cacheControl',
		({ cacheControl, expected }) => {
			const headers = new Headers({ 'content-type': 'application/json' });

			if (cacheControl !== undefined) {
				headers.set('cache-control', cacheControl);
			}

			expect(Object.fromEntries(boundedBodyHeaders(headers, 42))).toStrictEqual(
				{
					'cache-control': expected,
					'content-length': '42',
					'content-type': 'application/json'
				}
			);
		}
	);
});
