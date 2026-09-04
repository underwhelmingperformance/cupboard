import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { sql } from 'drizzle-orm';
import { type SQLiteTable } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema.ts';

import { type SchemaWriter } from './context.ts';

/**
 * The local name a stored cache key gives its identity. `private/` marks the
 * access mode rather than part of the name, so a private cache and a public
 * one of the same name share an identity.
 */
const identityName = sql`case when name like 'private/%' then substr(name, 9) else name end`;

/**
 * Every table that refers to a cache by its legacy stored name and carries a
 * `cache_id` beside it.
 */
const nameKeyedTables: readonly SQLiteTable[] = [
	schema.narInfos,
	schema.pendingUploads,
	schema.pendingAttestations,
	schema.narInfoDeletions,
	schema.retentionRoots,
	schema.retentionRootTargets,
	schema.retentionGrace,
	schema.garbageCollectionRevisions,
	schema.garbageCollectionScans,
	schema.garbageCollectionFrontier,
	schema.garbageCollectionMarks,
	schema.garbageCollectionTenantRuns,
	schema.verificationCursor
];

/**
 * Gives every cache an identity and fills the `cache_id` of every row that
 * still refers to a cache by name alone.
 *
 * Rows can be written before their cache has an identity. The default cache is
 * registered only once something targets it, and a row written with a null
 * `cache_id` under `on conflict do nothing` keeps that null however many times
 * the write runs again. Both leave rows that no forward write repairs.
 *
 * Every statement here works on whole sets, so the cost does not grow with the
 * number of caches a tenant has. This runs on the Durable Object's own SQLite
 * and issues no D1 statement.
 */
export function reconcileCacheIdentities(
	database: SchemaWriter,
	now: IsoTimestamp
): void {
	database.run(sql`
		insert into cache_identity (kind, name, access, priority, created_at)
		select 'default', null, 'public', 40, ${now}
		where not exists (
			select 1 from cache_identity
			where kind = 'default' and deleted_at is null
		)
	`);

	// A local cache row records the stored name, which carries the access mode
	// in its prefix. `on conflict do nothing` covers a tenant that holds both a
	// public and a private cache of one name: they share a single identity.
	database.run(sql`
		insert into cache_identity (kind, name, access, priority, grace_managed, created_at)
		select
			'named',
			${identityName},
			case when name like 'private/%' then 'private' else 'public' end,
			priority,
			grace_managed,
			created_at
		from cache
		where name <> ''
			and not exists (
				select 1 from cache_identity identity
				where identity.kind = 'named'
					and identity.name = ${identityName}
					and identity.deleted_at is null
			)
		on conflict do nothing
	`);

	for (const table of nameKeyedTables) {
		database.run(sql`
			update ${table}
			set cache_id = (
				select id from cache_identity
				where deleted_at is null
					and (
						(${table}.cache = '' and kind = 'default')
						or (
							kind = 'named'
							and name = case
								when ${table}.cache like 'private/%'
									then substr(${table}.cache, 9)
								else ${table}.cache
							end
						)
					)
			)
			where cache_id is null
		`);
	}

	// A retention policy names its cache in `pattern`, and only when its scope
	// is the cache rather than a root-name prefix.
	database.run(sql`
		update retention_policy
		set cache_id = (
			select id from cache_identity
			where deleted_at is null
				and (
					(retention_policy.pattern = '' and kind = 'default')
					or (
						kind = 'named'
						and name = case
							when retention_policy.pattern like 'private/%'
								then substr(retention_policy.pattern, 9)
							else retention_policy.pattern
						end
					)
				)
		)
		where cache_id is null and scope = 'cache'
	`);
}
