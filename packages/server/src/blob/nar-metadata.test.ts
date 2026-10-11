import { describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';

import {
	NarMetadataBufferBudget,
	OptionalNarMetadata
} from './nar-metadata.ts';

describe('optional NAR metadata', () => {
	it('copies decoder buffers and finishes in order through a deferred task', async () => {
		const blocked = Promise.withResolvers<undefined>();
		const deferred: Promise<void>[] = [];
		const chunks: number[][] = [];
		let wasFinished = false;
		const aborts: unknown[] = [];
		const metadata = new OptionalNarMetadata(
			{
				defer(completion) {
					deferred.push(completion);
				},
				sink: {
					async write(chunk) {
						await blocked.promise;
						chunks.push([...chunk]);
					},
					finish() {
						wasFinished = true;
						return Promise.resolve();
					},
					abort(reason) {
						aborts.push(reason);
						return Promise.resolve();
					}
				}
			},
			new NarMetadataBufferBudget(4)
		);
		const first = new Uint8Array([1, 2]);
		const second = new Uint8Array([3, 4]);
		metadata.write(first);
		metadata.write(second);
		first.fill(9);
		second.fill(9);
		metadata.finish();
		expect({ chunks, wasFinished, deferred }).toStrictEqual({
			chunks: [],
			wasFinished: false,
			deferred: [expect.any(Promise)]
		});
		blocked.resolve(undefined);
		await Promise.all(deferred);
		expect({ chunks, wasFinished, aborts }).toStrictEqual({
			chunks: [
				[1, 2],
				[3, 4]
			],
			wasFinished: true,
			aborts: []
		});
	});

	it.each(['resolve', 'reject'] as const)(
		'keeps a stalled buffer charged after overflow until a late %s',
		async (outcome) => {
			const blocked = Promise.withResolvers<undefined>();
			const deferred: Promise<void>[] = [];
			const budget = new NarMetadataBufferBudget(4);
			const abort = vi.fn<(_: unknown) => Promise<void>>().mockResolvedValue();
			const finish = vi.fn<() => Promise<void>>().mockResolvedValue();
			const write = vi.fn(() => blocked.promise);
			const metadata = new OptionalNarMetadata(
				{
					maxBufferedBytes: 4,
					defer(completion) {
						deferred.push(completion);
					},
					sink: { write, finish, abort }
				},
				budget
			);
			metadata.write(new Uint8Array([1, 2]));
			metadata.write(new Uint8Array([3, 4]));
			metadata.write(new Uint8Array([5]));
			metadata.finish();
			await Promise.all(deferred);
			expect({
				writes: write.mock.calls,
				finishes: finish.mock.calls,
				aborts: abort.mock.calls,
				canReserveThreeBytes: budget.reserve(3)
			}).toStrictEqual({
				writes: [[new Uint8Array([1, 2]), expect.any(AbortSignal)]],
				finishes: [],
				aborts: [[expect.any(RangeError)]],
				canReserveThreeBytes: false
			});
			if (outcome === 'reject') {
				blocked.reject(new Error('Late metadata failure.'));
			} else {
				blocked.resolve(undefined);
			}
			await vi.waitFor(() => {
				expect(budget.reserve(4)).toBe(true);
			});
			budget.release(4);
		}
	);

	it('releases the original byte count after a sink transfers its copy', async () => {
		const deferred: Promise<void>[] = [];
		const budget = new NarMetadataBufferBudget(4);
		const transferred: number[][] = [];
		const metadata = new OptionalNarMetadata(
			{
				defer(completion) {
					deferred.push(completion);
				},
				sink: {
					write(chunk) {
						if (!(chunk.buffer instanceof ArrayBuffer)) {
							throw new TypeError(
								'The metadata copy must have an ArrayBuffer.'
							);
						}
						transferred.push([
							...structuredClone(chunk, { transfer: [chunk.buffer] })
						]);
						return Promise.resolve();
					},
					finish() {
						return Promise.resolve();
					},
					abort() {
						return Promise.resolve();
					}
				}
			},
			budget
		);
		metadata.write(new Uint8Array([1, 2, 3, 4]));
		metadata.finish();
		await Promise.all(deferred);
		expect({ transferred, canReserveAgain: budget.reserve(4) }).toStrictEqual({
			transferred: [[1, 2, 3, 4]],
			canReserveAgain: true
		});
		budget.release(4);
	});

	it.each(['write', 'finish', 'abort'] as const)(
		'ends the deferred task when %s stalls',
		async (phase) => {
			vi.useFakeTimers();
			const blocked = Promise.withResolvers<undefined>();
			const deferred: Promise<void>[] = [];
			const fault = new Error('Metadata generation failed.');
			let signal: AbortSignal | undefined;
			const finish = vi.fn((active: AbortSignal) => {
				signal = active;
				return phase === 'finish' ? blocked.promise : Promise.resolve();
			});
			const abort = vi.fn((_: unknown) =>
				phase === 'abort' ? blocked.promise : Promise.resolve()
			);
			try {
				const metadata = new OptionalNarMetadata(
					{
						operationTimeoutMs: 10,
						defer(completion) {
							deferred.push(completion);
						},
						sink: {
							write(_, active) {
								signal = active;
								if (phase === 'abort') {
									throw fault;
								}
								return phase === 'write' ? blocked.promise : Promise.resolve();
							},
							finish,
							abort
						}
					},
					new NarMetadataBufferBudget(4)
				);
				metadata.write(new Uint8Array([1]));
				metadata.finish();
				await vi.runAllTimersAsync();
				await Promise.all(deferred);
				expect({
					wasCanceled: signal?.aborted,
					finishes: finish.mock.calls,
					aborts: abort.mock.calls
				}).toStrictEqual({
					wasCanceled: true,
					finishes: phase === 'finish' ? [[expect.any(AbortSignal)]] : [],
					aborts: [
						[phase === 'abort' ? fault : expect.any(SubrequestTimeoutError)]
					]
				});
			} finally {
				blocked.resolve(undefined);
				vi.useRealTimers();
			}
		}
	);
});
