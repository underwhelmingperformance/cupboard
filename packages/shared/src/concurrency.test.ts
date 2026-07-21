import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from './concurrency.ts';

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

	// `NaN` would spawn zero workers and silently drop every value.
	it('refuses a NaN concurrency', async () => {
		await expect(
			mapWithConcurrency([1, 2], NaN, (value) => Promise.resolve(value))
		).rejects.toBeInstanceOf(RangeError);
	});

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

		void (async () => {
			try {
				await resultPromise;
			} catch {
				// Settled deliberately below; this only silences the rejection
				// while the test orchestrates the in-flight work.
			}
		})();

		await flushMicrotasks();
		blocked.resolve(2);

		await expect(resultPromise).rejects.toBe(failure);
		expect(started).toStrictEqual([1, 2]);
	});
});

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	const box: { resolve?: (value: T) => void } = {};
	const promise = new Promise<T>((resolve) => {
		box.resolve = resolve;
	});

	return {
		promise,
		resolve: (value: T) => {
			box.resolve?.(value);
		}
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 5; iteration += 1) {
		await Promise.resolve();
	}
}
