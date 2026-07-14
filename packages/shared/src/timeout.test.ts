import { describe, expect, it, vi } from 'vitest';

import { withDeadline } from './timeout.ts';

// A caller's typed timeout error; the wrapper must reject with exactly what
// `makeError` returns, so tests assert on the type rather than a message.
class TestTimeoutError extends Error {
	constructor() {
		super('timed out');
		this.name = 'TestTimeoutError';
	}
}

describe('withDeadline', () => {
	it('resolves with the operation result when it settles first', async () => {
		const result = await withDeadline(
			() => Promise.resolve('ok'),
			1000,
			() => new TestTimeoutError()
		);

		expect(result).toBe('ok');
	});

	it('propagates the operation rejection unchanged when it rejects first', async () => {
		const failure = new Error('operation failed');

		await expect(
			withDeadline(
				() => Promise.reject(failure),
				1000,
				() => new TestTimeoutError()
			)
		).rejects.toBe(failure);
	});

	it('rejects with makeError() when the deadline elapses first', async () => {
		vi.useFakeTimers();

		try {
			const pending = withDeadline(
				() => Promise.race([]),
				1000,
				() => new TestTimeoutError()
			);
			const rejects = expect(pending).rejects.toBeInstanceOf(TestTimeoutError);

			await vi.advanceTimersByTimeAsync(1000);
			await rejects;
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears the timer once the operation settles', async () => {
		vi.useFakeTimers();

		try {
			await withDeadline(
				() => Promise.resolve('ok'),
				1000,
				() => new TestTimeoutError()
			);

			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('never calls makeError when the operation settles first', async () => {
		const makeError = vi.fn(() => new TestTimeoutError());

		await withDeadline(() => Promise.resolve('ok'), 1000, makeError);

		expect(makeError).not.toHaveBeenCalled();
	});

	it.each([
		{
			settle: 'resolves',
			settleOperation: (
				resolve: (value: string) => void,
				_reject: (reason: Error) => void
			) => {
				resolve('ok');
			}
		},
		{
			settle: 'rejects',
			settleOperation: (
				_resolve: (value: string) => void,
				reject: (reason: Error) => void
			) => {
				reject(new Error('operation failed'));
			}
		}
	])(
		'settles the abandoned signal once the operation later $settle',
		async ({ settleOperation }) => {
			vi.useFakeTimers();

			try {
				const operation = Promise.withResolvers<string>();

				let abandoned: Promise<void> | undefined;
				const pending = withDeadline(
					() => operation.promise,
					1000,
					(signal) => {
						abandoned = signal;
						return new TestTimeoutError();
					}
				);
				const rejects =
					expect(pending).rejects.toBeInstanceOf(TestTimeoutError);

				await vi.advanceTimersByTimeAsync(1000);
				await rejects;

				if (abandoned === undefined) {
					throw new Error('expected makeError to receive a signal');
				}

				settleOperation(operation.resolve, operation.reject);

				await expect(abandoned).resolves.toBeUndefined();
			} finally {
				vi.useRealTimers();
			}
		}
	);
});
