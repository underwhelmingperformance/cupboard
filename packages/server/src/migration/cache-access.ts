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

import { cacheIdentityColumns, cacheScopeFromRow } from '../db/cache.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import type { ServerContext } from '../do/context.ts';
import { CacheAccessMigrationError } from '../errors.ts';

import * as migrationSchema from './cache-access-schema.ts';

interface LifecycleRow {
	readonly access: CacheAccessMode;
	readonly deletedAt: IsoTimestamp | null;
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
	const identity = cacheIdentityColumns(scope);
	const insert = context.d1.insert(d1Schema.cacheLifecycle).values({
		tenant,
		...identity,
		access,
		generation: cacheGenerationSchema.parse(2),
		deletedAt: now,
		updatedAt: now
	});
	const set = {
		access,
		generation: sql`${d1Schema.cacheLifecycle.generation} + 1`,
		deletedAt: now,
		updatedAt: now
	};

	if (scope.kind === 'default') {
		await insert
			.onConflictDoUpdate({
				target: [d1Schema.cacheLifecycle.tenant],
				targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'default'`,
				set
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
			set
		})
		.run();
}

export async function clearCacheLifecycleDeletion(
	context: ServerContext,
	tenant: TenantId,
	scope: CacheScope,
	access: CacheAccessMode,
	now: IsoTimestamp
): Promise<void> {
	const identity = cacheIdentityColumns(scope);
	const insert = context.d1.insert(d1Schema.cacheLifecycle).values({
		tenant,
		...identity,
		access,
		generation: cacheGenerationSchema.parse(1),
		deletedAt: sql`null`,
		updatedAt: now
	});
	const set = {
		access,
		deletedAt: sql`null`,
		updatedAt: now
	};

	if (scope.kind === 'default') {
		await insert
			.onConflictDoUpdate({
				target: [d1Schema.cacheLifecycle.tenant],
				targetWhere: sql`${d1Schema.cacheLifecycle.cacheKind} = 'default'`,
				set
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
			set
		})
		.run();
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
				deletedAt: row.deletedAt
			});
		} catch (error) {
			throw new CacheAccessMigrationError(
				tenant,
				'invalid-lifecycle',
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
			const deletedAt =
				lifecycle === undefined ? row.deletedAt : lifecycle.deletedAt;

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

export async function migrateLocalCacheAccess(
	context: ServerContext,
	tenant: TenantId
): Promise<void> {
	const lifecycles = await d1Lifecycles(context, tenant);
	const defaultLifecycle = lifecycles.get(scopeKey({ kind: 'default' }));

	if (defaultLifecycle === undefined) {
		throw new CacheAccessMigrationError(tenant, 'missing-default-lifecycle');
	}

	reconcileLocalCaches(context, defaultLifecycle.access, lifecycles);
}

export function isLocalCacheAccessComplete(context: ServerContext): boolean {
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
