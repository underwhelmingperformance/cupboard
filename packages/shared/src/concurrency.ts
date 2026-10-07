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
