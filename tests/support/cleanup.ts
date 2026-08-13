export type AsyncCleanup = () => Promise<void>;

async function runCleanup(cleanup: AsyncCleanup): Promise<void> {
	return cleanup();
}

/** Gives one asynchronous cleanup a stable result across repeated calls. */
export function onceAsync(cleanup: AsyncCleanup): AsyncCleanup {
	let outcome: Promise<void> | undefined;

	return () => {
		outcome ??= runCleanup(cleanup);

		return outcome;
	};
}

/** Runs every cleanup and surfaces one failure directly or all failures together. */
export async function settleCleanups(
	cleanups: readonly AsyncCleanup[],
	message: string
): Promise<void> {
	const outcomes = await Promise.allSettled(
		cleanups.map(async (cleanup) => cleanup())
	);
	const failures: unknown[] = [];

	for (const outcome of outcomes) {
		if (outcome.status !== 'rejected') {
			continue;
		}

		const reason: unknown = outcome.reason;
		failures.push(reason);
	}

	if (failures.length === 0) {
		return;
	}

	if (failures.length === 1) {
		throw failures[0];
	}

	throw new AggregateError(failures, message);
}
