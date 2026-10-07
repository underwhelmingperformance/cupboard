import { describe, expect, it } from 'vitest';

import { drainWithConcurrency, mapWithConcurrency } from './concurrency.ts';

describe('mapWithConcurrency', () => {
	it('resolves each value in input order, even when the first settles last', async () => {
		const first = deferred<string>();
		const second = deferred<string>();

		const resultPromise = mapWithConcurrency([1, 2, 3], 3, (value) => {
			if (value === 1) {
				return first.promise;
			}

			if (value === 2) {
				return second.promise;
			}

			return Promise.resolve('c');
		});

		second.resolve('b');
		first.resolve('a');

		await expect(resultPromise).resolves.toStrictEqual(['a', 'b', 'c']);
	});

	it('never runs more than `concurrency` map calls at once', async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			inFlight -= 1;

			return value;
		});

		expect(maxInFlight).toBe(2);
	});

	it.each([0, -1, 1.5, NaN, Infinity])(
		'refuses an invalid concurrency of %s',
		async (concurrency) => {
			await expect(
				mapWithConcurrency([1, 2], concurrency, (value) =>
					Promise.resolve(value)
				)
			).rejects.toBeInstanceOf(RangeError);
		}
	);

	it('resolves to an empty array for no values', async () => {
		await expect(
			mapWithConcurrency([], 4, () => Promise.resolve('unused'))
		).resolves.toStrictEqual([]);
	});

	it('clamps concurrency to the number of values', async () => {
		const calls: number[] = [];

		await expect(
			mapWithConcurrency([1, 2], 10, (value) => {
				calls.push(value);

				return Promise.resolve(value);
			})
		).resolves.toStrictEqual([1, 2]);
		expect(calls).toStrictEqual([1, 2]);
	});

	it('passes each value together with its input index', async () => {
		const seen: (readonly [string, number])[] = [];

		await mapWithConcurrency(['a', 'b', 'c'], 2, (value, index) => {
			seen.push([value, index]);

			return Promise.resolve(value);
		});

		expect(seen).toStrictEqual([
			['a', 0],
			['b', 1],
			['c', 2]
		]);
	});

	it('stops starting new work once a call has rejected, letting in-flight work finish', async () => {
		const failure = new Error('boom');
		const started: number[] = [];
		const blocked = deferred<number>();
		let hasSettled = false;

		const resultPromise = mapWithConcurrency([1, 2, 3], 2, async (value) => {
			started.push(value);

			if (value === 1) {
				throw failure;
			}

			if (value === 2) {
				return blocked.promise;
			}

			return value;
		});

		void resultPromise
			.then(() => {
				hasSettled = true;
			})
			.catch(() => {
				hasSettled = true;
			});

		await flushMicrotasks();
		expect({ hasSettled, started }).toStrictEqual({
			hasSettled: false,
			started: [1, 2]
		});

		blocked.resolve(2);

		await expect(resultPromise).rejects.toBe(failure);
		expect({ hasSettled, started }).toStrictEqual({
			hasSettled: true,
			started: [1, 2]
		});
	});

	it('preserves the first rejection after every started call has settled', async () => {
		const firstStarted = deferred<number>();
		const secondStarted = deferred<number>();
		const firstFailure = new Error('first');
		const laterFailure = new Error('later');
		let hasSettled = false;
		const resultPromise = mapWithConcurrency([1, 2, 3], 2, (value) =>
			value === 1 ? firstStarted.promise : secondStarted.promise
		);

		void resultPromise
			.then(() => {
				hasSettled = true;
			})
			.catch(() => {
				hasSettled = true;
			});

		secondStarted.reject(firstFailure);
		await flushMicrotasks();
		expect(hasSettled).toBe(false);

		firstStarted.reject(laterFailure);

		await expect(resultPromise).rejects.toBe(firstFailure);
		expect(hasSettled).toBe(true);
	});
});

