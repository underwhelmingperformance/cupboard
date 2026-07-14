import { describe, expect, it, vi } from 'vitest';

import { SubrequestTimeoutError } from '../errors.ts';

import { ObjectWriteOrder } from './object-write-order.ts';

// The settled-signal shape the timeout error carries: resolves once the
// resolver-backed promise settles.
async function settled(pending: Promise<unknown>): Promise<void> {
	await pending;
}

// A write whose mutation timed out, carrying the abandoned call's
// settled-signal, as boundedSubrequest raises it.
async function abandonedWrite(
	order: ObjectWriteOrder,
	keys: readonly string[],
	signal: Promise<void>
): Promise<void> {
	let error: unknown;

	try {
		await order.write(keys, () =>
			Promise.reject(new SubrequestTimeoutError('r2.delete', signal))
		);
	} catch (error_) {
		error = error_;
	}

	expect(error).toBeInstanceOf(SubrequestTimeoutError);
}

// Flushes the microtask queue far enough for a write that is not blocked on an
// outstanding signal to have issued its mutation.
async function flushMicrotasks(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

describe('ObjectWriteOrder', () => {
	it('runs a mutation with no outstanding signal immediately', async () => {
		const order = new ObjectWriteOrder();

		const result = await order.write(['key'], () => Promise.resolve('ok'));

		expect(result).toBe('ok');
	});

	it('orders a later mutation behind an abandoned one on the same key', async () => {
		vi.useFakeTimers();

		try {
			const order = new ObjectWriteOrder();
			const zombie = Promise.withResolvers<string>();

			await abandonedWrite(order, ['key'], settled(zombie.promise));

			const events: string[] = [];
			const blocked = order.write(['key'], () => {
				events.push('issued');

				return Promise.resolve();
			});

			await flushMicrotasks();
			expect(events).toStrictEqual([]);

			zombie.resolve('landed');
			await blocked;

			expect(events).toStrictEqual(['issued']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('leaves mutations of other keys unblocked', async () => {
		vi.useFakeTimers();

		try {
			const order = new ObjectWriteOrder();
			const zombie = Promise.withResolvers<string>();

			await abandonedWrite(order, ['key'], settled(zombie.promise));

			const result = await order.write(['other'], () => Promise.resolve('ok'));

			expect(result).toBe('ok');

			zombie.resolve('landed');
		} finally {
			vi.useRealTimers();
		}
	});

	it('bounds the wait, rejecting retryably and keeping the signal for the retry', async () => {
		vi.useFakeTimers();

		try {
			const order = new ObjectWriteOrder();
			const zombie = Promise.withResolvers<string>();

			await abandonedWrite(order, ['key'], settled(zombie.promise));

			const events: string[] = [];
			const blocked = order.write(['key'], () => {
				events.push('issued');

				return Promise.resolve();
			});
			const rejects = expect(blocked).rejects.toBeInstanceOf(
				SubrequestTimeoutError
			);

			await vi.advanceTimersByTimeAsync(15_000);
			await rejects;
			expect(events).toStrictEqual([]);

			// The signal stayed registered: the retry still orders behind the
			// zombie, and proceeds once it settles.
			const retried = order.write(['key'], () => {
				events.push('retried');

				return Promise.resolve();
			});

			await flushMicrotasks();
			expect(events).toStrictEqual([]);

			zombie.resolve('landed');
			await retried;

			expect(events).toStrictEqual(['retried']);
		} finally {
			vi.useRealTimers();
		}
	});

	it('registers a bulk mutation against every key it covered', async () => {
		vi.useFakeTimers();

		try {
			const order = new ObjectWriteOrder();
			const zombie = Promise.withResolvers<string>();

			await abandonedWrite(order, ['first', 'second'], settled(zombie.promise));

			const events: string[] = [];
			const blocked = order.write(['second'], () => {
				events.push('issued');

				return Promise.resolve();
			});

			await flushMicrotasks();
			expect(events).toStrictEqual([]);

			zombie.resolve('landed');
			await blocked;

			expect(events).toStrictEqual(['issued']);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		{
			failure: 'a non-timeout fault',
			error: () => new Error('r2 refused')
		},
		{
			failure: 'a timeout whose call never started',
			error: () => new SubrequestTimeoutError('r2.delete')
		}
	])('registers nothing after $failure', async ({ error }) => {
		vi.useFakeTimers();

		try {
			const order = new ObjectWriteOrder();

			let caught: unknown;

			try {
				await order.write(['key'], () => Promise.reject(error()));
			} catch (error_) {
				caught = error_;
			}

			expect(caught).toBeInstanceOf(Error);

			const result = await order.write(['key'], () => Promise.resolve('ok'));

			expect(result).toBe('ok');
		} finally {
			vi.useRealTimers();
		}
	});
});
