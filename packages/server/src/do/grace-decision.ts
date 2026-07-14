import {
	type NixSha256HashString,
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
// `plan` records whether the client's request carried a retention plan, which
// versions the grace facts the responses and commit frames may carry.
// `graceSeconds` is the policy grace resolved at negotiation, absent when no
// policy matched; zero marks the cache grace-managed without granting a
// lasting deadline.
export const graceDecisionSchema = z.strictObject({
	plan: z.boolean(),
	graceSeconds: z.number().int().min(0).optional()
});

export type GraceDecision = z.output<typeof graceDecisionSchema>;

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

	return graceDecisionSchema.parse(JSON.parse(source));
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
	cache: string,
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
	cache: string,
	storePathHash: StorePathHash,
	generation: number,
	narHash: NixSha256HashString,
	graceSeconds: number | undefined
): ConfirmedGrace {
	// The identity re-check and the writes it authorises share one
	// transaction, so a concurrent change to the row after its check extends
	// nothing.
	const isMatched = context.db.transaction((tx) => {
		const current = tx
			.select({
				generation: schema.narInfos.generation,
				narHash: schema.narInfos.narHash
			})
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cache, cache),
					eq(schema.narInfos.storePathHash, storePathHash)
				)
			)
			.get();

		if (current?.generation !== generation || current.narHash !== narHash) {
			return false;
		}

		if (graceSeconds === undefined) {
			return true;
		}

		retention.markCacheGraceManaged(cache, tx);

		if (graceSeconds > 0) {
			retention.extendGraceDeadlines(
				cache,
				[storePathHash],
				new Date(Date.now() + graceSeconds * 1000).toISOString(),
				tx
			);
		}

		return true;
	});

	if (!isMatched) {
		return { matched: false };
	}

	if (graceSeconds === undefined || graceSeconds === 0) {
		return { matched: true, fact: {} };
	}

	return {
		matched: true,
		fact: storedGraceFact(context.db, cache, storePathHash)
	};
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
	cache: string,
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
