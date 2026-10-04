import { describe, expect, it, vi } from 'vitest';

import { r2ObjectKeySchema } from '../http/http.ts';

import { drainObjectDeletionPages } from './bulk.ts';
import { spendSubrequests, withSubrequestSlice } from './subrequest-slice.ts';

function fixture(count: number) {
	let pending = Array.from({ length: count }, (_, index) =>
		r2ObjectKeySchema.parse(`staging/${String(index)}`)
	);
	const read = vi.fn((limit: number) => pending.slice(0, limit));
	const acknowledge = vi.fn((keys: readonly string[]) => {
		pending = pending.filter((key) => !keys.includes(key));
	});
	const deleteKeys = vi.fn<R2Bucket['delete']>(() => {
		spendSubrequests(1);
		return Promise.resolve();
	});
	return {
		pending: () => pending,
		read,
		acknowledge,
		bucket: { delete: deleteKeys },
		deleteKeys
	};
}

describe('durable object deletion pages', () => {
	it.each([0, 2001])('drains %i keys in bounded pages', async (count) => {
		const queue = fixture(count);
		const processed = await drainObjectDeletionPages(
			queue.bucket,
			queue,
			() => true
		);
		expect({
			processed,
			pending: queue.pending(),
			sizes: queue.deleteKeys.mock.calls.map(([keys]) =>
				typeof keys === 'string' ? 1 : keys.length
			),
			readLimits: queue.read.mock.calls
		}).toStrictEqual({
			processed: count,
			pending: [],
			sizes: count === 0 ? [] : [1000, 1000, 1],
			readLimits: count === 0 ? [[1000]] : [[1000], [1000], [1000], [1000]]
		});
	});

	it('defers before reading when the next request cannot fit', async () => {
		const queue = fixture(1);
		const processed = await withSubrequestSlice(
			() => drainObjectDeletionPages(queue.bucket, queue, () => true),
			{ subrequests: 0, reserve: 0 }
		);
		expect({
			processed,
			reads: queue.read.mock.calls,
			acknowledgements: queue.acknowledge.mock.calls,
			deletions: queue.deleteKeys.mock.calls
		}).toStrictEqual({
			processed: 0,
			reads: [],
			acknowledgements: [],
			deletions: []
		});
	});

	it('stops after a page when the remaining invocation budget is exhausted', async () => {
		const queue = fixture(1001);
		const processed = await withSubrequestSlice(
			() => drainObjectDeletionPages(queue.bucket, queue, () => true),
			{ subrequests: 1, reserve: 0 }
		);
		expect({
			processed,
			pending: queue.pending(),
			acknowledgements: queue.acknowledge.mock.calls.length,
			reads: queue.read.mock.calls
		}).toStrictEqual({
			processed: 1000,
			pending: [r2ObjectKeySchema.parse('staging/1000')],
			acknowledgements: 1,
			reads: [[1000]]
		});
	});

	it('keeps the failed page and acknowledges preceding successful pages', async () => {
		const queue = fixture(1001);
		const failure = new Error('R2 unavailable');
		queue.deleteKeys.mockResolvedValueOnce().mockRejectedValueOnce(failure);
		await expect(
			drainObjectDeletionPages(queue.bucket, queue, () => true)
		).rejects.toBe(failure);
		expect({
			pending: queue.pending(),
			acknowledgements: queue.acknowledge.mock.calls.length
		}).toStrictEqual({
			pending: [r2ObjectKeySchema.parse('staging/1000')],
			acknowledgements: 1
		});
	});

	it('does not start another page when the continuation policy stops work', async () => {
		const queue = fixture(1001);
		const canContinue = vi
			.fn()
			.mockReturnValueOnce(true)
			.mockReturnValue(false);
		const processed = await drainObjectDeletionPages(
			queue.bucket,
			queue,
			canContinue
		);
		expect({
			processed,
			pending: queue.pending(),
			reads: queue.read.mock.calls
		}).toStrictEqual({
			processed: 1000,
			pending: [r2ObjectKeySchema.parse('staging/1000')],
			reads: [[1000]]
		});
	});
});
