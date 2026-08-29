import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { inArray } from 'drizzle-orm';
import { type BatchItem } from 'drizzle-orm/batch';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import * as d1Schema from '../db/d1-schema.ts';
import {
	BatchStatementLimitError,
	EmptyStatementBatchError,
	StatementParameterLimitError
} from '../errors.ts';
import {
	d1StatementsPerInvocation,
	narObjectKey,
	type R2ObjectKey
} from '../http/http.ts';

import { statementsRemaining } from './statement-scope.ts';

export { chunk } from '@cupboard/shared/collections';

// Cloudflare's D1 and Durable Object SQLite runtimes accept at most 100 bound
// parameters in one query.
//
// Local workerd and test-pool runs use a SQLite build that accepts 32,766
// parameters, so executing a statement there does not reproduce an overrun.
// `d1-parameter-guard.test.ts` inspects the generated parameter lists instead.
export const maxBoundParameters = 100;

// An `IN (...)` list is chunked below the budget, leaving headroom for the fixed
// parameters that a query also binds, such as a tenant or cache. If a statement
// binds the list more than once, its caller must use a narrower chunk.
export const maxInClauseValues = 90;

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

/**
 * A pending statement that exposes its bound parameters before execution. The
 * caller uses the parameter count to find a safe chunk size.
 */
export interface InspectableStatement<Result> {
	toSQL: () => { readonly params: readonly unknown[] };
	execute: () => Promise<Result>;
}

export type InspectableBatchItem = BatchItem<'sqlite'> & {
	toSQL: () => { readonly params: readonly unknown[] };
};

// Finds the widest chunk that satisfies `maxBoundParameters` by building and
// measuring the statement. A statement can bind fixed parameters and can bind
// its list more than once, so the helper narrows the estimate until the measured
// statement fits.
function fittedChunkWidth(
	items: readonly unknown[],
	parametersFor: (width: number) => number
): number {
	let width = items.length;

	for (;;) {
		const parameters = parametersFor(width);

		if (parameters <= maxBoundParameters) {
			return width;
		}

		if (width === 1) {
			throw new StatementParameterLimitError(parameters, maxBoundParameters);
		}

		width = Math.max(
			1,
			Math.min(width - 1, Math.floor((width * maxBoundParameters) / parameters))
		);
	}
}

/**
 * Runs one statement for each chunk of `items`. Returns the processed prefix
 * and the result of each statement. The caller can defer the unprocessed suffix.
 *
 * Each chunk is as wide as the measured parameter limit allows. Before building
 * another chunk, the function checks that at least one D1 statement remains.
 */
export async function executeChunkedStatement<Item, Result>(
	items: readonly Item[],
	buildStatement: (chunk: readonly Item[]) => InspectableStatement<Result>
): Promise<{
	readonly processed: readonly Item[];
	readonly results: readonly Result[];
}> {
	const results: Result[] = [];
	let processed = 0;

	while (processed < items.length) {
		if (statementsRemaining() < 1) {
			break;
		}

		const rest = items.slice(processed);
		const width = fittedChunkWidth(
			rest,
			(candidate) =>
				buildStatement(rest.slice(0, candidate)).toSQL().params.length
		);
		results.push(await buildStatement(rest.slice(0, width)).execute());
		processed += width;
	}

	return { processed: items.slice(0, processed), results };
}

interface FittedBatch {
	readonly width: number;
	readonly statements: readonly InspectableBatchItem[];
}

/**
 * Builds a batch for the widest prefix of `items` that satisfies both limits.
 * Each statement must bind at most `maxBoundParameters` parameters. The batch
 * must also contain no more statements than the invocation's remaining D1
 * allowance. The function measures every statement and counts all batch
 * members.
 *
 * Returns `undefined` when the batch for a single item exceeds the remaining
 * allowance but fits within a fresh invocation. The caller defers the item to
 * that invocation.
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
): FittedBatch | undefined {
	let width = items.length;

	for (;;) {
		const statements = batchFor(width);

		if (statements.length === 0) {
			throw new EmptyStatementBatchError(width);
		}

		const parameters = Math.max(
			...statements.map((statement) => statement.toSQL().params.length)
		);
		const affordable = statementsRemaining();

		if (parameters <= maxBoundParameters && statements.length <= affordable) {
			return { width, statements };
		}

		if (width === 1) {
			if (parameters > maxBoundParameters) {
				throw new StatementParameterLimitError(parameters, maxBoundParameters);
			}

			if (statements.length > d1StatementsPerInvocation) {
				throw new BatchStatementLimitError(
					statements.length,
					d1StatementsPerInvocation
				);
			}

			return undefined;
		}

		width -= 1;
	}
}

/**
 * Runs the batch produced by `buildBatch` for each chunk of `items`. Returns the
 * processed prefix, allowing the caller to defer the remaining suffix.
 *
 * Each chunk is narrowed until its batch fits the platform's parameter limit
 * and the invocation's D1 allowance. The function dispatches only complete
 * batches.
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
		const rest = items.slice(processed);
		const fitted = fittedBatch(rest, (width) =>
			buildBatch(rest.slice(0, width))
		);

		if (fitted === undefined) {
			break;
		}

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
	const queries = chunk([...new Set(narHashes)], maxInClauseValues).map(
		(batch) =>
			database
				.select({
					narHash: d1Schema.blobState.narHash,
					incarnation: d1Schema.blobState.incarnation
				})
				.from(d1Schema.blobState)
				.where(inArray(d1Schema.blobState.narHash, batch))
	);

	const pages = await batchNonEmpty(database, queries);

	return pages.flat();
}