describe('drainWithConcurrency', () => {
	it('pulls the next value only when a worker becomes free', async () => {
		const events: string[] = [];
		const runs = [
			deferred<undefined>(),
			deferred<undefined>(),
			deferred<undefined>()
		];

		async function* source(): AsyncGenerator<number> {
			for (const value of [0, 1, 2]) {
				await Promise.resolve();
				events.push(`pull ${String(value)}`);
				yield value;
			}
		}

		const drained = drainWithConcurrency(source(), 2, async (value) => {
			events.push(`start ${String(value)}`);
			await runs[value]?.promise;
			events.push(`end ${String(value)}`);
		});

		await flushMicrotasks();
		const whileBothRun = events
			.splice(0)
			.toSorted((left, right) => left.localeCompare(right));

		runs[1]?.resolve(undefined);
		await flushMicrotasks();
		const afterOneEnds = events.splice(0);

		runs[0]?.resolve(undefined);
		runs[2]?.resolve(undefined);
		await drained;

		expect({ whileBothRun, afterOneEnds, atEnd: events }).toStrictEqual({
			whileBothRun: ['pull 0', 'pull 1', 'start 0', 'start 1'],
			afterOneEnds: ['end 1', 'pull 2', 'start 2'],
			atEnd: ['end 0', 'end 2']
		});
	});

	it('never runs more than `concurrency` calls at once', async () => {
		let inFlight = 0;
		let maxInFlight = 0;

		await drainWithConcurrency(values([1, 2, 3, 4, 5]), 2, async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await flushMicrotasks();
			inFlight -= 1;
		});

		expect(maxInFlight).toBe(2);
	});

	it.each([0, -1, 1.5, NaN, Infinity])(
		'refuses an invalid concurrency of %s',
		async (concurrency) => {
			await expect(
				drainWithConcurrency(values([1]), concurrency, () => Promise.resolve())
			).rejects.toBeInstanceOf(RangeError);
		}
	);

	it('stops pulling after a call rejects, finishes started calls and closes the source', async () => {
		const failure = new Error('boom');
		const events: string[] = [];
		const failing = deferred<undefined>();
		const blocked = deferred<undefined>();

		async function* source(): AsyncGenerator<number> {
			try {
				for (const value of [1, 2, 3]) {
					await Promise.resolve();
					events.push(`pull ${String(value)}`);
					yield value;
				}
			} finally {
				events.push('closed');
			}
		}

		const drained = drainWithConcurrency(source(), 2, async (value) => {
			if (value === 1) {
				await failing.promise;
				throw failure;
			}

			await blocked.promise;
			events.push(`end ${String(value)}`);
		});

		await flushMicrotasks();
		failing.resolve(undefined);
		await flushMicrotasks();
		blocked.resolve(undefined);

		await expect(drained).rejects.toBe(failure);
		expect(events).toStrictEqual(['pull 1', 'pull 2', 'end 2', 'closed']);
	});

	it('rejects with a source failure once started calls finish', async () => {
		const failure = new Error('source');
		const blocked = deferred<undefined>();
		const ended: number[] = [];

		async function* source(): AsyncGenerator<number> {
			yield 1;
			await Promise.resolve();
			throw failure;
		}

		const drained = drainWithConcurrency(source(), 2, async (value) => {
			await blocked.promise;
			ended.push(value);
		});

		await flushMicrotasks();
		blocked.resolve(undefined);

		await expect(drained).rejects.toBe(failure);
		expect(ended).toStrictEqual([1]);
	});
});

async function* values<T>(items: readonly T[]): AsyncGenerator<T> {
	for (const item of items) {
		await Promise.resolve();
		yield item;
	}
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: unknown) => void;
} {
	const box: {
		resolve?: (value: T) => void;
		reject?: (reason: unknown) => void;
	} = {};
	const promise = new Promise<T>((resolve, reject) => {
		box.resolve = resolve;
		box.reject = reject;
	});

	return {
		promise,
		resolve: (value: T) => {
			box.resolve?.(value);
		},
		reject: (reason: unknown) => {
			box.reject?.(reason);
		}
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 5; iteration += 1) {
		await Promise.resolve();
	}
}
