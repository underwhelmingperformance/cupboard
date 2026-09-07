import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cacheAccessModeSchema,
	type CacheGeneration,
	type CachePriority,
	cachePrioritySchema,
	type CacheScope,
	firstCacheGeneration
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, gt, isNull } from 'drizzle-orm';

import type { SchemaDatabase } from '../do/context.ts';
import {
	CacheAlreadyExistsError,
	CacheIdentityMissingError,
	CacheNotFoundError
} from '../errors.ts';

import {
	cacheIdentityCondition,
	cacheScopeFromRow,
	type ResolvedCache
} from './cache.ts';
import { type CacheLifecycleVersion } from './cache-generation.ts';
import * as schema from './schema.ts';

// The columns that make up a resolved cache. `access` and the identity columns
// are still nullable while the expansion runs, so a row is only usable once
// both have been backfilled.
interface CacheIdentityRow {
	readonly id: ResolvedCache['id'];
	readonly kind: 'default' | 'named' | null;
	readonly name: string | null;
	readonly access: string | null;
	readonly generation: CacheGeneration;
}

const identityColumns = {
	id: schema.cacheIdentities.id,
	kind: schema.cacheIdentities.kind,
	name: schema.cacheIdentities.name,
	access: schema.cacheIdentities.access,
	generation: schema.cacheIdentities.generation
};

/**
 * Reads and writes the `cache_identity` rows that hold each cache's scope,
 * access and surrogate key.
 *
 * The legacy `cache` table is keyed by the stored name, which ties a cache's
 * identity to its access. Rows elsewhere refer to a cache by `cache_id`
 * instead, and the two are written together until the contraction drops the
 * legacy key.
 */
export class CacheRepository {
	constructor(private readonly database: SchemaDatabase) {}

	// A row whose access the reconciliation has not yet supplied cannot say who
	// may read the cache. Refusing it keeps a half-written row from resolving as
	// a public cache.
	private resolved(row: CacheIdentityRow): ResolvedCache {
		if (row.access === null) {
			throw new CacheIdentityMissingError({ id: row.id });
		}

		return {
			id: row.id,
			scope: cacheScopeFromRow(row),
			access: cacheAccessModeSchema.parse(row.access),
			generation: row.generation
		};
	}

	/**
	 * The live cache for this scope, or undefined when the tenant has none.
	 *
	 * Deleting a cache leaves its row in place so the rows referring to it still
	 * resolve. Lookups here skip a deleted row, so a cache name registered again
	 * gets an identity of its own.
	 */
	resolve(scope: CacheScope): ResolvedCache | undefined {
		const row = this.database
			.select(identityColumns)
			.from(schema.cacheIdentities)
			.where(
				and(
					cacheIdentityCondition(
						schema.cacheIdentities.kind,
						schema.cacheIdentities.name,
						scope
					),
					isNull(schema.cacheIdentities.deletedAt)
				)
			)
			.get();

		return row === undefined ? undefined : this.resolved(row);
	}

	require(scope: CacheScope): ResolvedCache {
		const cache = this.resolve(scope);

		if (cache === undefined) {
			throw new CacheNotFoundError(scope);
		}

		return cache;
	}

	create(
		scope: CacheScope,
		access: CacheAccessMode,
		priority: CachePriority
	): ResolvedCache {
		const created = this.database
			.insert(schema.cacheIdentities)
			.values({
				kind: scope.kind,
				...(scope.kind === 'named' && { name: scope.name }),
				access,
				priority,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.returning(identityColumns)
			.all()
			.at(0);

		if (created === undefined) {
			throw new CacheAlreadyExistsError(scope);
		}

		return this.resolved(created);
	}

	resolveOrCreate(scope: CacheScope, access: CacheAccessMode): ResolvedCache {
		const existing = this.resolve(scope);

		if (existing !== undefined) {
			return existing;
		}

		if (scope.kind === 'default') {
			throw new CacheIdentityMissingError(scope);
		}

		this.database
			.insert(schema.cacheIdentities)
			.values({
				kind: 'named',
				name: scope.name,
				access,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();

		return this.require(scope);
	}

	setAccess(cache: ResolvedCache, access: CacheAccessMode): ResolvedCache {
		if (cache.access === access) {
			return cache;
		}

		this.database
			.update(schema.cacheIdentities)
			.set({ access })
			.where(eq(schema.cacheIdentities.id, cache.id))
			.run();

		return { ...cache, access };
	}

	scopeForId(id: ResolvedCache['id'] | null): CacheScope {
		return this.resolvedForId(id).scope;
	}

	/**
	 * The cache a row's `cache_id` refers to.
	 *
	 * The column is nullable because the expansion added it to populated tables,
	 * and the contraction tightens it later. Under native reads a null cannot
	 * occur: the local reconcile fills every row, and the deployment phase does
	 * not advance until every tenant has run it. Refusing a null therefore
	 * reports that the phase advanced early, rather than covering for it by
	 * attributing the row to whichever cache the caller expected.
	 */
	resolvedForId(id: ResolvedCache['id'] | null): ResolvedCache {
		if (id === null) {
			throw new CacheIdentityMissingError({});
		}

		const row = this.database
			.select(identityColumns)
			.from(schema.cacheIdentities)
			.where(eq(schema.cacheIdentities.id, id))
			.get();

		if (row === undefined) {
			throw new CacheIdentityMissingError({ id });
		}

		return this.resolved(row);
	}

	/**
	 * Records against the cache's identity the generation and read revision that
	 * `cache_lifecycle` published for it, and returns the cache as it now stands.
	 *
	 * D1 is authoritative for both. Registering a cache name that a deletion
	 * advanced returns a generation above the default this row was created with,
	 * so the local incarnation would otherwise claim to be the first one. Object
	 * keys are built from the generation, so a caller that keeps writing through
	 * the value it passed in would address the previous cache's objects.
	 */
	stampVersion(
		cache: ResolvedCache,
		version: CacheLifecycleVersion
	): ResolvedCache {
		this.database
			.update(schema.cacheIdentities)
			.set({
				generation: version.generation,
				readRevision: version.readRevision
			})
			.where(eq(schema.cacheIdentities.id, cache.id))
			.run();

		return { ...cache, generation: version.generation };
	}

	/**
	 * Every cache of this tenant above its first generation, deleted ones
	 * included.
	 *
	 * A deleted cache is often the only row left for a name whose registration is
	 * gone, and the objects that name accumulated before its keys carried a
	 * generation are still under its first-generation prefix. Leaving those rows
	 * out would leave the prefix with nothing to name it.
	 */
	aboveFirstGeneration(): ResolvedCache[] {
		return this.database
			.select(identityColumns)
			.from(schema.cacheIdentities)
			.where(gt(schema.cacheIdentities.generation, firstCacheGeneration))
			.all()
			.map((row) => this.resolved(row));
	}
}
