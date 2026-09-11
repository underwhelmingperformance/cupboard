import {
	type CachePriority,
	identityForCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull } from 'drizzle-orm';

import { type SchemaWriter } from '../do/context.ts';

import { type CacheId, cacheIdentityCondition } from './cache.ts';
import * as schema from './schema.ts';

/**
 * Reads and writes the `cache_identity` rows that give each cache a surrogate
 * key.
 *
 * The legacy `cache` table is keyed by the stored name, which ties a cache's
 * identity to its access. Rows elsewhere refer to a cache by `cache_id`
 * instead, and the two are written together until the contraction drops the
 * legacy key.
 *
 * The default cache is never registered in the legacy table, but other rows
 * still need an identity to refer to.
 */
export class CacheRepository {
	constructor(private readonly database: SchemaWriter) {}

	private liveIdentity(cache: StoredCache) {
		const { scope } = identityForCache(cache);

		return and(
			cacheIdentityCondition(
				schema.cacheIdentities.kind,
				schema.cacheIdentities.name,
				scope
			),
			isNull(schema.cacheIdentities.deletedAt)
		);
	}

	/**
	 * The id of the live identity for this cache, or undefined when the cache
	 * has none.
	 *
	 * Deleting a cache leaves its row in place so the rows referring to it still
	 * resolve. Lookups here skip a deleted row, so a cache name registered again
	 * gets an identity of its own.
	 */
	find(cache: StoredCache): CacheId | undefined {
		return this.database
			.select({ id: schema.cacheIdentities.id })
			.from(schema.cacheIdentities)
			.where(this.liveIdentity(cache))
			.get()?.id;
	}

	/**
	 * The id of the live identity for this cache, creating the row when the
	 * cache has none. An existing row keeps its priority.
	 */
	ensure(
		cache: StoredCache,
		priority: CachePriority,
		now: IsoTimestamp
	): CacheId {
		const existing = this.find(cache);

		if (existing !== undefined) {
			return existing;
		}

		const { scope, access } = identityForCache(cache);
		const created = this.database
			.insert(schema.cacheIdentities)
			.values({
				kind: scope.kind,
				...(scope.kind === 'named' && { name: scope.name }),
				access,
				priority,
				createdAt: now
			})
			.returning({ id: schema.cacheIdentities.id })
			.get();

		// A cache-scoped retention policy may name a cache that does not exist
		// yet, so its `cache_id` stays null until the cache is created. Every
		// other table keyed by a cache name is written only after the cache is
		// registered, so no row in one of those can be waiting for an identity.
		this.database
			.update(schema.retentionPolicies)
			.set({ cacheId: created.id })
			.where(
				and(
					eq(schema.retentionPolicies.scope, 'cache'),
					eq(schema.retentionPolicies.pattern, cache),
					isNull(schema.retentionPolicies.cacheId)
				)
			)
			.run();

		return created.id;
	}

	setPriority(cache: StoredCache, priority: CachePriority): void {
		this.database
			.update(schema.cacheIdentities)
			.set({ priority })
			.where(this.liveIdentity(cache))
			.run();
	}

	/**
	 * Records the cache as deleted. The row stays so that the rows referring to
	 * it still resolve, and the partial unique indexes then admit a new cache of
	 * the same name.
	 */
	markDeleted(cache: StoredCache, now: IsoTimestamp): void {
		this.database
			.update(schema.cacheIdentities)
			.set({ deletedAt: now })
			.where(this.liveIdentity(cache))
			.run();
	}
}
