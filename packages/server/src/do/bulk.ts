import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { type BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

export { chunk } from '@cupboard/shared/collections';

// Cloudflare's D1 and Durable Object SQLite runtimes admit at most 100 bound
// parameters per query, so an `IN (...)` list is chunked below that with
// headroom for the fixed parameters a query also binds (a tenant, a cache).
export const maxInClauseValues = 90;

// Cloudflare allows a Durable Object six simultaneous outgoing connections per
// request. The commit-batch fan-out runs this many tasks concurrently; after
// the batch-level prefetch each task holds at most one live connection at a time
// (its per-path R2 head), so the pool stays within the platform cap.
export const maxOutgoingConnections = 6;

// R2 deletes up to 1000 keys in a single `delete` call; a larger set is split.
export const maxR2DeleteKeys = 1000;

/**
 * Deletes `keys` from `bucket` in as few `delete` calls as R2's per-call key
 * limit allows (batching calls to minimise round trips). An empty set issues no call.
 */
export async function deleteObjects(
	bucket: R2Bucket,
	keys: readonly R2ObjectKey[]
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
 * The NAR hashes among `narHashes` whose canonical `nar/<narHash>.nar.zst`
 * object is present, found with a bounded fan-out of concurrent `head` reads.
 * A crash can leave `blob_state` recording a NAR whose object is gone, so a
 * servability decision probes the object itself.
 */
export async function presentNarObjects(
	blobs: R2Bucket,
	narHashes: readonly NixSha256HashString[]
): Promise<ReadonlySet<NixSha256HashString>> {
	const unique = [...new Set(narHashes)];
	const present = await mapWithConcurrency(
		unique,
		maxOutgoingConnections,
		async (narHash) =>
			(await blobs.head(narObjectKey(narHash))) === null ? undefined : narHash
	);

	return new Set(
		present.filter(
			(narHash): narHash is NixSha256HashString => narHash !== undefined
		)
	);
}
