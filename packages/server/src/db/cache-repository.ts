import {
	type CacheAccessMode,
	type CachePriority,
	type CacheScope,
	identityForCache,
	type StoredCache
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull, or, type SQL } from 'drizzle-orm';

import { type SchemaWriter } from '../do/context.ts';
import { CacheAccessConflictError } from '../errors.ts';

import { type CacheId, cacheIdentityCondition } from './cache.ts';
import * as schema from './schema.ts';

/**
 * Reads and writes the `cache_identity` rows that give each cache a
 * surrogate key, `cache_id`.
 *
 * The legacy `cache` table is keyed by the stored name, which ties a
 * cache's identity to its access. Rows elsewhere refer to a cache by
 * `cache_id` instead, and every write records both until the legacy key
 * is dropped.
 */
export class CacheRepository {
	constructor(private readonly database: SchemaWriter) {}

	/**
	 * The live row registered under a kind and name, whichever access it has.
	 *
	 * Deleting a cache leaves its row in place so the rows referring to it
	 * still resolve. Lookups skip a deleted row, so a cache name registered
	 * again gets an identity of its own.
	 */
	private liveName(scope: CacheScope): SQL | undefined {
		return and(
			cacheIdentityCondition(
				schema.cacheIdentities.kind,
				schema.cacheIdentities.name,
				scope
			),
			isNull(schema.cacheIdentities.deletedAt)
		);
	}

	// The backfill records a null access for a public named cache because it
	// cannot see the tenant's read mode. Under the legacy key such a cache is
	// unprefixed, which is what `public` means here.
	private storedAccess(access: CacheAccessMode): SQL | undefined {
		if (access === 'private') {
			return eq(schema.cacheIdentities.access, 'private');
		}

		return or(
			isNull(schema.cacheIdentities.access),
			eq(schema.cacheIdentities.access, 'public')
		);
	}

	private liveIdentity(cache: StoredCache): SQL | undefined {
		const { scope, access } = identityForCache(cache);

		return and(this.liveName(scope), this.storedAccess(access));
	}

	/**
	 * The id of the live identity for this cache, or undefined when the cache
	 * has none.
	 */
	find(cache: StoredCache): CacheId | undefined {
		return this.liveIdentityId(cache).get()?.id;
	}

	/**
	 * The select that `find` runs, for a statement that embeds it as a
	 * subquery and so needs no statement of its own for the lookup.
	 */
	liveIdentityId(cache: StoredCache) {
		return this.database
			.select({ id: schema.cacheIdentities.id })
			.from(schema.cacheIdentities)
			.where(this.liveIdentity(cache));
	}

	/**
	 * The id of the live identity for this cache, creating the row when the
	 * cache has none. An existing row keeps its priority.
	 *
	 * An identity is keyed by kind and name. A live identity with the other
	 * access is not this cache: returning its id would file this cache's
	 * rows under an identity whose `access` is wrong, so the registration
	 * is refused instead.
	 */
	ensure(
		cache: StoredCache,
		priority: CachePriority,
		now: IsoTimestamp
	): CacheId {
		const { scope, access } = identityForCache(cache);
		const live = this.database
			.select({
				id: schema.cacheIdentities.id,
				access: schema.cacheIdentities.access
			})
			.from(schema.cacheIdentities)
			.where(this.liveName(scope))
			.get();

		if (live !== undefined) {
			const liveAccess = live.access ?? 'public';

			if (liveAccess !== access) {
				throw new CacheAccessConflictError(scope, liveAccess, access);
			}

			return live.id;
		}

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

		// A pending upload or attestation can be negotiated before its cache
		// exists, and a cache-scoped retention policy can be added before it.
		// Those rows wait with a null `cache_id` under the legacy name. A policy
		// also outlives a deletion and applies to the name, so every policy
		// naming the cache is bound to the new identity, not only the ones still
		// null.
		for (const table of [schema.pendingUploads, schema.pendingAttestations]) {
			this.database
				.update(table)
				.set({ cacheId: created.id })
				.where(and(eq(table.cache, cache), isNull(table.cacheId)))
				.run();
		}

		this.database
			.update(schema.retentionPolicies)
			.set({ cacheId: created.id })
			.where(
				and(
					eq(schema.retentionPolicies.scope, 'cache'),
					eq(schema.retentionPolicies.pattern, cache)
				)
			)
			.run();

		return created.id;
	}

	markGraceManaged(cache: StoredCache): void {
		this.database
			.update(schema.cacheIdentities)
			.set({ graceManaged: true })
			.where(this.liveIdentity(cache))
			.run();
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
