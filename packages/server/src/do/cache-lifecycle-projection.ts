import {
	type CacheAccessMode,
	type CacheGeneration,
	type CacheScope,
	firstCacheGeneration,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { cacheScopeFromRow } from '../db/cache.ts';
import { firstCacheReadRevision } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import { readCacheLifecycles } from '../migration/lifecycle-read.ts';

import { type ServerContext } from './context.ts';
import { jsonRowLists } from './json-list.ts';

// The most caches one wake projects. A tenant with more missing rows finishes
// over subsequent wakes.
export const maxCachesProjectedPerRun = 36;
const projectionProgressKey = 'migration/lifecycle-projection/v2';

export async function resetCacheLifecycleProjection(
	context: ServerContext
): Promise<void> {
	await context.ctx.storage.delete(projectionProgressKey);
}

export interface CacheLifecycleRecord {
	readonly scope: CacheScope;
	readonly generation: CacheGeneration;
	readonly isLive: boolean;
}

export interface CacheProjectionOutcome {
	readonly lifecycles: readonly CacheLifecycleRecord[];
	readonly projected: number;
	readonly hasMore: boolean;
	/**
	 * Whether this call saved the projection's cursor. It is false only when
	 * an earlier call finished the projection.
	 */
	readonly progressed: boolean;
}

interface LocalCache {
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
}

function identityKey(scope: CacheScope): string {
	return scope.kind === 'default' ? 'default' : `named\0${scope.name}`;
}

/**
 * Writes the missing `cache_lifecycle` rows for this tenant's live caches, up
 * to {@link maxCachesProjectedPerRun} of them per call.
 *
 * Older builds did not create a lifecycle row when registering an empty
 * cache. Fill those gaps so D1 records every live cache in the local catalogue.
 *
 * A tenant with more caches than fit one call keeps rows to project. The
 * caller then leaves the local step unrecorded, so the control plane wakes
 * the object again.
 */
export async function projectLocalCacheLifecycles(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheProjectionOutcome> {
	const saved = z
		.union([z.number().int().nonnegative(), z.literal('complete')])
		.parse((await context.ctx.storage.get(projectionProgressKey)) ?? 0);
	if (saved === 'complete') {
		return { lifecycles: [], projected: 0, hasMore: false, progressed: false };
	}
	const afterId = saved;
	const localRows = context.db
		.select({
			id: schema.cacheIdentities.id,
			kind: schema.cacheIdentities.kind,
			name: schema.cacheIdentities.name,
			access: schema.cacheIdentities.access,
			deletedAt: schema.cacheIdentities.deletedAt
		})
		.from(schema.cacheIdentities)
		.where(sql`${schema.cacheIdentities.id} > ${afterId}`)
		.orderBy(schema.cacheIdentities.id)
		.limit(maxCachesProjectedPerRun)
		.all();
	const local: LocalCache[] = localRows
		.filter((row) => row.deletedAt === null)
		.map((row) => ({
			scope: cacheScopeFromRow(row),
			access: row.access
		}));
	const projected = await readCacheLifecycles(
		context,
		tenant,
		local.map((cache) => cache.scope)
	);
	const known = new Set<string>(
		projected.map((row) =>
			identityKey(
				cacheScopeFromRow({ kind: row.cacheKind, name: row.cacheName })
			)
		)
	);
	const missing = local.filter((cache) => !known.has(identityKey(cache.scope)));
	const now = isoTimestamp(new Date());
	const projecting = missing.slice(0, maxCachesProjectedPerRun);
	// JSON list values cannot be null. Cache names are non-empty, so an empty
	// string can represent the default cache and is restored to null in SQL.
	const listed = projecting.map((cache) => ({
		cacheKind: cache.scope.kind,
		cacheName: cache.scope.kind === 'named' ? cache.scope.name : '',
		access: cache.access
	}));

	for (const rows of jsonRowLists(listed)) {
		await context.d1
			.insert(d1Schema.cacheLifecycle)
			.select(
				rows.insertSource([
					sql`${tenant}`,
					rows.column('cacheKind'),
					sql`nullif(${rows.column('cacheName')}, '')`,
					rows.column('access'),
					sql`${firstCacheGeneration}`,
					sql`${firstCacheReadRevision}`,
					sql`null`,
					sql`${now}`
				])
			)
			.onConflictDoNothing()
			.run();
	}

	const last = localRows.at(-1);
	if (last !== undefined && localRows.length === maxCachesProjectedPerRun) {
		await context.ctx.storage.put(projectionProgressKey, last.id);
	} else {
		await context.ctx.storage.put(projectionProgressKey, 'complete');
	}
	return {
		lifecycles: projected.map((row) => ({
			scope: cacheScopeFromRow({ kind: row.cacheKind, name: row.cacheName }),
			generation: row.generation,
			isLive: row.deletedAt === null
		})),
		projected: Math.min(missing.length, maxCachesProjectedPerRun),
		hasMore: localRows.length === maxCachesProjectedPerRun,
		progressed: true
	};
}
