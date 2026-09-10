import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CachePriority,
	cachePrioritySchema,
	type CacheReadRevision,
	type CacheScope,
	firstCacheGeneration,
	type StoredCache,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, sql } from 'drizzle-orm';

import {
	cacheIdentityColumns,
	cacheIdentityCondition,
	legacyCacheKey,
	type ResolvedCache
} from '../db/cache.ts';
import {
	type CacheLifecycleVersion,
	firstCacheReadRevision
} from '../db/cache-generation.ts';
import { type CacheCreation } from '../db/cache-repository.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { CacheAlreadyExistsError, CacheNotFoundError } from '../errors.ts';

import { type ServerContext } from './context.ts';

// Matches the tenant's lifecycle row for one cache by its identity columns.
// The legacy key in the primary key encodes the access, so a cache that
// changes access would otherwise gain a second row rather than update its
// existing one.
export function cacheLifecycleFilter(tenant: TenantId, scope: CacheScope) {
	return and(
		eq(d1Schema.cacheLifecycle.tenant, tenant),
		cacheIdentityCondition(
			d1Schema.cacheLifecycle.cacheKind,
			d1Schema.cacheLifecycle.cacheName,
			scope
		)
	);
}

/**
 * Registers caches: the identity row, the D1 lifecycle row that admission
 * reads, and the legacy registration row that stays in step with the identity
 * until the contraction drops it.
 *
 * The write paths create a named cache on its first write through this
 * service, so it depends on nothing but the context.
 */
export class CacheRegistrationService {
	constructor(private readonly context: ServerContext) {}

	/**
	 * Writes this cache's lifecycle row when the tenant registers the cache,
	 * clears the deletion timestamp when a deleted name is registered again,
	 * and returns the generation and read revision the row then holds.
	 *
	 * The row says the cache exists and how it reads, which is what a request
	 * naming the cache consults. Writing it here rather than leaving it to the
	 * projection means a cache is known from its first write.
	 *
	 * The generation stays where a deletion left it, so the edges of the deleted
	 * cache remain revoked while the new cache commits its own. An insert starts
	 * at the first generation.
	 *
	 * The read revision advances only when the access recorded for the name
	 * differs from the access being registered. Advancing it on every
	 * registration would evict the cache's public responses on each commit.
	 */
	async recordLifecycle(
		cache: Pick<ResolvedCache, 'scope' | 'access'>
	): Promise<CacheLifecycleVersion> {
		const tenant = this.context.requireTenant();
		const { scope, access } = cache;
		const now = isoTimestamp(new Date());
		const version = {
			generation: d1Schema.cacheLifecycle.generation,
			readRevision: d1Schema.cacheLifecycle.readRevision
		};
		const updated = await this.context.d1
			.update(d1Schema.cacheLifecycle)
			.set({
				cache: legacyCacheKey(scope, access),
				access,
				readRevision: sql<CacheReadRevision>`case when ${d1Schema.cacheLifecycle.access} is ${access} then ${d1Schema.cacheLifecycle.readRevision} else ${d1Schema.cacheLifecycle.readRevision} + 1 end`,
				deletedAt: sql`null`,
				updatedAt: now
			})
			.where(cacheLifecycleFilter(tenant, scope))
			.returning(version)
			// `get` is typed as always returning a row, but an update that matched
			// nothing returns none. Read the first of `all` so the miss is visible.
			.all();
		const updatedVersion = updated.at(0);

		if (updatedVersion !== undefined) {
			return updatedVersion;
		}

		return this.context.d1
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant,
				cache: legacyCacheKey(scope, access),
				...cacheIdentityColumns(scope),
				access,
				generation: firstCacheGeneration,
				readRevision: firstCacheReadRevision,
				updatedAt: now
			})
			.returning(version)
			.get();
	}

	async clearReadCredential(scope: CacheScope): Promise<void> {
		const tenant = this.context.requireTenant();

		await this.context.d1
			.delete(d1Schema.tenantCacheReadCredential)
			.where(
				and(
					eq(d1Schema.tenantCacheReadCredential.tenant, tenant),
					cacheIdentityCondition(
						d1Schema.tenantCacheReadCredential.cacheKind,
						d1Schema.tenantCacheReadCredential.cacheName,
						scope
					)
				)
			)
			.run();
	}

	// The legacy registration table is still written so its rows stay in step
	// with the identities. It is keyed by the cache's stored name, which encodes
	// the access, so changing the access replaces the row rather than updating
	// it.
	registerLegacy(cache: ResolvedCache, priority: CachePriority): void {
		this.context.db
			.insert(schema.caches)
			.values({
				name: legacyCacheKey(cache.scope, cache.access),
				priority,
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoUpdate({
				target: schema.caches.name,
				set: { priority }
			})
			.run();
	}

	removeLegacy(cache: StoredCache): void {
		this.context.db
			.delete(schema.caches)
			.where(eq(schema.caches.name, cache))
			.run();
	}

	/**
	 * Creates the cache. The caller holds the critical section, so the
	 * existence check and the writes see no other request between them.
	 */
	async createInSection(
		scope: CacheScope,
		configuration: CacheCreation
	): Promise<ResolvedCache> {
		if (this.context.cacheRepository.resolve(scope) !== undefined) {
			throw new CacheAlreadyExistsError(scope);
		}

		const version = await this.recordLifecycle({
			scope,
			access: configuration.access
		});

		if (configuration.access === 'public') {
			await this.clearReadCredential(scope);
		}

		const created = this.context.cacheRepository.create(scope, configuration);
		const cache = this.context.cacheRepository.stampGeneration(
			created,
			version.generation
		);
		this.registerLegacy(cache, configuration.priority);

		return cache;
	}

	/**
	 * The cache a write addresses. A named cache the tenant does not hold is
	 * created first, so a push, a root write or an attestation negotiation
	 * needs no registration step before it. The new cache takes the access of
	 * the tenant's default cache: a tenant whose reads are private gets private
	 * caches from its writes, and a public one public caches.
	 */
	async forWrite(scope: CacheScope): Promise<ResolvedCache> {
		const existing = this.context.cacheRepository.resolve(scope);

		if (existing !== undefined) {
			return existing;
		}

		if (scope.kind === 'default') {
			throw new CacheNotFoundError(scope);
		}

		const access = this.context.cacheRepository.require({
			kind: 'default'
		}).access;

		try {
			return await this.context.criticalSection(() =>
				this.createInSection(scope, {
					access,
					priority: cachePrioritySchema.parse(CacheInfo.default.priority)
				})
			);
		} catch (error) {
			// Another write created the cache while this one waited at the gate.
			if (error instanceof CacheAlreadyExistsError) {
				return this.context.cacheRepository.require(scope);
			}

			throw error;
		}
	}
}
