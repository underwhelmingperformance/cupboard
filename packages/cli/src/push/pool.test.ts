import { describe, expect, it } from 'vitest';

import { runWithConcurrency } from './pool.ts';

describe('runWithConcurrency', () => {
	it('processes every item without exceeding the limit', async () => {
		const items = [0, 1, 2, 3, 4];
		const processed: number[] = [];
		let inFlight = 0;
		let maxInFlight = 0;

		await runWithConcurrency(items, 2, async (item) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			processed.push(item);
			inFlight -= 1;
		});

		expect({
			processed: processed.toSorted((a, b) => a - b),
			maxInFlight
		}).toStrictEqual({
			processed: [0, 1, 2, 3, 4],
			maxInFlight: 2
		});
	});

	it('runs a single worker when the limit exceeds the item count', async () => {
		let maxInFlight = 0;
		let inFlight = 0;

		await runWithConcurrency([1], 8, async () => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await Promise.resolve();
			inFlight -= 1;
		});

		expect(maxInFlight).toBe(1);
	});

	it('does nothing for an empty list', async () => {
		const processed: number[] = [];

		await runWithConcurrency<number>([], 4, (item) => {
			processed.push(item);
			return Promise.resolve();
		});

		expect(processed).toStrictEqual([]);
	});

	it('stops scheduling and propagates the first worker failure', async () => {
		const started: number[] = [];
		const failure = new Error('upload failed');

		const result = runWithConcurrency([0, 1, 2, 3], 1, (item) => {
			started.push(item);

			return item === 1 ? Promise.reject(failure) : Promise.resolve();
		});

		await expect(result).rejects.toBe(failure);
		expect(started).toStrictEqual([0, 1]);
	});
});
