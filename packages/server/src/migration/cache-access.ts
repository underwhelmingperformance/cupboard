import { CacheInfo } from '@cupboard/nix-store/cache-info';
import {
	type CacheAccessMode,
	cacheGenerationSchema,
	cachePrioritySchema,
	type CacheScope,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp, isoTimestamp } from '@cupboard/protocol/scalars';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
	cacheIdentityColumns,
	cacheIdentityCondition,
	cacheScopeFromRow,
	legacyCacheKey
} from '../db/cache.ts';
import * as schema from '../db/schema.ts';
import type { ServerContext } from '../do/context.ts';
import { jsonValueLists } from '../do/json-list.ts';
import { CacheCatalogueMigrationError } from '../errors.ts';

import * as migrationSchema from './cache-access-schema.ts';
import {
	afterLifecycleKey,
	lifecycleKey as scopeKey
} from './lifecycle-cursor.ts';
import { readCacheLifecycles } from './lifecycle-read.ts';

export const cacheCatalogueVersion = 2;

interface CatalogueEntry {
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
	readonly deletedAt: IsoTimestamp | undefined;
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

const cacheCatalogueBatchSize = 36;

export type CacheCatalogueOutcome =
	{ readonly status: 'pending' } | { readonly status: 'complete' };

const progressKey = 'migration/cache-catalogue/v2';
const progressSchema = z.discriminatedUnion('phase', [
	z.object({
		phase: z.literal('local'),
		afterId: z.number().int().nonnegative()
	}),
	z.object({ phase: z.literal('views'), afterName: z.string() }),
	z.object({ phase: z.literal('remote'), afterKey: z.string() })
]);

async function reconcileLocalPage(
	context: ServerContext,
	tenant: TenantId,
	legacyAccess: CacheAccessMode,
	afterId: number
): Promise<CacheCatalogueOutcome> {
	const rows = context.db
		.select({
			id: schema.cacheIdentities.id,
			kind: schema.cacheIdentities.kind,
			name: schema.cacheIdentities.name,
			access: sql<CacheAccessMode | null>`${schema.cacheIdentities.access}`,
			deletedAt: schema.cacheIdentities.deletedAt
		})
		.from(schema.cacheIdentities)
		.where(sql`${schema.cacheIdentities.id} > ${afterId}`)
		.orderBy(schema.cacheIdentities.id)
		.limit(cacheCatalogueBatchSize)
		.all();
	const lifecycles = await readCacheLifecycles(
		context,
		tenant,
		rows.map((row) => cacheScopeFromRow(row))
	);
	const byScope = new Map(
		lifecycles.map((row) => [
			scopeKey(cacheScopeFromRow({ kind: row.cacheKind, name: row.cacheName })),
			row
		])
	);
	const missing: CatalogueEntry[] = [];
	context.db.transaction((transaction) => {
		for (const row of rows) {
			const scope = cacheScopeFromRow(row);
			const lifecycle = byScope.get(scopeKey(scope));
			const access = lifecycle?.access ?? row.access ?? legacyAccess;
			const identity = cacheIdentityCondition(
				schema.cacheIdentities.kind,
				schema.cacheIdentities.name,
				scope
			);
			const latestLive = transaction
				.select({ id: schema.cacheIdentities.id })
				.from(schema.cacheIdentities)
				.where(and(identity, isNull(schema.cacheIdentities.deletedAt)))
				.limit(1)
				.get();
			const latestDeleted = transaction
				.select({ id: schema.cacheIdentities.id })
				.from(schema.cacheIdentities)
				.where(
					and(identity, sql`${schema.cacheIdentities.deletedAt} is not null`)
				)
				.orderBy(desc(schema.cacheIdentities.id))
				.limit(1)
				.get();
			const isCurrent =
				Math.max(latestLive?.id ?? 0, latestDeleted?.id ?? 0) === row.id;

			// Historical identities retain their deletion. Only the newest identity
			// can receive the lifecycle of a cache recreated under the same name.
			const deletedAt =
				isCurrent && lifecycle !== undefined
					? lifecycle.deletedAt
					: row.deletedAt;
			transaction
				.update(schema.cacheIdentities)
				.set({
					access,
					deletedAt: deletedAt ?? sql`null`,
					...(isCurrent &&
						lifecycle !== undefined && { generation: lifecycle.generation })
				})
				.where(eq(schema.cacheIdentities.id, row.id))
				.run();
			if (isCurrent && lifecycle === undefined) {
				missing.push({
					scope,
					access,
					deletedAt: row.deletedAt ?? undefined
				});
			}
		}
	});

	const now = isoTimestamp(new Date());
	const document = JSON.stringify(
		missing.map((entry) => ({
			kind: entry.scope.kind,
			name: entry.scope.kind === 'named' ? entry.scope.name : undefined,
			access: entry.access,
			legacyCache: legacyCacheKey(entry.scope, entry.access),
			deletedAt: entry.deletedAt
		}))
	);
	await context.d1.run(sql`
		insert into cache_lifecycle (tenant, cache, cache_kind, cache_name, access, generation, deleted_at, updated_at)
		select ${tenant}, json_extract(value, '$.legacyCache'), json_extract(value, '$.kind'), json_extract(value, '$.name'),
			json_extract(value, '$.access'), 1, json_extract(value, '$.deletedAt'), ${now}
		from json_each(${document}) where true on conflict do nothing
	`);
	const last = rows.at(-1);
	if (last !== undefined) {
		await context.ctx.storage.put(progressKey, {
			phase: 'local',
			afterId: last.id
		});
	}
	return {
		status: rows.length < cacheCatalogueBatchSize ? 'complete' : 'pending'
	};
}

async function reconcileRemotePage(
	context: ServerContext,
	tenant: TenantId,
	afterKey: string
): Promise<CacheCatalogueOutcome> {
	const rows = await context.d1
		.select()
		.from(migrationSchema.cacheLifecycles)
		.where(
			and(
				eq(migrationSchema.cacheLifecycles.tenant, tenant),
				afterLifecycleKey(afterKey)
			)
		)
		.orderBy(
			migrationSchema.cacheLifecycles.cacheKind,
			migrationSchema.cacheLifecycles.cacheName
		)
		.limit(cacheCatalogueBatchSize)
		.all();
	const absent = rows.filter(
		(row) =>
			context.db
				.select({ id: schema.cacheIdentities.id })
				.from(schema.cacheIdentities)
				.where(
					cacheIdentityCondition(
						schema.cacheIdentities.kind,
						schema.cacheIdentities.name,
						cacheScopeFromRow({
							kind: row.cacheKind ?? undefined,
							name: row.cacheName
						})
					)
				)
				.limit(1)
				.get() === undefined
	);
	const document = JSON.stringify(
		absent.map((row) => ({
			kind: row.cacheKind,
			name: row.cacheName,
			updatedAt: row.updatedAt
		}))
	);
	const now = isoTimestamp(new Date());
	await context.d1.run(sql`
		update cache_lifecycle set generation = generation + 1, deleted_at = ${now}, updated_at = ${now}
		where tenant = ${tenant} and cache_kind = 'named'
			and cache_name in (select json_extract(value, '$.name') from json_each(${document}))
			and deleted_at is null and exists (
			select 1 from json_each(${document}) where
				json_extract(value, '$.kind') = cache_lifecycle.cache_kind and
				json_extract(value, '$.name') is cache_lifecycle.cache_name and
				json_extract(value, '$.updatedAt') = cache_lifecycle.updated_at
		)
	`);
	const last = rows.at(-1);
	if (last !== undefined) {
		await context.ctx.storage.put(progressKey, {
			phase: 'remote',
			afterKey: scopeKey(
				cacheScopeFromRow({ kind: last.cacheKind, name: last.cacheName })
			)
		});
	}
	return {
		status: rows.length < cacheCatalogueBatchSize ? 'complete' : 'pending'
	};
}

/**
Advances a bounded catalogue page, retaining progress across object restarts.
*/
export async function reconcileCacheCatalogue(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheCatalogueOutcome> {
	const legacyAccess = await legacyTenantAccess(context, tenant);
	const saved = await context.ctx.storage.get(progressKey);
	const progress =
		saved === undefined
			? { phase: 'local' as const, afterId: 0 }
			: progressSchema.parse(saved);
	if (progress.phase === 'local') {
		context.db
			.insert(schema.cacheIdentities)
			.values({
				kind: 'default',
				name: sql`null`,
				access: legacyAccess,
				priority: cachePrioritySchema.parse(CacheInfo.default.priority),
				createdAt: isoTimestamp(new Date())
			})
			.onConflictDoNothing()
			.run();
		const local = await reconcileLocalPage(
			context,
			tenant,
			legacyAccess,
			progress.afterId
		);
		if (local.status === 'pending') {
			return local;
		}
		await context.ctx.storage.put(progressKey, {
			phase: 'views',
			afterName: ''
		});
	}

	if (progress.phase !== 'remote') {
		const views = context.db
			.select({ name: schema.reuseViews.name })
			.from(schema.reuseViews)
			.where(
				sql`${schema.reuseViews.name} > ${progress.phase === 'views' ? progress.afterName : ''}`
			)
			.orderBy(schema.reuseViews.name)
			.limit(cacheCatalogueBatchSize)
			.all();
		const viewNames = views.map((view) => view.name);
		for (const listed of jsonValueLists(viewNames)) {
			context.db
				.update(schema.reuseViews)
				.set({ access: legacyAccess })
				.where(
					and(
						sql`${schema.reuseViews.access} is null`,
						inArray(schema.reuseViews.name, listed)
					)
				)
				.run();
		}
		const lastView = views.at(-1);
		if (lastView !== undefined && views.length === cacheCatalogueBatchSize) {
			await context.ctx.storage.put(progressKey, {
				phase: 'views',
				afterName: lastView.name
			});
			return { status: 'pending' };
		}
		await context.ctx.storage.put(progressKey, {
			phase: 'remote',
			afterKey: ''
		});
	}
	const remote = await reconcileRemotePage(
		context,
		tenant,
		progress.phase === 'remote' ? progress.afterKey : ''
	);
	if (remote.status === 'pending') {
		return remote;
	}

	await context.ctx.storage.delete(progressKey);
	return { status: 'complete' };
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
