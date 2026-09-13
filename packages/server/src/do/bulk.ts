import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { inArray } from 'drizzle-orm';
import { type BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import {
	EmptyStatementBatchError,
	StatementParameterLimitError
} from '../errors.ts';
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

import { jsonValueLists } from './json-list.ts';
import { hasSubrequestsFor } from './subrequest-slice.ts';

export { chunk } from '@cupboard/shared/collections';

// Cloudflare's D1 and Durable Object SQLite accept at most 100 bound
// parameters in one statement. Both bindings refuse a statement above that
// before the runtime receives it (`admitBoundParameters`), and
// `statement-admission.workers.test.ts` checks that the local runtime
// refuses one as well, so the limit the code enforces and the one the
// toolchain enforces cannot drift apart unnoticed.
export const maxBoundParameters = 100;

// Cloudflare allows a Durable Object six simultaneous outgoing connections per
// request. The commit-batch fan-out runs this many tasks concurrently; after
// the batch-level prefetch each task holds at most one live connection at a time
// (its per-path R2 head), so the pool stays within the platform cap.
export const maxOutgoingConnections = 6;

// R2 deletes up to 1000 keys in a single `delete` call; a larger set is split.
export const maxR2DeleteKeys = 1000;

/**
 * Deletes the keys in batches that satisfy R2's per-call limit. Returns without
 * an R2 request when `keys` is empty.
 */
export async function deleteObjects(
	bucket: R2Bucket,
	keys: readonly R2ObjectKey[]
): Promise<void> {
	for (const batch of chunk(keys, maxR2DeleteKeys)) {
		await bucket.delete(batch);
	}
}

export type InspectableBatchItem = BatchItem<'sqlite'> & {
	toSQL: () => { readonly params: readonly unknown[] };
};

interface FittedBatch {
	readonly width: number;
	readonly statements: readonly InspectableBatchItem[];
}

/**
 * Builds a batch for the widest prefix of `items` whose statements each bind at
 * most `maxBoundParameters` parameters.
 *
 * The loop tries each width from all `items` down to one item. It builds and
 * measures one in-memory batch per width, then returns the first batch that
 * fits. The width decreases one step at a time because a builder's statement
 * count need not decrease with the item count. A larger step could skip the
 * only width that fits.
 */
function fittedBatch(
	items: readonly unknown[],
	batchFor: (width: number) => readonly InspectableBatchItem[]
): FittedBatch {
	let width = items.length;

	for (;;) {
		const statements = batchFor(width);

		if (statements.length === 0) {
			throw new EmptyStatementBatchError(width);
		}

		const parameters = Math.max(
			...statements.map((statement) => statement.toSQL().params.length)
		);
		if (parameters <= maxBoundParameters) {
			return { width, statements };
		}

		if (width === 1) {
			if (parameters > maxBoundParameters) {
				throw new StatementParameterLimitError(parameters, maxBoundParameters);
			}

			throw new StatementParameterLimitError(parameters, maxBoundParameters);
		}

		width -= 1;
	}
}

/**
 * Runs the batch produced by `buildBatch` for each chunk of `items`. Returns the
 * processed prefix, allowing the caller to defer the remaining suffix.
 *
 * Each chunk is narrowed until its statements fit the parameter limit. The
 * function dispatches only complete batches and defers when the current
 * subrequest slice cannot fit another D1 call.
 */
export async function drainStatementBatches<
	Item,
	TSchema extends Record<string, unknown>
>(
	database: DrizzleD1Database<TSchema>,
	items: readonly Item[],
	buildBatch: (chunk: readonly Item[]) => readonly InspectableBatchItem[]
): Promise<readonly Item[]> {
	let processed = 0;

	while (processed < items.length) {
		if (!hasSubrequestsFor(1)) {
			break;
		}

		const rest = items.slice(processed);
		const fitted = fittedBatch(rest, (width) =>
			buildBatch(rest.slice(0, width))
		);

		await batchNonEmpty(database, fitted.statements);
		processed += fitted.width;
	}

	return items.slice(0, processed);
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
 * Returns the NAR hashes with a canonical `nar/<narHash>.nar.zst` object. The
 * function bounds the concurrent `head` requests. A crash can leave a
 * `blob_state` row after its object disappears, so servability checks R2.
 */
export async function presentNarObjects(
	blobs: R2Bucket,
	objects: readonly (
		| NixSha256HashString
		| { readonly narHash: NixSha256HashString; readonly incarnation: number }
	)[]
): Promise<ReadonlySet<NixSha256HashString>> {
	const unique = new Map(
		objects.map((object) => {
			const row =
				typeof object === 'string'
					? { narHash: object, incarnation: 1 }
					: object;

			return [row.narHash, row] as const;
		})
	)
		.values()
		.toArray();
	const present = await mapWithConcurrency(
		unique,
		maxOutgoingConnections,
		async (object) =>
			(await blobs.head(narObjectKey(object.narHash, object.incarnation))) ===
			null
				? undefined
				: object.narHash
	);

	return new Set(
		present.filter(
			(narHash): narHash is NixSha256HashString => narHash !== undefined
		)
	);
}

export async function recordedNarObjects(
	database: DrizzleD1Database<typeof d1Schema>,
	narHashes: readonly NixSha256HashString[]
): Promise<
	readonly {
		readonly narHash: NixSha256HashString;
		readonly incarnation: number;
	}[]
> {
	const queries = jsonValueLists([...new Set(narHashes)]).map((list) =>
		database
			.select({
				narHash: d1Schema.blobState.narHash,
				incarnation: d1Schema.blobState.incarnation
			})
			.from(d1Schema.blobState)
			.where(inArray(d1Schema.blobState.narHash, list))
	);

	const pages = await batchNonEmpty(database, queries);

	return pages.flat();
}
