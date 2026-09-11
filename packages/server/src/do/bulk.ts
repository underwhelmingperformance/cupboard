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
import { narObjectKey, type R2ObjectKey } from '../http/http.ts';

import { jsonValueLists } from './json-list.ts';
import { statementsRemaining } from './statement-scope.ts';

export { chunk } from '@cupboard/shared/collections';

// Cloudflare's D1 and Durable Object SQLite runtimes accept at most 100 bound
// parameters in one query. Both bindings refuse a statement above that limit
// before the runtime receives it; see `admitBoundParameters` in
// `statement-admission.ts`.
//
// The local runtime enforces 100 as well: under wrangler 4.123.0 and
// @cloudflare/vitest-pool-workers 0.21.3, D1 and Durable Object SQLite both
// answer a 101-parameter statement with `too many SQL variables`. SQLite's own
// default is 32,766, so which limit a build enforces depends on how it was
// configured and the local agreement with production can drift either way.
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
 * Builds a batch for the widest prefix of `items` that satisfies both limits.
 * Each statement must bind at most `maxBoundParameters` parameters. The batch
 * must also contain no more statements than the invocation's remaining D1
 * allowance. The function measures every statement and counts all batch
 * members.
 *
 * Returns `undefined` when the batch for a single item exceeds the remaining
 * allowance but fits within a fresh invocation of `statementAllowance`
 * statements. The caller defers the item to that invocation.
 *
 * The loop tries each width from all `items` down to one item. It builds and
 * measures one in-memory batch per width, then returns the first batch that
 * fits. The width decreases one step at a time because a builder's statement
 * count need not decrease with the item count. A larger step could skip the
 * only width that fits.
 */
function fittedBatch(
	items: readonly unknown[],
	statementAllowance: number,
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

			if (statements.length > statementAllowance) {
				throw new BatchStatementLimitError(
					statements.length,
					statementAllowance
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
 *
 * `statementAllowance` is what a fresh invocation of this deployment may run.
 * An item whose narrowest batch exceeds it could never be dispatched, so the
 * function refuses that item instead of deferring it for ever.
 */
export async function drainStatementBatches<
	Item,
	TSchema extends Record<string, unknown>
>(
	database: DrizzleD1Database<TSchema>,
	items: readonly Item[],
	statementAllowance: number,
	buildBatch: (chunk: readonly Item[]) => readonly InspectableBatchItem[]
): Promise<readonly Item[]> {
	let processed = 0;

	while (processed < items.length) {
		const rest = items.slice(processed);
		const fitted = fittedBatch(rest, statementAllowance, (width) =>
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
