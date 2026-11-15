import { describe, expect, it, vi } from 'vitest';

import {
	attemptWithDeadline,
	type DeadlineTimer,
	withDeadline
} from './timeout.ts';

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

interface ArmedDeadline {
	readonly expire: () => void;
	readonly milliseconds: number;
	readonly attempt: AbortSignal;
}

function recordingTimer(): {
	readonly timer: DeadlineTimer;
	readonly armed: ArmedDeadline[];
	readonly cancellations: number[];
} {
	const armed: ArmedDeadline[] = [];
	const cancellations: number[] = [];
	const cancel = (): void => {
		cancellations.push(armed.length);
	};

	return {
		armed,
		cancellations,
		timer: (expire, milliseconds, attempt) => {
			armed.push({ expire, milliseconds, attempt });

			return cancel;
		}
	};
}

describe('attemptWithDeadline with an injected timer', () => {
	it('rejects and aborts the operation signal when the timer expires the deadline', async () => {
		const { timer, armed, cancellations } = recordingTimer();
		let received: AbortSignal | undefined;
		const pending = attemptWithDeadline(
			(signal) => {
				received = signal;

				return Promise.withResolvers<never>().promise;
			},
			1000,
			() => new TestTimeoutError(),
			undefined,
			timer
		);
		armed[0]?.expire();

		await expect(pending).rejects.toBeInstanceOf(TestTimeoutError);
		expect({
			armed: armed.map(({ milliseconds, attempt }) => ({
				milliseconds,
				isOperationSignal: attempt === received
			})),
			isAborted: received?.aborted,
			cancellations
		}).toStrictEqual({
			armed: [{ milliseconds: 1000, isOperationSignal: true }],
			isAborted: true,
			cancellations: [1]
		});
	});

	it('aborts the operation signal and rejects when the timer throws', async () => {
		const failure = new Error('the timer refused the deadline');
		let received: AbortSignal | undefined;
		const pending = attemptWithDeadline(
			(signal) => {
				received = signal;

				return Promise.withResolvers<never>().promise;
			},
			1000,
			() => new TestTimeoutError(),
			undefined,
			() => {
				throw failure;
			}
		);

		await expect(pending).rejects.toBe(failure);
		const reason: unknown = received?.reason;
		expect({
			isAborted: received?.aborted,
			reason
		}).toStrictEqual({ isAborted: true, reason: failure });
	});

	it('cancels the deadline when the operation settles first', async () => {
		const { timer, armed, cancellations } = recordingTimer();

		await attemptWithDeadline(
			() => Promise.resolve('ok'),
			1000,
			() => new TestTimeoutError(),
			undefined,
			timer
		);

		expect({ armed: armed.length, cancellations }).toStrictEqual({
			armed: 1,
			cancellations: [1]
		});
	});
});
