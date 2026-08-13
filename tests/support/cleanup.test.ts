import { describe, expect, it } from 'vitest';

import { onceAsync, settleCleanups } from './cleanup.ts';

describe('onceAsync', () => {
	it('returns one cleanup outcome across repeated calls', async () => {
		let calls = 0;
		const close = onceAsync(() => {
			calls += 1;
			return Promise.resolve();
		});

		const first = close();
		const second = close();

		expect(second).toBe(first);
		await expect(Promise.all([first, second])).resolves.toStrictEqual([
			undefined,
			undefined
		]);
		expect(calls).toBe(1);
	});
});

describe('settleCleanups', () => {
	it('runs every cleanup and rethrows the only failure', async () => {
		const failure = new Error('store cleanup failed');
		const completed: string[] = [];

		await expect(
			settleCleanups(
				[
					() => {
						completed.push('store');
						return Promise.reject(failure);
					},
					() => {
						completed.push('server');
						return Promise.resolve();
					}
				],
				'cleanup failed'
			)
		).rejects.toBe(failure);
		expect(completed).toStrictEqual(['store', 'server']);
	});

	it('preserves every failure in cleanup order', async () => {
		const storeFailure = new Error('store cleanup failed');
		const serverFailure = new Error('server cleanup failed');

		let failure: unknown;

		try {
			await settleCleanups(
				[
					() => Promise.reject(storeFailure),
					() => Promise.reject(serverFailure)
				],
				'remote fixture cleanup failed'
			);
		} catch (error) {
			failure = error;
		}

		expect(failure).toStrictEqual(
			new AggregateError(
				[storeFailure, serverFailure],
				'remote fixture cleanup failed'
			)
		);
	});
});
