import {
	type GraceSeconds,
	type StoredCache,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type GraceCoverageResponse,
	type GracePolicyListResponse,
	type GracePolicyRemoveResponse,
	type GracePolicySummary,
	type ParsedGracePolicyAddBody,
	type ParsedRetentionPolicyAddBody,
	type RetentionPolicyListResponse,
	type RetentionPolicyRemoveResponse,
	type RetentionPolicySummary
} from '@cupboard/protocol/retention';
import { and, eq, inArray, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import { mostSpecificPolicy } from '../policy/policy-match.ts';

import { chunk, maxInClauseValues } from './bulk.ts';
import {
	gracePolicySummaryFromRow,
	policySummaryFromRow,
	type SchemaWriter,
	type ServerContext
} from './context.ts';

// Each extended row binds three columns (cache, storePathHash, retainUntil),
// so the row count per insert is maxInClauseValues divided by three: the same
// bound-parameter headroom as a single-column IN-list, spent three at a time.
const maxGraceDeadlineRowsPerInsert = Math.floor(maxInClauseValues / 3);

interface GraceTransition {
	readonly storePathHash: StorePathHash;
	readonly anchorIso: string;
}

export class RetentionService {
	constructor(private readonly context: ServerContext) {}

	private narinfoBackedHashes(
		cache: StoredCache,
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
						eq(schema.narInfos.cache, cache),
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
		cache: StoredCache,
		entries: readonly {
			readonly storePathHash: StorePathHash;
			readonly retainUntil: string;
		}[],
		writer: SchemaWriter
	): void {
		for (const batch of chunk(entries, maxGraceDeadlineRowsPerInsert)) {
			writer
				.insert(schema.retentionGrace)
				.values(
					batch.map(({ storePathHash, retainUntil }) => ({
						cache,
						storePathHash,
						retainUntil
					}))
				)
				.onConflictDoUpdate({
					target: [
						schema.retentionGrace.cache,
						schema.retentionGrace.storePathHash
					],
					set: {
						retainUntil: sql`max(${schema.retentionGrace.retainUntil}, excluded.retain_until)`
					}
				})
				.run();
		}
	}

	listPolicies(): RetentionPolicyListResponse {
		const policies = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) => policySummaryFromRow(row))
			.toSorted((left, right) => byCodeUnit(left.id, right.id));

		return { policies };
	}

	addPolicy(body: ParsedRetentionPolicyAddBody): RetentionPolicySummary {
		const id = crypto.randomUUID();
		const now = new Date();

		this.context.db
			.insert(schema.retentionPolicies)
			.values({
				id,
				scope: body.scope,
				pattern: body.pattern,
				defaultTtlSeconds: body.ttlSeconds,
				createdAt: now.toISOString()
			})
			.run();

		return {
			id,
			scope: body.scope,
			pattern: body.pattern,
			ttlSeconds: body.ttlSeconds
		};
	}

	removePolicy(id: string): RetentionPolicyRemoveResponse {
		const existing = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.where(eq(schema.retentionPolicies.id, id))
			.get();

		this.context.db
			.delete(schema.retentionPolicies)
			.where(eq(schema.retentionPolicies.id, id))
			.run();

		return {
			id,
			removed: existing !== undefined
		};
	}

	resolvePolicyTtl(cache: StoredCache, name: string): number | undefined {
		const policies = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) => ({
				scope: row.scope,
				pattern: row.pattern,
				ttlSeconds: row.defaultTtlSeconds
			}));

		return mostSpecificPolicy(policies, { cache, name })?.ttlSeconds;
	}

	listGracePolicies(): GracePolicyListResponse {
		const policies = this.context.db
			.select()
			.from(schema.retentionGracePolicies)
			.all()
			.map((row) => gracePolicySummaryFromRow(row))
			.toSorted((left, right) =>
				byCodeUnit(left.cachePrefix, right.cachePrefix)
			);

		return { policies };
	}

	addGracePolicy(body: ParsedGracePolicyAddBody): GracePolicySummary {
		const id = crypto.randomUUID();
		const now = new Date();

		const row = this.context.db
			.insert(schema.retentionGracePolicies)
			.values({
				id,
				cachePrefix: body.cachePrefix,
				graceSeconds: body.graceSeconds,
				createdAt: now.toISOString()
			})
			.onConflictDoUpdate({
				target: schema.retentionGracePolicies.cachePrefix,
				set: { graceSeconds: body.graceSeconds }
			})
			.returning()
			.get();

		return gracePolicySummaryFromRow(row);
	}

	removeGracePolicy(id: string): GracePolicyRemoveResponse {
		const existing = this.context.db
			.select()
			.from(schema.retentionGracePolicies)
			.where(eq(schema.retentionGracePolicies.id, id))
			.get();

		this.context.db
			.delete(schema.retentionGracePolicies)
			.where(eq(schema.retentionGracePolicies.id, id))
			.run();

		return {
			id,
			removed: existing !== undefined
		};
	}

	// The coverage answer a grace-mode CI run reads before publishing anything:
	// the same resolution a publication to the cache would be granted.
	graceCoverage(cache: StoredCache): GraceCoverageResponse {
		const graceSeconds = this.resolveGraceSeconds(cache);

		return graceSeconds === undefined
			? { covered: false }
			: { covered: true, graceSeconds };
	}

	// The grace in force for a cache: the longest matching cache-name prefix
	// wins, and the empty prefix matches every cache as the tenant default.
	resolveGraceSeconds(cache: StoredCache): GraceSeconds | undefined {
		return this.context.db
			.select({
				cachePrefix: schema.retentionGracePolicies.cachePrefix,
				graceSeconds: schema.retentionGracePolicies.graceSeconds
			})
			.from(schema.retentionGracePolicies)
			.all()
			.filter((policy) => cache.startsWith(policy.cachePrefix))
			.toSorted(
				(left, right) => right.cachePrefix.length - left.cachePrefix.length
			)
			.at(0)?.graceSeconds;
	}

	// Extends each path's grace deadline to at least `retainUntil`. Monotonic in
	// a single statement: `max` over ISO-8601 UTC strings is chronological, so a
	// concurrent or retried earlier event can never shorten a stored deadline.
	// Takes a writer, not always `this.context.db`, so a caller that must write
	// this atomically with another statement can pass its transaction handle.
	extendGraceDeadlines(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[],
		retainUntil: string,
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

	// Takes a writer for the same reason as {@link extendGraceDeadlines}: a
	// caller that must write this atomically with another statement passes its
	// transaction handle.
	markCacheGraceManaged(
		cache: StoredCache,
		writer: SchemaWriter = this.context.db
	): void {
		writer
			.update(schema.caches)
			.set({ graceManaged: true })
			.where(eq(schema.caches.name, cache))
			.run();
	}

	// Applies the matching grace policy to targets a retention transition has
	// released: marking the cache grace-managed is a one-way boundary and happens
	// even for a zero grace, which grants no lasting deadline. Takes a writer for
	// the same reason as {@link extendGraceDeadlines}: a caller applying this
	// alongside the retention delete that released these targets passes its
	// transaction handle, so a failure between the two cannot lose the
	// transition.
	applyGraceTransition(
		cache: StoredCache,
		storePathHashes: readonly StorePathHash[],
		anchorIso: string,
		writer: SchemaWriter = this.context.db
	): void {
		this.applyGraceTransitions(
			cache,
			storePathHashes.map((storePathHash) => ({ storePathHash, anchorIso })),
			writer
		);
	}

	// Applies a bounded set of root transitions together. A path released by
	// several roots receives the latest candidate deadline, while policy
	// resolution, narinfo filtering and deadline writes each happen once.
	applyGraceTransitions(
		cache: StoredCache,
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

		// Deleting a path leaves its retention_root_target rows behind, so a
		// released hash may have no narinfo row any more; granting it a deadline
		// would wake maintenance for nothing and hand a recommitted path an
		// inherited stale deadline. Only backed hashes receive one, read through
		// the caller's writer so the check shares its transaction.
		const latestAnchorByHash = new Map<StorePathHash, string>();

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
								retainUntil: new Date(
									new Date(anchorIso).getTime() + graceSeconds * 1000
								).toISOString()
							}
						];
			}),
			writer
		);
	}
}
