import { describe, expect, it, vi } from 'vitest';

import { bestEffort, discardResponseBody, withCleanup } from './cleanup.ts';

describe('withCleanup', () => {
	it('preserves an operation failure when cleanup also fails', async () => {
		const primary = new Error('operation failed');
		const cleanup = vi.fn(() => Promise.reject(new Error('cleanup failed')));

		await expect(
			withCleanup(() => Promise.reject(primary), cleanup)
		).rejects.toBe(primary);
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('surfaces a cleanup failure after a successful operation', async () => {
		const cleanupFailure = new Error('cleanup failed');

		await expect(
			withCleanup(
				() => Promise.resolve('complete'),
				() => Promise.reject(cleanupFailure)
			)
		).rejects.toBe(cleanupFailure);
	});
});

describe('bestEffort', () => {
	it('settles after its operation fails', async () => {
		await expect(
			bestEffort(() => Promise.reject(new Error('discard failed')))
		).resolves.toBeUndefined();
	});

	it('does not surface a rejected response cancellation', async () => {
		const response = new Response(
			new ReadableStream({
				cancel: () => Promise.reject(new Error('cancel failed'))
			})
		);

		await expect(discardResponseBody(response)).resolves.toBeUndefined();
	});
});
