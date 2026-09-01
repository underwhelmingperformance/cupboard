import {
	type GraceSeconds,
	type RootName,
	type StorePathHash,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import { type SchemaWriter, type ServerContext } from './context.ts';

// Each extended row binds three columns (cache, storePathHash, retainUntil),
// so the row count per insert is maxInClauseValues divided by three: the same
// bound-parameter headroom as a single-column IN-list, spent three at a time.
const maxGraceDeadlineRowsPerInsert = Math.floor(maxInClauseValues / 3);

interface GraceTransition {
	readonly storePathHash: StorePathHash;
	readonly anchorIso: IsoTimestamp;
}

export class RetentionService {
	constructor(private readonly context: ServerContext) {}

	private narinfoBackedHashes(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[],
		writer: SchemaWriter
	): StorePathHash[] {
		const backed = new Set<StorePathHash>();

		for (const batch of chunk(storePathHashes, maxInClauseValues)) {
			const rows = writer
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						inArray(schema.narInfos.storePathHash, batch)
					)
				)
				.all();

			for (const row of rows) {
				backed.add(row.storePathHash);
			}
		}

		return storePathHashes.filter((storePathHash) => backed.has(storePathHash));
	}

	private extendGraceDeadlineEntries(
		cache: ResolvedCache,
		entries: readonly {
			readonly storePathHash: StorePathHash;
			readonly retainUntil: IsoTimestamp;
		}[],
		writer: SchemaWriter
	): void {
		for (const batch of chunk(entries, maxGraceDeadlineRowsPerInsert)) {
			writer
				.insert(schema.retentionGrace)
				.values(
					batch.map(({ storePathHash, retainUntil }) => ({
						cacheId: cache.id,
						storePathHash,
						retainUntil
					}))
				)
				.onConflictDoUpdate({
					target: [
						schema.retentionGrace.cacheId,
						schema.retentionGrace.storePathHash
					],
					set: {
						retainUntil: sql`max(${schema.retentionGrace.retainUntil}, excluded.retain_until)`
					}
				})
				.run();
		}
	}

	resolveRootTtl(cache: ResolvedCache, name: RootName): TtlSeconds | undefined {
		const configured = this.context.db
			.select({ ttlSeconds: schema.caches.defaultRootTtlSeconds })
			.from(schema.caches)
			.where(eq(schema.caches.id, cache.id))
			.get();
		const override = this.context.db
			.select({
				rootPrefix: schema.cacheRootTtlOverrides.rootPrefix,
				ttlSeconds: schema.cacheRootTtlOverrides.ttlSeconds
			})
			.from(schema.cacheRootTtlOverrides)
			.where(eq(schema.cacheRootTtlOverrides.cacheId, cache.id))
			.all()
			.filter(({ rootPrefix }) => name.startsWith(rootPrefix))
			.toSorted(
				(left, right) => right.rootPrefix.length - left.rootPrefix.length
			)
			.at(0);

		return override?.ttlSeconds ?? configured?.ttlSeconds ?? undefined;
	}

	resolveGraceSeconds(cache: ResolvedCache): GraceSeconds | undefined {
		return (
			this.context.db
				.select({ graceSeconds: schema.caches.graceSeconds })
				.from(schema.caches)
				.where(eq(schema.caches.id, cache.id))
				.get()?.graceSeconds ?? undefined
		);
	}

	// Extend deadlines monotonically in one statement. ISO-8601 UTC strings compare
	// chronologically, so a concurrent or retried earlier event cannot shorten a
	// deadline. Callers can supply their transaction to make this update atomic
	// with the retention change that released the paths.
	extendGraceDeadlines(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[],
		retainUntil: IsoTimestamp,
		writer: SchemaWriter = this.context.db
	): void {
		this.extendGraceDeadlineEntries(
			cache,
			storePathHashes.map((storePathHash) => ({
				storePathHash,
				retainUntil
			})),
			writer
		);
	}

	markCacheGraceManaged(
		cache: ResolvedCache,
		writer: SchemaWriter = this.context.db
	): void {
		writer
			.update(schema.caches)
			.set({ graceManaged: true })
			.where(eq(schema.caches.id, cache.id))
			.run();
	}

	applyGraceTransition(
		cache: ResolvedCache,
		storePathHashes: readonly StorePathHash[],
		anchorIso: IsoTimestamp,
		writer: SchemaWriter = this.context.db
	): void {
		this.applyGraceTransitions(
			cache,
			storePathHashes.map((storePathHash) => ({ storePathHash, anchorIso })),
			writer
		);
	}

	// Mark the cache as grace-managed even when its configured grace is zero
	// seconds. For several releases of one path, use the latest resulting deadline.
	// The caller can supply its transaction so removing retention and granting
	// grace cannot be separated by a crash.
	applyGraceTransitions(
		cache: ResolvedCache,
		transitions: readonly GraceTransition[],
		writer: SchemaWriter = this.context.db
	): void {
		if (transitions.length === 0) {
			return;
		}

		const graceSeconds = this.resolveGraceSeconds(cache);

		if (graceSeconds === undefined) {
			return;
		}

		this.markCacheGraceManaged(cache, writer);

		if (graceSeconds === 0) {
			return;
		}

		// Deleting a path can leave retention targets after its narinfo row is gone.
		// Do not grant those hashes a deadline that a later recommit could inherit.
		// Read through the supplied writer so this check shares the caller's transaction.
		const latestAnchorByHash = new Map<StorePathHash, IsoTimestamp>();

		for (const transition of transitions) {
			const current = latestAnchorByHash.get(transition.storePathHash);

			if (current === undefined || transition.anchorIso > current) {
				latestAnchorByHash.set(transition.storePathHash, transition.anchorIso);
			}
		}

		const backed = this.narinfoBackedHashes(
			cache,
			latestAnchorByHash.keys().toArray(),
			writer
		);

		if (backed.length === 0) {
			return;
		}

		this.extendGraceDeadlineEntries(
			cache,
			backed.flatMap((storePathHash) => {
				const anchorIso = latestAnchorByHash.get(storePathHash);

				return anchorIso === undefined
					? []
					: [
							{
								storePathHash,
								retainUntil: isoTimestamp(
									new Date(new Date(anchorIso).getTime() + graceSeconds * 1000)
								)
							}
						];
			}),
			writer
		);
	}
}
