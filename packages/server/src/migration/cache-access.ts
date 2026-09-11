import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cacheAccessModeSchema,
	cacheGenerationSchema,
	cachePrioritySchema,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, eq, isNull, sql } from 'drizzle-orm';

import {
	type CacheId,
	cacheIdentityColumns,
	cacheIdentityCondition,
	cacheScopeFromRow
} from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import type { ServerContext } from '../do/context.ts';
import { CacheCatalogueMigrationError } from '../errors.ts';

export const cacheCatalogueVersion = 1;

interface LifecycleRow {
	readonly access: CacheAccessMode;
	readonly deletedAt: IsoTimestamp | undefined;
	readonly generation: number;
}

interface CatalogueEntry {
	readonly id: CacheId;
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
	readonly deletedAt: IsoTimestamp | undefined;
	readonly generation: number;
}

function scopeKey(scope: CacheScope): string {
	return scope.kind === 'default' ? 'default' : `named:${scope.name}`;
}

export async function revokeCacheLifecycle(
	context: ServerContext,
	tenant: TenantId,
	scope: CacheScope,
	access: CacheAccessMode,
	now: IsoTimestamp
): Promise<void> {
	const updated = await context.d1
		.update(d1Schema.cacheLifecycle)
		.set({
			access,
			generation: sql`${d1Schema.cacheLifecycle.generation} + 1`,
			deletedAt: now,
			updatedAt: now
		})
		.where(
			sql`${d1Schema.cacheLifecycle.tenant} = ${tenant} and ${cacheIdentityCondition(d1Schema.cacheLifecycle.cacheKind, d1Schema.cacheLifecycle.cacheName, scope)}`
		)
		.run();

	if (updated.meta.changes > 0) {
		return;
	}

	await context.d1.insert(d1Schema.cacheLifecycle).values({
		tenant,
		...cacheIdentityColumns(scope),
		access,
		generation: cacheGenerationSchema.parse(2),
		deletedAt: now,
		updatedAt: now
	});
}

export async function clearCacheLifecycleDeletion(
	context: ServerContext,
	tenant: TenantId,
	scope: CacheScope,
	access: CacheAccessMode,
	now: IsoTimestamp
): Promise<void> {
	const updated = await context.d1
		.update(d1Schema.cacheLifecycle)
		.set({
			access,
			deletedAt: sql`null`,
			updatedAt: now
		})
		.where(
			sql`${d1Schema.cacheLifecycle.tenant} = ${tenant} and ${cacheIdentityCondition(d1Schema.cacheLifecycle.cacheKind, d1Schema.cacheLifecycle.cacheName, scope)}`
		)
		.run();

	if (updated.meta.changes > 0) {
		return;
	}

	await context.d1.insert(d1Schema.cacheLifecycle).values({
		tenant,
		...cacheIdentityColumns(scope),
		access,
		generation: cacheGenerationSchema.parse(1),
		deletedAt: sql`null`,
		updatedAt: now
	});
}

/**
 * The access a cache takes when the local catalogue records none for it: the
 * access of the tenant's default cache, which every tenant has.
 *
 * A cache that records no access was created when one setting on the tenant row
 * decided how all of a tenant's caches read, and the default cache's lifecycle
 * row holds that setting's value.
 */
