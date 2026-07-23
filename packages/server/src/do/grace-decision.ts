import {
	type GraceSeconds,
	graceSecondsSchema,
	type NarInfoGeneration,
	type NixSha256HashString,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type ParsedUploadGraceFact } from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import * as schema from '../db/schema.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type RetentionService } from './retention-service.ts';

// The retention grace decision a negotiation captures on its pending upload.
// `reportsGrace` records whether the negotiation accepted the grace-facts
// capability, which versions the responses and commit frames it may carry.
// `graceSeconds` is the policy grace resolved at negotiation, absent when no
// policy matched; zero marks the cache grace-managed without granting a
// lasting deadline.
export const graceDecisionSchema = z.strictObject({
	reportsGrace: z.boolean(),
	graceSeconds: graceSecondsSchema.optional()
});

export type GraceDecision = z.output<typeof graceDecisionSchema>;

// A rolling deployment can leave either representation in an in-flight
// pending row. New writes use `reportsGrace`; reads normalise both shapes.
const storedGraceDecisionSchema = z.union([
	graceDecisionSchema,
	z
		.strictObject({
			plan: z.boolean(),
			graceSeconds: graceSecondsSchema.optional()
		})
		.transform(({ plan, graceSeconds }) => ({
			reportsGrace: plan,
			...(graceSeconds !== undefined && { graceSeconds })
		}))
]);

export function serialiseGraceDecision(decision: GraceDecision): string {
	return JSON.stringify(graceDecisionSchema.parse(decision));
}

/**
 * Reads a stored grace decision back off a pending-upload row. An unset column
 * is a row negotiated before the decision existed and carries no policy fact,
 * so it parses to `undefined` and materialises as though no policy matched.
 */
export function parseStoredGraceDecision(
	source: string | null | undefined
): GraceDecision | undefined {
	if (source === null || source === undefined) {
		return undefined;
	}

	return storedGraceDecisionSchema.parse(JSON.parse(source));
}

// The captured policy fact a still-deferred upload reports: its deadline is
// unknown until it materialises, so the fact carries the captured grace.
export function capturedGraceFact(
	decision: GraceDecision | undefined
): ParsedUploadGraceFact {
	return decision?.graceSeconds === undefined
		? {}
		: { graceSeconds: decision.graceSeconds };
}

// The path's stored grace deadline as a wire fact, for an answer that settles
// without materialising anything itself: an already-present decision, a
// concurrent winner's commit, or a replayed servable verdict.
export function storedGraceFact(
	database: ServerContext['db'],
	cache: StoredCache,
	storePathHash: StorePathHash
): ParsedUploadGraceFact {
	const row = database
		.select({ retainUntil: schema.retentionGrace.retainUntil })
		.from(schema.retentionGrace)
		.where(
			and(
				eq(schema.retentionGrace.cache, cache),
				eq(schema.retentionGrace.storePathHash, storePathHash)
			)
		)
		.get();

	return row === undefined ? {} : { retainUntil: row.retainUntil };
}

/**
 * The result of confirming a grace decision against the row now committed
 * for a store-path hash. `matched` reports whether the row still carried the
 * expected generation and NAR hash when the decision was applied; only a
 * matched confirmation has anything applied or a fact to report.
 */
export type ConfirmedGrace =
	| { readonly matched: true; readonly fact: ParsedUploadGraceFact }
	| { readonly matched: false };

/**
 * Applies a grace decision to the row now actually committed for a
 * store-path hash, whether this call's own materialisation produced it or it
 * conceded to a concurrent winner. A concede that skips this and merely
 * reports success leaves a positive policy ungranted whenever no other event
 * has established a deadline. The identity re-check always runs, whatever
 * the decision says; `graceSeconds` only gates the writes, so a caller can
 * always tell a row that moved from one that simply carried no policy. A
 * matched confirmation reports the resulting stored fact.
 */
export function confirmGrace(
	context: ServerContext,
	retention: RetentionService,
	cache: StoredCache,
	storePathHash: StorePathHash,
	generation: NarInfoGeneration,
	narHash: NixSha256HashString,
	graceSeconds: GraceSeconds | undefined
): ConfirmedGrace {
	const facts = confirmGraceBatch(
		context,
		retention,
		cache,
		[{ storePathHash, generation, narHash }],
		graceSeconds
	);
	const fact = facts.get(storePathHash);

	return fact === undefined ? { matched: false } : { matched: true, fact };
}

