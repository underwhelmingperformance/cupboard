import {
	type CacheScope,
	type GraceSeconds,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import { byCodeUnit } from '@cupboard/nix-store/store-path';
import {
	type GraceCoverageResponse,
	type GracePolicyAddBody,
	type GracePolicyListResponse,
	type GracePolicyRemoveResponse,
	type GracePolicySummary,
	type RetentionPolicyAddBody,
	type RetentionPolicyListResponse,
	type RetentionPolicyRemoveResponse,
	type RetentionPolicySummary
} from '@cupboard/protocol/retention';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { ResolvedCache } from '../db/cache.ts';
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

	listPolicies(): RetentionPolicyListResponse {
		const policies = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) =>
				policySummaryFromRow(
					row,
					row.cacheId === null
						? undefined
						: this.context.cacheRepository.scopeForId(row.cacheId)
				)
			)
			.toSorted((left, right) => byCodeUnit(left.id, right.id));

		return { policies };
	}

	addPolicy(body: RetentionPolicyAddBody): RetentionPolicySummary {
		const id = crypto.randomUUID();
		const identity =
			body.scope === 'cache'
				? {
						kind: 'cache' as const,
						cacheId: this.context.cacheRepository.require(body.cache).id,
						rootNamePrefix: undefined
					}
				: {
						kind: 'root-name-prefix' as const,
						cacheId: undefined,
						rootNamePrefix: body.pattern
					};

		const row = this.context.db
			.insert(schema.retentionPolicies)
			.values({
				id,
				...identity,
				defaultTtlSeconds: body.ttlSeconds,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoUpdate({
				target:
					body.scope === 'cache'
						? schema.retentionPolicies.cacheId
						: schema.retentionPolicies.rootNamePrefix,
				targetWhere:
					body.scope === 'cache'
						? sql`${schema.retentionPolicies.kind} = 'cache'`
						: sql`${schema.retentionPolicies.kind} = 'root-name-prefix'`,
				set: { defaultTtlSeconds: body.ttlSeconds }
			})
			.returning()
			.get();

		return policySummaryFromRow(
			row,
			body.scope === 'cache' ? body.cache : undefined
		);
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

	resolvePolicyTtl(cache: ResolvedCache, name: string): number | undefined {
		const policies = this.context.db
			.select()
			.from(schema.retentionPolicies)
			.all()
			.map((row) =>
				policySummaryFromRow(
					row,
					row.cacheId === null
						? undefined
						: this.context.cacheRepository.scopeForId(row.cacheId)
				)
			);

		return mostSpecificPolicy(policies, { cache: cache.scope, name })
			?.ttlSeconds;
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

	addGracePolicy(body: GracePolicyAddBody): GracePolicySummary {
		const id = crypto.randomUUID();

		const row = this.context.db
			.insert(schema.retentionGracePolicies)
			.values({
				id,
				cachePrefix: body.cachePrefix,
				graceSeconds: body.graceSeconds,
				createdAt: isoTimestamp(new Date())
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

	graceCoverage(cacheScope: CacheScope): GraceCoverageResponse {
		const cache = this.context.cacheRepository.resolve(cacheScope);
		const graceSeconds =
			cache === undefined ? undefined : this.resolveGraceSeconds(cache);

		return graceSeconds === undefined
			? { covered: false }
			: { covered: true, graceSeconds };
	}

	// The longest matching cache-name prefix wins. The empty prefix is the
	// tenant-wide default for public caches. Private caches do not use retention
	// grace policies, although the empty prefix also matches their names.
	resolveGraceSeconds(cache: ResolvedCache): GraceSeconds | undefined {
		if (cache.access === 'private') {
			return undefined;
		}

		return this.context.db
			.select({
				cachePrefix: schema.retentionGracePolicies.cachePrefix,
				graceSeconds: schema.retentionGracePolicies.graceSeconds
			})
			.from(schema.retentionGracePolicies)
			.all()
			.filter((policy) =>
				cache.scope.kind === 'default'
					? policy.cachePrefix === ''
					: cache.scope.name.startsWith(policy.cachePrefix)
			)
			.toSorted(
				(left, right) => right.cachePrefix.length - left.cachePrefix.length
			)
			.at(0)?.graceSeconds;
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

	// Mark the cache as grace-managed even when the matching policy grants zero
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
