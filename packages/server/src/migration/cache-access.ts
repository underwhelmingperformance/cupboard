import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cacheAccessModeSchema,
	type CacheGeneration,
	cacheGenerationSchema,
	cachePrioritySchema,
	type CacheReadRevision,
	cacheReadRevisionSchema,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { eq, sql } from 'drizzle-orm';
import type { SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';

import {
	cacheIdentityColumns,
	cacheScopeFromRow,
	type ResolvedCache
} from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import type { ServerContext } from '../do/context.ts';
import { CacheCatalogueMigrationError } from '../errors.ts';

import * as migrationSchema from './cache-access-schema.ts';

export const cacheCatalogueVersion = 1;

interface LifecycleRow {
	readonly access: CacheAccessMode;
	readonly deletedAt: IsoTimestamp | undefined;
}

export interface CacheLifecycleVersion {
	readonly generation: CacheGeneration;
	readonly readRevision: CacheReadRevision;
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
	cache: Pick<
		ResolvedCache,
		'scope' | 'access' | 'generation' | 'readRevision'
	>,
	now: IsoTimestamp
): Promise<void> {
	const identity = cacheIdentityColumns(cache.scope);
	const set: SQLiteUpdateSetSource<typeof d1Schema.cacheLifecycle> = {
		access: cache.access,
		generation: sql`${d1Schema.cacheLifecycle.generation} + 1`,
		readRevision: sql`${d1Schema.cacheLifecycle.readRevision} + 1`,
		state: sql`case when ${d1Schema.cacheLifecycle.managementKind} = 'managed' then 'retiring' else 'deleted' end`,
		creationExpiresAt: sql`null`,
		leaseExpiresAt: sql`case when ${d1Schema.cacheLifecycle.managementKind} = 'managed' then coalesce(${d1Schema.cacheLifecycle.leaseExpiresAt}, ${now}) else null end`,
		deletedAt: now,
		updatedAt: now
	};
	const insert = context.d1.insert(d1Schema.cacheLifecycle).values({
		tenant,
		...identity,
		access: cache.access,
		generation: cacheGenerationSchema.parse(cache.generation + 1),
		readRevision: cacheReadRevisionSchema.parse(cache.readRevision + 1),
		state: 'deleted',
		managementKind: 'durable',
		deletedAt: now,
		updatedAt: now
	});

	if (cache.scope.kind === 'default') {
		await insert
			.onConflictDoUpdate({
				target: [d1Schema.cacheLifecycle.tenant],
				targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'default'`,
				set,
				setWhere: eq(d1Schema.cacheLifecycle.generation, cache.generation)
			})
			.run();
		return;
	}

	await insert
		.onConflictDoUpdate({
			target: [
				d1Schema.cacheLifecycle.tenant,
				d1Schema.cacheLifecycle.cacheName
			],
			targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'named'`,
			set,
			setWhere: eq(d1Schema.cacheLifecycle.generation, cache.generation)
		})
		.run();
}

export async function clearCacheLifecycleDeletion(
	context: ServerContext,
	tenant: TenantId,
	scope: CacheScope,
	access: CacheAccessMode,
	now: IsoTimestamp
): Promise<CacheLifecycleVersion> {
	const identity = cacheIdentityColumns(scope);
	const insert = context.d1.insert(d1Schema.cacheLifecycle).values({
		tenant,
		...identity,
		access,
		generation: cacheGenerationSchema.parse(1),
		readRevision: cacheReadRevisionSchema.parse(1),
		state: 'active',
		managementKind: 'durable',
		deletedAt: sql`null`,
		updatedAt: now
	});
	const set: SQLiteUpdateSetSource<typeof d1Schema.cacheLifecycle> = {
		access,
		readRevision: sql<CacheReadRevision>`case when ${d1Schema.cacheLifecycle.access} <> ${access} then ${d1Schema.cacheLifecycle.readRevision} + 1 else ${d1Schema.cacheLifecycle.readRevision} end`,
		state: 'active',
		creationExpiresAt: sql`null`,
		managementKind: 'durable',
		managedPolicyId: sql`null`,
		managedPolicyRevision: sql`null`,
		managedGroupId: sql`null`,
		leaseExpiresAt: sql`null`,
		selectionState: sql`null`,
		updateHold: false,
		deletedAt: sql`null`,
		updatedAt: now
	};
	const returned = {
		generation: d1Schema.cacheLifecycle.generation,
		readRevision: d1Schema.cacheLifecycle.readRevision
	};

	if (scope.kind === 'default') {
		const row = await insert
			.onConflictDoUpdate({
				target: [d1Schema.cacheLifecycle.tenant],
				targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'default'`,
				set
			})
			.returning(returned)
			.get();

		return row;
	}

	const row = await insert
		.onConflictDoUpdate({
			target: [
				d1Schema.cacheLifecycle.tenant,
				d1Schema.cacheLifecycle.cacheName
			],
			targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'named'`,
			set
		})
		.returning(returned)
		.get();

	return row;
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
	defaultAccess: CacheAccessMode,
	lifecycles: ReadonlyMap<string, LifecycleRow>
): void {
	context.db
		.insert(migrationSchema.cacheIdentities)
		.values({
			kind: 'default',
			name: sql<null>`null`,
			access: defaultAccess,
			priority: cachePrioritySchema.parse(CacheInfo.default.priority),
			createdAt: isoTimestamp(new Date())
		})
		.onConflictDoNothing()
		.run();

	context.db.transaction((transaction) => {
		const rows = transaction
			.select()
			.from(migrationSchema.cacheIdentities)
			.all();

		for (const row of rows) {
			const scope = cacheScopeFromRow({ kind: row.kind, name: row.name });
			const lifecycle = lifecycles.get(scopeKey(scope));
			const access = lifecycle?.access ?? row.access ?? defaultAccess;
			const deletedAt = lifecycle?.deletedAt ?? row.deletedAt ?? undefined;

			transaction
				.update(migrationSchema.cacheIdentities)
				.set({ access, deletedAt })
				.where(eq(migrationSchema.cacheIdentities.id, row.id))
				.run();
		}

		const views = transaction.select().from(migrationSchema.reuseViews).all();

		for (const view of views) {
			if (view.access !== null) {
				continue;
			}

			transaction
				.update(migrationSchema.reuseViews)
				.set({ access: defaultAccess })
				.where(eq(migrationSchema.reuseViews.name, view.name))
				.run();
		}
	});
}

async function projectLocalCacheLifecycles(
	context: ServerContext,
	tenant: TenantId,
	lifecycles: ReadonlyMap<string, LifecycleRow>
): Promise<void> {
	const rows = context.db
		.select({
			kind: migrationSchema.cacheIdentities.kind,
			name: migrationSchema.cacheIdentities.name,
			access: migrationSchema.cacheIdentities.access,
			deletedAt: migrationSchema.cacheIdentities.deletedAt
		})
		.from(migrationSchema.cacheIdentities)
		.orderBy(migrationSchema.cacheIdentities.id)
		.all();
	const current = new Map<
		string,
		{ readonly row: (typeof rows)[number]; readonly incarnations: number }
	>();

	for (const row of rows) {
		const scope = cacheScopeFromRow({ kind: row.kind, name: row.name });
		const key = scopeKey(scope);
		const existing = current.get(key);
		current.set(key, {
			row,
			incarnations: (existing?.incarnations ?? 0) + 1
		});
	}

	for (const { row, incarnations } of current.values()) {
		const scope = cacheScopeFromRow({ kind: row.kind, name: row.name });

		if (lifecycles.has(scopeKey(scope))) {
			continue;
		}

		const access = cacheAccessModeSchema.parse(row.access);
		await context.d1
			.insert(d1Schema.cacheLifecycle)
			.values({
				tenant,
				...cacheIdentityColumns(scope),
				access,
				generation: cacheGenerationSchema.parse(
					incarnations + (row.deletedAt === null ? 0 : 1)
				),
				readRevision: cacheReadRevisionSchema.parse(1),
				deletedAt: row.deletedAt,
				updatedAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();
	}
}

export async function reconcileCacheCatalogue(
	context: ServerContext,
	tenant: TenantId
): Promise<void> {
	const lifecycles = await d1Lifecycles(context, tenant);
	const defaultLifecycle = lifecycles.get(scopeKey({ kind: 'default' }));

	if (defaultLifecycle === undefined) {
		throw new CacheCatalogueMigrationError(tenant, 'lifecycle-incomplete');
	}

	reconcileLocalCaches(context, defaultLifecycle.access, lifecycles);
	await projectLocalCacheLifecycles(context, tenant, lifecycles);
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
