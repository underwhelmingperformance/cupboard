import { chunk } from '@cupboard/shared/collections';
import { type BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

export { chunk } from '@cupboard/shared/collections';

// D1 admits at most 100 bound parameters per query, so an `IN (...)` list is
// chunked below that with headroom for the fixed parameters a query also binds
// (a tenant, a cache). The DO's own SQLite tolerates far more, but the same
// modest chunk keeps every batched read uniform.
export const maxInClauseValues = 90;

// Cloudflare allows a Durable Object six simultaneous outgoing connections per
// request. A fan-out of R2 reads (each `head` is one connection) is bounded here
// so it runs concurrently without overrunning the platform cap.
export const maxOutgoingConnections = 6;

// R2 deletes up to 1000 keys in a single `delete` call; a larger set is split.
export const maxR2DeleteKeys = 1000;

/**
 * Deletes `keys` from `bucket` in as few `delete` calls as R2's per-call key
 * limit allows (batching calls to minimise round trips). An empty set issues no call.
 */
export async function deleteObjects(
	bucket: R2Bucket,
	keys: readonly string[]
): Promise<void> {
	for (const batch of chunk(keys, maxR2DeleteKeys)) {
		await bucket.delete(batch);
	}
}

/**
 * Runs `queries` as a single D1 batch, returning an empty array without any D1
 * call when the input is empty.
 */
export async function batchNonEmpty<
	U extends BatchItem<'sqlite'>,
	TSchema extends Record<string, unknown>
>(
	database: DrizzleD1Database<TSchema>,
	queries: readonly U[]
): Promise<U['_']['result'][]> {
	const [first, ...rest] = queries;

	if (first === undefined) {
		return [];
	}

	return database.batch([first, ...rest]);
}

/**
 * Maps `items` through `task` with at most `limit` running at once, preserving
 * input order in the result. Workers share one iterator, so each pulls the next
 * item as it frees up; a bounded pool keeps a fan-out of I/O within the
 * platform's simultaneous-connection cap without issuing requests serially.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const results: R[] = [];
	const entries = items.map((item, index): readonly [T, number] => [
		item,
		index
	]);
	const iterator = entries[Symbol.iterator]();

	const runWorker = async (): Promise<void> => {
		for (const [item, index] of iterator) {
			results[index] = await task(item, index);
		}
	};

	const workerCount = Math.min(Math.max(limit, 1), items.length);
	await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

	return results;
}
