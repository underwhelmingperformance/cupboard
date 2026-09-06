import {
	type GraceSeconds,
	graceSecondsSchema,
	type NarInfoGeneration,
	type NixSha256HashString,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { type UploadGraceFact } from '@cupboard/protocol/upload';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type ServerContext } from './context.ts';
import { type RetentionService } from './retention-service.ts';

// Each pending upload stores the cache grace resolved during negotiation.
// `reportsGrace` records whether the client accepted grace facts. An absent
// `graceSeconds` means the cache had no configured grace; zero marks the cache as grace-managed
// without granting a lasting deadline.
export const graceDecisionSchema = z.strictObject({
	reportsGrace: z.boolean(),
	graceSeconds: graceSecondsSchema.optional()
});

export type GraceDecision = z.output<typeof graceDecisionSchema>;

// Rolling deployments can leave either representation in an in-flight row.
// New writes use `reportsGrace`, but reads must accept the legacy `plan` field.
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
 * Parses the grace decision stored on a pending upload. An unset column comes
 * from a negotiation before grace decisions existed and grants no grace.
 */
export function parseStoredGraceDecision(
	source: string | null | undefined
): GraceDecision | undefined {
	if (source === null || source === undefined) {
		return undefined;
	}

	return storedGraceDecisionSchema.parse(JSON.parse(source));
}

// A deferred upload has no materialised deadline, so it reports the grace
// duration captured during negotiation.
export function capturedGraceFact(
	decision: GraceDecision | undefined
): UploadGraceFact {
	return decision?.graceSeconds === undefined
		? {}
		: { graceSeconds: decision.graceSeconds };
}

export function storedGraceFact(
	database: ServerContext['db'],
	cache: ResolvedCache,
	storePathHash: StorePathHash
): UploadGraceFact {
	const row = database
		.select({ retainUntil: schema.retentionGrace.retainUntil })
		.from(schema.retentionGrace)
		.where(
			and(
				eq(schema.retentionGrace.cacheId, cache.id),
				eq(schema.retentionGrace.storePathHash, storePathHash)
			)
		)
		.get();

	return row === undefined ? {} : { retainUntil: row.retainUntil };
}

export type ConfirmedGrace =
	| { readonly matched: true; readonly fact: UploadGraceFact }
	| { readonly matched: false };

/**
 * Applies a captured grace decision to the exact committed generation and NAR
 * hash. This also applies the decision after conceding to a concurrent winner,
 * before the pending row that stores it is cleared. The identity check always
 * runs, including when grace was not configured, so callers can distinguish a moved
 * row from a matching row that receives no grace.
 */
export function confirmGrace(
	context: ServerContext,
	retention: RetentionService,
	cache: ResolvedCache,
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
 * Confirms grace for a closure in bounded chunks. Only rows whose generation
 * and NAR hash still match receive an extension and appear in the result.
 */
export function confirmGraceBatch(
	context: ServerContext,
	retention: RetentionService,
	cache: ResolvedCache,
	entries: readonly {
		readonly storePathHash: StorePathHash;
		readonly generation: NarInfoGeneration;
		readonly narHash: NixSha256HashString;
	}[],
	graceSeconds: GraceSeconds | undefined
): Map<StorePathHash, UploadGraceFact> {
	// Compute one deadline before batching so every matched row receives the same
	// extension.
	const retainUntil =
		graceSeconds === undefined || graceSeconds === 0
			? undefined
			: isoTimestamp(new Date(Date.now() + graceSeconds * 1000));
	const matched: StorePathHash[] = [];

	// Check identity and apply each chunk's writes in one transaction. A row that
	// changes concurrently receives no extension.
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
						eq(schema.narInfos.cacheId, cache.id),
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
		// Report a configured zero grace explicitly. An empty fact means no
		// grace was configured.
		const fact: UploadGraceFact =
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
 * Reads the stored grace deadlines after a monotonic extension. An earlier
 * publication or root transition may already have set a later deadline, so replies
 * must report the stored value rather than the latest candidate. Paths without
 * a deadline are absent from the result.
 */
export function storedGraceDeadlines(
	database: ServerContext['db'],
	cache: ResolvedCache,
	storePathHashes: readonly StorePathHash[]
): Map<StorePathHash, IsoTimestamp> {
	const deadlines = new Map<StorePathHash, IsoTimestamp>();

	for (const batch of chunk(storePathHashes, maxInClauseValues)) {
		const rows = database
			.select({
				storePathHash: schema.retentionGrace.storePathHash,
				retainUntil: schema.retentionGrace.retainUntil
			})
			.from(schema.retentionGrace)
			.where(
				and(
					eq(schema.retentionGrace.cacheId, cache.id),
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
