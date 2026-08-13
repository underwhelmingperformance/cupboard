/**
 * Maps `values` through `map` with at most `concurrency` calls in flight at
 * once, preserving input order in the returned results. Workers share one
 * iterator, so each pulls the next value as it frees up; a bounded pool keeps
 * a fan-out of I/O within a platform's simultaneous-connection cap without
 * issuing requests serially. Once any call rejects, no further values are
 * started; calls already in flight still run to completion, and the returned
 * promise rejects with the first error.
 */
export async function mapWithConcurrency<T, Result>(
	values: readonly T[],
	concurrency: number,
	map: (value: T, index: number) => Promise<Result>
): Promise<Result[]> {
	// `NaN` would spawn zero workers and silently drop every value, so it is
	// refused loudly as the programmer error it is.
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