/**
 * The batched form of {@link confirmGrace}: one identity re-check and one
 * monotonic extension per chunk of rows, so confirming a whole closure costs
 * a bounded number of statements rather than one transaction per path.
 * Returns the stored fact for each store-path hash whose row still matched
 * its expected identity; a mismatched or vanished row is absent from the map
 * and has nothing applied.
 */
export function confirmGraceBatch(
	context: ServerContext,
	retention: RetentionService,
	cache: StoredCache,
	entries: readonly {
		readonly storePathHash: StorePathHash;
		readonly generation: NarInfoGeneration;
		readonly narHash: NixSha256HashString;
	}[],
	graceSeconds: GraceSeconds | undefined
): Map<StorePathHash, ParsedUploadGraceFact> {
	// One deadline for the whole batch, computed up front so every matched row
	// reports the same extension.
	const retainUntil =
		graceSeconds === undefined || graceSeconds === 0
			? undefined
			: new Date(Date.now() + graceSeconds * 1000).toISOString();
	const matched: StorePathHash[] = [];

	// The identity re-check and the writes it authorises share one transaction
	// per chunk, so a concurrent change to a row after its check extends
	// nothing. The chunk bound covers the re-check's IN-list; the extension
	// chunks its own inserts.
	for (const batch of chunk(entries, maxInClauseValues)) {
		const batchHashes = batch.map((entry) => entry.storePathHash);

		context.db.transaction((tx) => {
			const rows = tx
				.select({
					storePathHash: schema.narInfos.storePathHash,
					generation: schema.narInfos.generation,
					narHash: schema.narInfos.narHash
				})
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cache, cache),
						inArray(schema.narInfos.storePathHash, batchHashes)
					)
				)
				.all();
			const byHash = new Map(rows.map((row) => [row.storePathHash, row]));
			const chunkMatched = batch
				.filter((entry) => {
					const current = byHash.get(entry.storePathHash);

					return (
						current?.generation === entry.generation &&
						current.narHash === entry.narHash
					);
				})
				.map((entry) => entry.storePathHash);

			matched.push(...chunkMatched);

			if (graceSeconds === undefined || chunkMatched.length === 0) {
				return;
			}

			retention.markCacheGraceManaged(cache, tx);

			if (retainUntil !== undefined) {
				retention.extendGraceDeadlines(cache, chunkMatched, retainUntil, tx);
			}
		});
	}

	if (retainUntil === undefined) {
		// A matched zero-grace policy is reported as such: an empty fact
		// strictly means no policy matched.
		const fact: ParsedUploadGraceFact =
			graceSeconds === undefined ? {} : { graceSeconds };

		return new Map(matched.map((storePathHash) => [storePathHash, fact]));
	}

	const deadlines = storedGraceDeadlines(context.db, cache, matched);

	return new Map(
		matched.map((storePathHash) => {
			const stored = deadlines.get(storePathHash);

			return [
				storePathHash,
				stored === undefined ? {} : { retainUntil: stored }
			];
		})
	);
}

/**
 * The stored grace deadline for each of the given paths in one cache, read
 * back after an extension's monotonic max upsert. Storage may already hold a
 * later deadline than the one just extended to (an earlier longer policy, or
 * a root transition), so this is the fact a reply or frame must report,
 * never the candidate the caller just computed. A path the extension did not
 * touch, or that was never granted a deadline, is absent from the map.
 */
export function storedGraceDeadlines(
	database: ServerContext['db'],
	cache: StoredCache,
	storePathHashes: readonly StorePathHash[]
): Map<StorePathHash, string> {
	const deadlines = new Map<StorePathHash, string>();

	for (const batch of chunk(storePathHashes, maxInClauseValues)) {
		const rows = database
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cache, cache),
					inArray(schema.retentionGrace.storePathHash, batch)
				)
			)
			.all();

		for (const row of rows) {
			deadlines.set(row.storePathHash, row.retainUntil);
		}
	}

	return deadlines;
}
