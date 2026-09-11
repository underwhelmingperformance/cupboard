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

import {
	type CacheId,
	legacyCacheKey,
	type ResolvedCache
} from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import { mostSpecificPolicy } from '../policy/policy-match.ts';

import {
	gracePolicySummaryFromRow,
	policySummaryFromRow,
	type SchemaWriter,
	type ServerContext
} from './context.ts';
import { jsonRowLists, jsonValueLists } from './json-list.ts';

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

		for (const hashes of jsonValueLists(storePathHashes)) {
			const rows = writer
				.select({ storePathHash: schema.narInfos.storePathHash })
				.from(schema.narInfos)
				.where(
					and(
						eq(schema.narInfos.cacheId, cache.id),
						inArray(schema.narInfos.storePathHash, hashes)
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
		const legacyCache = legacyCacheKey(cache.scope, cache.access);

		for (const rows of jsonRowLists(entries)) {
			writer
				.insert(schema.retentionGrace)
				.select(
					rows.insertSource([
						sql`${legacyCache}`,
						sql`${cache.id}`,
						rows.column('storePathHash'),
						rows.column('retainUntil')
					])
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

	// The identity columns for a policy, with the legacy `pattern` beside them.
	// A cache-scoped policy is keyed by the cache's stored name, so the legacy
	// value comes from the resolved cache rather than from the request.
	private policyIdentity(body: RetentionPolicyAddBody): {
		readonly kind: 'cache' | 'root-name-prefix';
		readonly pattern: string;
		readonly cacheId: CacheId | undefined;
		readonly rootNamePrefix: string | undefined;
	} {
		if (body.scope === 'root-name-prefix') {
			return {
				kind: 'root-name-prefix',
				pattern: body.pattern,
				cacheId: undefined,
				rootNamePrefix: body.pattern
			};
		}

		const cache = this.context.cacheRepository.require(body.cache);

		return {
			kind: 'cache',
			pattern: legacyCacheKey(cache.scope, cache.access),
			cacheId: cache.id,
			rootNamePrefix: undefined
		};
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
		const identity = this.policyIdentity(body);
		const row = this.context.db
			.insert(schema.retentionPolicies)
			.values({
				id,
				scope: body.scope,
				...identity,
				defaultTtlSeconds: body.ttlSeconds,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoUpdate({
				// The unique index is still on the legacy scope and pattern, so the
				// upsert matches on those rather than on the identity columns.
				target: [
					schema.retentionPolicies.scope,
					schema.retentionPolicies.pattern
				],
				set: { ...identity, defaultTtlSeconds: body.ttlSeconds }
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
			.update(schema.cacheIdentities)
			.set({ graceManaged: true })
			.where(eq(schema.cacheIdentities.id, cache.id))
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
