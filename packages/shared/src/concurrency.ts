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
	// Reject `NaN`; otherwise the function would start no workers and return no
	// results.
	if (Number.isNaN(concurrency)) {
		throw new RangeError('concurrency must be a number');
	}

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

	const workerCount = Math.min(Math.max(concurrency, 1), values.length);

	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	if (firstFailure !== undefined) {
		throw firstFailure.error;
	}

	return results;
}
