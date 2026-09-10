import {
	type CacheAccessMode,
	type CacheScope,
	firstCacheGeneration,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { eq, sql } from 'drizzle-orm';

import { cacheScopeFromRow } from '../db/cache.ts';
import { firstCacheReadRevision } from '../db/cache-generation.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';
import { jsonRowLists } from './json-list.ts';

// How many caches one invocation projects. This bounds the work a single wake
// takes on, not the width of a statement: a tenant with more caches than this
// keeps rows to project and finishes over the wakes that follow.
export const maxCachesProjectedPerRun = 36;

export interface CacheProjectionOutcome {
	readonly projected: number;
	readonly hasMore: boolean;
}

interface LocalCache {
	readonly scope: CacheScope;
	readonly access: CacheAccessMode;
}

function identityKey(scope: CacheScope): string {
	return scope.kind === 'default' ? 'default' : `named\0${scope.name}`;
}

/**
 * Writes the missing `cache_lifecycle` rows for this tenant's local caches, up
 * to {@link maxCachesProjectedPerRun} of them per call.
 *
 * Migration `0024_cache_access_backfill` created a `cache_lifecycle` row only
 * for a named cache that a reference or a credential mentioned, so a cache that
 * holds nothing has none. The control plane and the read paths both consult
 * that table, so a cache missing from it is invisible to them.
 *
 * The work is bounded: one read, then at most {@link maxCachesProjectedPerRun}
 * rows, inserted in statements measured against the bound-parameter limit. A
 * tenant with more caches than that keeps rows to project, and the caller
 * leaves the local step unrecorded so the control plane wakes the object again.
 */
export async function projectLocalCacheLifecycles(
	context: ServerContext,
	tenant: TenantId
): Promise<CacheProjectionOutcome> {
	const local: LocalCache[] = context.db
		.select({
			kind: schema.cacheIdentities.kind,
			name: schema.cacheIdentities.name,
			access: schema.cacheIdentities.access
		})
		.from(schema.cacheIdentities)
		.all()
		.map((row) => ({
			scope: cacheScopeFromRow(row),
			access: row.access
		}));
	const projected = await context.d1
		.select({
			kind: d1Schema.cacheLifecycle.cacheKind,
			name: d1Schema.cacheLifecycle.cacheName
		})
		.from(d1Schema.cacheLifecycle)
		.where(eq(d1Schema.cacheLifecycle.tenant, tenant))
		.all();
	const known = new Set<string>(
		projected.map((row) => identityKey(cacheScopeFromRow(row)))
	);
	const missing = local.filter((cache) => !known.has(identityKey(cache.scope)));
	const now = isoTimestamp(new Date());
	const projecting = missing.slice(0, maxCachesProjectedPerRun);
	// The caches travel as one JSON parameter, so a run of any width binds the
	// same parameters. A list value is text or a number, so the default cache's
	// absent name travels as an empty string and the statement writes null back.
	// A cache name has at least one character.
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

	return {
		projected: Math.min(missing.length, maxCachesProjectedPerRun),
		hasMore: missing.length > maxCachesProjectedPerRun
	};
}
