import { positiveSafeInteger } from './limits.ts';

/**
 * Calls `map` for each value with no more than `concurrency` calls in progress.
 * The returned results preserve input order.
 *
 * Workers share one iterator and claim another value when their previous call
 * finishes. This limits simultaneous I/O without making the calls serial. After
 * one call rejects, no new calls start. Calls already in progress finish, and
 * the returned promise rejects with the first error.
 */
export async function mapWithConcurrency<T, Result>(
	values: readonly T[],
	concurrency: number,
	map: (value: T, index: number) => Promise<Result>
): Promise<Result[]> {
	const limit = positiveSafeInteger(concurrency, 'concurrency');

	const results: Result[] = [];
	const iterator = values.entries();
	let firstFailure: { readonly error: unknown } | undefined;

	const worker = async (): Promise<void> => {
		for (;;) {
			if (firstFailure !== undefined) {
				return;
			}

			const next = iterator.next();

			if (next.done) {
				return;
			}

			const [index, value] = next.value;

			try {
				results[index] = await map(value, index);
			} catch (error) {
				firstFailure ??= { error };
				return;
			}
		}
	};

	const workerCount = Math.min(limit, values.length);

	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (firstFailure !== undefined) {
		throw firstFailure.error;
	}

	return results;
}

/**
 * Pulls values from `source` and calls `run` for each, with no more than
 * `concurrency` calls in progress.
 *
 * A worker asks the source for its next value only after its previous call
 * finishes, so a lazy source such as an async generator produces each value
 * when a worker is ready for it. An async generator handles concurrent `next`
 * calls one at a time. After a call or the source rejects, workers stop asking
 * for values. `run` is still called for a value that a worker has already
 * received. Calls in progress finish, an unfinished source is closed with
 * `return`, and the returned promise rejects with the first error.
 */
export async function drainWithConcurrency<T>(
	source: AsyncIterator<T>,
	concurrency: number,
	run: (value: T) => Promise<void>
): Promise<void> {
	const limit = positiveSafeInteger(concurrency, 'concurrency');

	let firstFailure: { readonly error: unknown } | undefined;

	const worker = async (): Promise<'exhausted' | 'stopped'> => {
		while (firstFailure === undefined) {
			let next: IteratorResult<T>;

			try {
				next = await source.next();
			} catch (error) {
				firstFailure ??= { error };
				return 'stopped';
			}

			if (next.done === true) {
				return 'exhausted';
			}

			try {
				await run(next.value);
			} catch (error) {
				firstFailure ??= { error };
				return 'stopped';
			}
		}

		return 'stopped';
	};

	const endings = await Promise.all(
		Array.from({ length: limit }, () => worker())
	);

	if (!endings.includes('exhausted')) {
		await source.return?.();
	}

	if (firstFailure !== undefined) {
		throw firstFailure.error;
	}
}

/**
 * Admits at most `limit` holders at once. `acquire` resolves when a slot is
 * free, and each holder must call `release` once. Waiters are admitted in the
 * order in which they called `acquire`.
 */
export class CountingSemaphore {
	private slots: number;
	private readonly waiters: ((value: undefined) => void)[] = [];

	constructor(limit: number) {
		this.slots = limit;
	}

	private async runInSlot<T>(task: () => Promise<T>): Promise<T> {
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private async runWhenAdmitted<T>(task: () => Promise<T>): Promise<T> {
		await this.acquire();

		return this.runInSlot(task);
	}

	acquire(): Promise<undefined> {
		if (this.slots > 0) {
			this.slots -= 1;
			return Promise.resolve(undefined);
		}

		const { promise, resolve } = Promise.withResolvers<undefined>();
		this.waiters.push(resolve);
		return promise;
	}

	release(): void {
		const next = this.waiters.shift();

		if (next === undefined) {
			this.slots += 1;
			return;
		}

		next(undefined);
	}

	/**
	 * Runs `task` in a slot and releases the slot when the task's promise
	 * resolves or rejects. When a slot is free, `task` starts before `run` returns;
	 * otherwise it starts once a slot is released to it.
	 */
	run<T>(task: () => Promise<T>): Promise<T> {
		if (this.slots > 0) {
			this.slots -= 1;

			return this.runInSlot(task);
		}

		return this.runWhenAdmitted(task);
	}
}
