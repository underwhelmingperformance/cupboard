/**
 * Run `worker` over `items` with at most `limit` in flight at once, preserving
 * no order. The first worker rejection stops new items from being scheduled and
 * propagates, so a failed upload aborts the batch rather than pressing on.
 */
export async function runWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	let hasFailed = false;

	const runner = async (): Promise<void> => {
		while (next < items.length && !hasFailed) {
			const item = items[next];
			next += 1;

			if (item === undefined) {
				continue;
			}

			try {
				await worker(item);
			} catch (error) {
				hasFailed = true;
				throw error;
			}
		}
	};

	const size = Math.min(Math.max(1, limit), items.length);

	await Promise.all(Array.from({ length: size }, () => runner()));
}