async function defaultCacheAccess(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheAccessMode> {
	const row = await context.d1
		.select({ access: d1Schema.cacheLifecycle.access })
		.from(d1Schema.cacheLifecycle)
		.where(
			and(
				eq(d1Schema.cacheLifecycle.tenant, tenant),
				eq(d1Schema.cacheLifecycle.cacheKind, 'default'),
				isNull(d1Schema.cacheLifecycle.cacheName)
			)
		)
		.get();

	if (row === undefined) {
		throw new CacheCatalogueMigrationError(tenant, 'tenant-missing');
	}

	return row.access;
}

async function d1Lifecycles(
	context: ServerContext,
	tenant: TenantId
): Promise<ReadonlyMap<string, LifecycleRow>> {
	const rows = await context.d1
		.select({
			kind: d1Schema.cacheLifecycle.cacheKind,
			name: d1Schema.cacheLifecycle.cacheName,
			access: d1Schema.cacheLifecycle.access,
			generation: d1Schema.cacheLifecycle.generation,
			deletedAt: d1Schema.cacheLifecycle.deletedAt
		})
		.from(d1Schema.cacheLifecycle)
		.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
		.all();
	const lifecycles = new Map<string, LifecycleRow>();

	for (const row of rows) {
		try {
			const scope = cacheScopeFromRow({ kind: row.kind, name: row.name });
			lifecycles.set(scopeKey(scope), {
				access: cacheAccessModeSchema.parse(row.access),
				generation: row.generation,
				deletedAt: row.deletedAt ?? undefined
			});
		} catch (error) {
			throw new CacheCatalogueMigrationError(
				tenant,
				'lifecycle-invalid',
				error instanceof Error ? error : new Error(String(error))
			);
		}
	}

	return lifecycles;
}

function reconcileLocalCaches(
	context: ServerContext,
	legacyAccess: CacheAccessMode,
	lifecycles: ReadonlyMap<string, LifecycleRow>
): CatalogueEntry[] {
	const defaultLifecycle = lifecycles.get(scopeKey({ kind: 'default' }));

	context.db
		.insert(schema.cacheIdentities)
		.values({
			kind: 'default',
			name: sql<null>`null`,
			access: defaultLifecycle?.access ?? legacyAccess,
			priority: cachePrioritySchema.parse(CacheInfo.default.priority),
			createdAt: isoTimestamp(new Date())
		})
		.onConflictDoNothing()
		.run();

	const entries: CatalogueEntry[] = [];

	// These reads run before the contraction, which is the migration that makes
	// `access` mandatory, so the rows can still hold nulls even though the
	// declared columns say otherwise.
	const storedAccess = sql<CacheAccessMode | null>`${schema.cacheIdentities.access}`;
	const storedViewAccess = sql<CacheAccessMode | null>`${schema.reuseViews.access}`;

	context.db.transaction((transaction) => {
		const rows = transaction
			.select({
				id: schema.cacheIdentities.id,
				kind: schema.cacheIdentities.kind,
				name: schema.cacheIdentities.name,
				access: storedAccess,
				deletedAt: schema.cacheIdentities.deletedAt
			})
			.from(schema.cacheIdentities)
			.all();

		for (const row of rows) {
			const scope = cacheScopeFromRow({ kind: row.kind, name: row.name });
			const lifecycle = lifecycles.get(scopeKey(scope));
			const access = lifecycle?.access ?? row.access ?? legacyAccess;
			const deletedAt = lifecycle?.deletedAt ?? row.deletedAt ?? undefined;

			transaction
				.update(schema.cacheIdentities)
				.set({ access, deletedAt })
				.where(eq(schema.cacheIdentities.id, row.id))
				.run();

			entries.push({
				id: row.id,
				scope,
				access,
				deletedAt,
				generation: lifecycle?.generation ?? cacheGenerationSchema.parse(1)
			});
		}

		const views = transaction
			.select({ name: schema.reuseViews.name, access: storedViewAccess })
			.from(schema.reuseViews)
			.all();

		for (const view of views) {
			// A view stored before reuse views recorded their own access has none,
			// so give it the access of the tenant's default cache.
			if (view.access !== null) {
				continue;
			}

			transaction
				.update(schema.reuseViews)
				.set({ access: legacyAccess })
				.where(eq(schema.reuseViews.name, view.name))
				.run();
		}
	});

	return entries;
}

async function projectCatalogueToD1(
	context: ServerContext,
	tenant: TenantId,
	entries: readonly CatalogueEntry[]
): Promise<void> {
	const now = isoTimestamp(new Date());
	const document = JSON.stringify(
		entries.map((entry) => ({
			kind: entry.scope.kind,
			name: entry.scope.kind === 'named' ? entry.scope.name : undefined,
			access: entry.access,
			generation: entry.generation,
			deletedAt: entry.deletedAt
		}))
	);

	await context.d1.run(sql`
		with incoming as (
			select
				json_extract(value, '$.kind') as kind,
				json_extract(value, '$.name') as name,
				json_extract(value, '$.access') as access,
				json_extract(value, '$.deletedAt') as deleted_at
			from json_each(${document})
		)
		update cache_lifecycle
		set
			access = (select access from incoming where incoming.kind = cache_lifecycle.cache_kind and incoming.name is cache_lifecycle.cache_name),
			deleted_at = (select deleted_at from incoming where incoming.kind = cache_lifecycle.cache_kind and incoming.name is cache_lifecycle.cache_name),
			updated_at = ${now}
		where tenant = ${tenant}
			and exists (select 1 from incoming where incoming.kind = cache_lifecycle.cache_kind and incoming.name is cache_lifecycle.cache_name)
	`);

	await context.d1.run(sql`
		with incoming as (
			select
				json_extract(value, '$.kind') as kind,
				json_extract(value, '$.name') as name,
				json_extract(value, '$.access') as access,
				json_extract(value, '$.generation') as generation,
				json_extract(value, '$.deletedAt') as deleted_at
			from json_each(${document})
		)
		insert into cache_lifecycle (
			tenant, cache_kind, cache_name, access, generation, deleted_at, updated_at
		)
		select ${tenant}, kind, name, access, generation, deleted_at, ${now}
		from incoming
		where not exists (
			select 1 from cache_lifecycle
			where cache_lifecycle.tenant = ${tenant}
				and cache_lifecycle.cache_kind = incoming.kind
				and cache_lifecycle.cache_name is incoming.name
		)
	`);

	await context.d1.run(sql`
		with incoming as (
			select
				json_extract(value, '$.kind') as kind,
				json_extract(value, '$.name') as name
			from json_each(${document})
		)
		update cache_lifecycle
		set
			generation = generation + 1,
			deleted_at = ${now},
			updated_at = ${now}
		where tenant = ${tenant}
			and deleted_at is null
			and not exists (
				select 1 from incoming
				where incoming.kind = cache_lifecycle.cache_kind
					and incoming.name is cache_lifecycle.cache_name
			)
	`);
}

export async function reconcileCacheCatalogue(
	context: ServerContext,
	tenant: TenantId
): Promise<void> {
	const legacyAccess = await defaultCacheAccess(context, tenant);
	const lifecycles = await d1Lifecycles(context, tenant);
	const entries = reconcileLocalCaches(context, legacyAccess, lifecycles);

	await projectCatalogueToD1(context, tenant, entries);
}

/**
 * Whether every cache and reuse view in this object's catalogue records how it
 * reads, and the tenant's one default cache exists.
 *
 * This runs before the contraction, which is the migration that makes those
 * columns mandatory, so the rows it inspects can still hold nulls even though
 * the declared columns say otherwise.
 */
export function isLocalCacheCatalogueComplete(context: ServerContext): boolean {
	const incompleteCaches = context.db
		.select({ count: sql<number>`count(*)`.as('incomplete_cache_count') })
		.from(schema.cacheIdentities)
		.where(sql`${schema.cacheIdentities.access} is null`)
		.as('incomplete_caches');
	const incompleteViews = context.db
		.select({ count: sql<number>`count(*)`.as('incomplete_view_count') })
		.from(schema.reuseViews)
		.where(sql`${schema.reuseViews.access} is null`)
		.as('incomplete_views');
	const defaultCaches = context.db
		.select({ count: sql<number>`count(*)`.as('default_cache_count') })
		.from(schema.cacheIdentities)
		.where(
			sql`${schema.cacheIdentities.kind} = 'default' and ${schema.cacheIdentities.name} is null`
		)
		.as('default_caches');
	const row = context.db
		.select({
			incompleteCaches: incompleteCaches.count,
			incompleteViews: incompleteViews.count,
			defaultCaches: defaultCaches.count
		})
		.from(incompleteCaches)
		.innerJoin(incompleteViews, sql`true`)
		.innerJoin(defaultCaches, sql`true`)
		.get();

	if (row === undefined) {
		return false;
	}

	return (
		row.incompleteCaches === 0 &&
		row.incompleteViews === 0 &&
		row.defaultCaches === 1
	);
}

export async function isCacheCatalogueComplete(
	context: ServerContext,
	tenant: TenantId
): Promise<boolean> {
	const row = await context.d1
		.select({ version: d1Schema.tenant.cacheCatalogueVersion })
		.from(d1Schema.tenant)
		.where(eq(d1Schema.tenant.id, tenant))
		.get();

	return row?.version === cacheCatalogueVersion;
}

export async function markCacheCatalogueComplete(
	context: ServerContext,
	tenant: TenantId
): Promise<void> {
	await context.d1
		.update(d1Schema.tenant)
		.set({ cacheCatalogueVersion })
		.where(eq(d1Schema.tenant.id, tenant));
}
