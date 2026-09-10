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
import { eq, sql } from 'drizzle-orm';

import {
	type CacheId,
	cacheIdentityColumns,
	cacheIdentityCondition,
	cacheScopeFromRow
} from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import type { ServerContext } from '../do/context.ts';
import { CacheCatalogueMigrationError } from '../errors.ts';

import * as migrationSchema from './cache-access-schema.ts';

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

function legacyCacheKey(scope: CacheScope, access: CacheAccessMode): string {
	if (scope.kind === 'default') {
		return '';
	}

	return access === 'private' ? `private/${scope.name}` : scope.name;
}

export function cacheMigrationColumns(
	scope: CacheScope,
	access: CacheAccessMode
) {
	return {
		legacyCache: legacyCacheKey(scope, access),
		...cacheIdentityColumns(scope)
	};
}

export async function revokeCacheLifecycle(
	context: ServerContext,
	tenant: TenantId,
	scope: CacheScope,
	access: CacheAccessMode,
	now: IsoTimestamp
): Promise<void> {
	const identity = cacheMigrationColumns(scope, access);
	const updated = await context.d1
		.update(migrationSchema.cacheLifecycles)
		.set({
			legacyCache: identity.legacyCache,
			access,
			generation: sql`${migrationSchema.cacheLifecycles.generation} + 1`,
			deletedAt: now,
			updatedAt: now
		})
		.where(
			sql`${migrationSchema.cacheLifecycles.tenant} = ${tenant} and ${cacheIdentityCondition(migrationSchema.cacheLifecycles.cacheKind, migrationSchema.cacheLifecycles.cacheName, scope)}`
		)
		.run();

	if (updated.meta.changes > 0) {
		return;
	}

	await context.d1.insert(migrationSchema.cacheLifecycles).values({
		tenant,
		...identity,
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
	const identity = cacheMigrationColumns(scope, access);
	const updated = await context.d1
		.update(migrationSchema.cacheLifecycles)
		.set({
			legacyCache: identity.legacyCache,
			access,
			deletedAt: sql`null`,
			updatedAt: now
		})
		.where(
			sql`${migrationSchema.cacheLifecycles.tenant} = ${tenant} and ${cacheIdentityCondition(migrationSchema.cacheLifecycles.cacheKind, migrationSchema.cacheLifecycles.cacheName, scope)}`
		)
		.run();

	if (updated.meta.changes > 0) {
		return;
	}

	await context.d1.insert(migrationSchema.cacheLifecycles).values({
		tenant,
		...identity,
		access,
		generation: cacheGenerationSchema.parse(1),
		deletedAt: sql`null`,
		updatedAt: now
	});
}

async function legacyTenantAccess(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheAccessMode> {
	const row = await context.d1
		.select({ readMode: migrationSchema.tenants.readMode })
		.from(migrationSchema.tenants)
		.where(eq(migrationSchema.tenants.id, tenant))
		.get();

	if (row === undefined) {
		throw new CacheCatalogueMigrationError(tenant, 'tenant-missing');
	}

	return row.readMode;
}

async function d1Lifecycles(
	context: ServerContext,
	tenant: TenantId
): Promise<ReadonlyMap<string, LifecycleRow>> {
	const rows = await context.d1
		.select({
			kind: migrationSchema.cacheLifecycles.cacheKind,
			name: migrationSchema.cacheLifecycles.cacheName,
			access: migrationSchema.cacheLifecycles.access,
			generation: migrationSchema.cacheLifecycles.generation,
			deletedAt: migrationSchema.cacheLifecycles.deletedAt
		})
		.from(migrationSchema.cacheLifecycles)
		.where(eq(migrationSchema.cacheLifecycles.tenant, tenant))
		.all();
	const lifecycles = new Map<string, LifecycleRow>();

	for (const row of rows) {
		if (row.kind === null || row.access === null) {
			throw new CacheCatalogueMigrationError(tenant, 'lifecycle-incomplete');
		}

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
		.insert(migrationSchema.cacheIdentities)
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

	context.db.transaction((transaction) => {
		const rows = transaction
			.select()
			.from(migrationSchema.cacheIdentities)
			.all();

		for (const row of rows) {
			const scope = cacheScopeFromRow({ kind: row.kind, name: row.name });
			const lifecycle = lifecycles.get(scopeKey(scope));
			const access = lifecycle?.access ?? row.access ?? legacyAccess;
			const deletedAt = lifecycle?.deletedAt ?? row.deletedAt ?? undefined;

			transaction
				.update(migrationSchema.cacheIdentities)
				.set({ access, deletedAt })
				.where(eq(migrationSchema.cacheIdentities.id, row.id))
				.run();

			entries.push({
				id: row.id,
				scope,
				access,
				deletedAt,
				generation: lifecycle?.generation ?? cacheGenerationSchema.parse(1)
			});
		}

		const views = transaction.select().from(migrationSchema.reuseViews).all();

		for (const view of views) {
			if (view.access !== null) {
				continue;
			}

			transaction
				.update(migrationSchema.reuseViews)
				.set({ access: legacyAccess })
				.where(eq(migrationSchema.reuseViews.name, view.name))
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
			legacyCache: legacyCacheKey(entry.scope, entry.access),
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
				json_extract(value, '$.legacyCache') as legacy_cache,
				json_extract(value, '$.deletedAt') as deleted_at
			from json_each(${document})
		)
		update cache_lifecycle
		set
			cache = (select legacy_cache from incoming where incoming.kind = cache_lifecycle.cache_kind and incoming.name is cache_lifecycle.cache_name),
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
				json_extract(value, '$.legacyCache') as legacy_cache,
				json_extract(value, '$.generation') as generation,
				json_extract(value, '$.deletedAt') as deleted_at
			from json_each(${document})
		)
		insert into cache_lifecycle (
			tenant, cache, cache_kind, cache_name, access, generation, deleted_at, updated_at
		)
		select ${tenant}, legacy_cache, kind, name, access, generation, deleted_at, ${now}
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
	const legacyAccess = await legacyTenantAccess(context, tenant);
	const lifecycles = await d1Lifecycles(context, tenant);
	const entries = reconcileLocalCaches(context, legacyAccess, lifecycles);

	await projectCatalogueToD1(context, tenant, entries);
}

export function isLocalCacheCatalogueComplete(context: ServerContext): boolean {
	const incompleteCaches = context.db
		.select({ count: sql<number>`count(*)`.as('incomplete_cache_count') })
		.from(schema.caches)
		.where(sql`${schema.caches.access} is null`)
		.as('incomplete_caches');
	const incompleteViews = context.db
		.select({ count: sql<number>`count(*)`.as('incomplete_view_count') })
		.from(schema.reuseViews)
		.where(sql`${schema.reuseViews.access} is null`)
		.as('incomplete_views');
	const defaultCaches = context.db
		.select({ count: sql<number>`count(*)`.as('default_cache_count') })
		.from(schema.caches)
		.where(
			sql`${schema.caches.kind} = 'default' and ${schema.caches.name} is null`
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
		.select({ version: migrationSchema.tenants.cacheCatalogueVersion })
		.from(migrationSchema.tenants)
		.where(eq(migrationSchema.tenants.id, tenant))
		.get();

	return row?.version === cacheCatalogueVersion;
}

export async function markCacheCatalogueComplete(
	context: ServerContext,
	tenant: TenantId
): Promise<void> {
	await context.d1
		.update(migrationSchema.tenants)
		.set({ cacheCatalogueVersion })
		.where(eq(migrationSchema.tenants.id, tenant));
}
