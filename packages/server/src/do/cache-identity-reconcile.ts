import { getTableName, type SQL, sql } from 'drizzle-orm';
import { type SQLiteTable } from 'drizzle-orm/sqlite-core';

import * as schema from '../db/schema.ts';

import { type SchemaWriter, type ServerContext } from './context.ts';

const progressKey = 'migration/cache-identity-backfill/v2';
const pageSize = 36;
interface ReferenceProgress {
	afterRowid: number;
	revision: number;
	complete: boolean;
}
interface BackfillProgress {
	readonly identityRevision: number;
	readonly tables: Record<string, ReferenceProgress | undefined>;
}
interface BackfillOutcome {
	readonly processed: number;
	readonly hasMore: boolean;
}
interface StoredRow {
	readonly rowid: number;
}

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

const identityName = sql`case when cache.name like 'private/%' then substr(cache.name, 9) else cache.name end`;
const identityKind = sql`case when cache.name = '' then 'default' else 'named' end`;
const liveIdentity = sql`case when cache.name = '' then
 (select id from cache_identity where deleted_at is null and kind = 'default')
 else (select id from cache_identity where deleted_at is null and kind = 'named' and name = ${identityName}) end`;
const deletedIdentity = sql`select id from cache_identity
 where deleted_at is not null and kind = ${identityKind}
 and name is case when cache.name = '' then null else ${identityName} end
 order by id desc limit 1`;

function reconcileCachePage(database: SchemaWriter): number {
	const rows = database.all<StoredRow>(sql`
  select rowid from cache where migration_identity_id is null limit ${pageSize}
 `);
	for (const row of rows) {
		database.run(sql`
   insert into cache_identity (kind, name, access, priority, grace_managed, created_at)
   select 'named', ${identityName},
    case when cache.name like 'private/%' then 'private' else 'public' end,
    priority, grace_managed, created_at
   from cache
   where rowid = ${row.rowid} and cache.name <> ''
    and (${liveIdentity}) is null
    and coalesce((select deleted_at from cache_identity where id = (${deletedIdentity})), '') < cache.created_at
   on conflict do nothing
  `);
		database.run(sql`
   update cache set migration_identity_id = coalesce((${liveIdentity}), (${deletedIdentity}))
   where rowid = ${row.rowid}
  `);
	}
	return rows.length;
}

function missingRows(table: SQLiteTable): SQL {
	return table === schema.retentionPolicies
		? sql`cache_id is null and scope = 'cache'`
		: sql`cache_id is null`;
}

function reconcileTablePage(
	database: SchemaWriter,
	table: SQLiteTable,
	progress: { readonly afterRowid: number; readonly remaining: number }
): readonly StoredRow[] {
	const rows = database.all<StoredRow>(sql`
  select rowid from ${table}
  where ${missingRows(table)} and rowid > ${progress.afterRowid}
  order by rowid limit ${progress.remaining}
 `);
	const last = rows.at(-1);
	if (last === undefined) {
		return rows;
	}
	const storedName =
		table === schema.retentionPolicies
			? sql`${table}.pattern`
			: sql`${table}.cache`;
	database.run(sql`
  update ${table} set cache_id = case when ${storedName} = '' then
   (select id from cache_identity where deleted_at is null and kind = 'default')
   else (select id from cache_identity where deleted_at is null and kind = 'named'
    and name = case when ${storedName} like 'private/%' then substr(${storedName}, 9) else ${storedName} end)
   end
  where ${missingRows(table)} and rowid > ${progress.afterRowid} and rowid <= ${last.rowid}
 `);
	return rows;
}

function advanceReferenceTable(
	database: SchemaWriter,
	table: SQLiteTable,
	pass: {
		readonly progress: ReferenceProgress;
		readonly revision: number;
		readonly remaining: number;
	}
): number {
	const current = pass.progress;
	if (current.complete) {
		return 0;
	}
	let processed = 0;
	while (processed < pass.remaining) {
		const rows = reconcileTablePage(database, table, {
			afterRowid: current.afterRowid,
			remaining: pass.remaining - processed
		});
		processed += rows.length;
		const last = rows.at(-1);
		if (last !== undefined) {
			current.afterRowid = last.rowid;
			continue;
		}
		if (current.revision !== pass.revision) {
			current.afterRowid = 0;
			current.revision = pass.revision;
			continue;
		}
		current.complete = true;
		break;
	}
	return processed;
}

/**
Advances the legacy cache references by at most one persisted page.
*/
export async function reconcileCacheIdentities(
	context: ServerContext
): Promise<BackfillOutcome> {
	let processed = reconcileCachePage(context.db);
	const stored = await context.ctx.storage.get<BackfillProgress>(progressKey);
	const revisions = new Map(
		context.db
			.select()
			.from(schema.cacheIdentityBackfillRevisions)
			.all()
			.map((row) => [row.tableName, row.revision])
	);
	const identityRevision = revisions.get('cache_identity') ?? 0;
	const progress: BackfillProgress =
		processed === 0 && stored?.identityRevision === identityRevision
			? stored
			: { identityRevision, tables: {} };
	const tables = [...nameKeyedTables, schema.retentionPolicies];
	for (const table of tables) {
		const name = getTableName(table);
		const revision = revisions.get(name) ?? 0;
		const previous = progress.tables[name];
		const current =
			previous === undefined ||
			(previous.complete && previous.revision !== revision)
				? { afterRowid: 0, revision, complete: false }
				: previous;
		progress.tables[name] = current;
		processed += advanceReferenceTable(context.db, table, {
			progress: current,
			revision,
			remaining: pageSize - processed
		});
	}
	const hasMore =
		Object.values(progress.tables).some(
			(table) => table !== undefined && !table.complete
		) ||
		context.db.all(
			sql`select 1 from cache where migration_identity_id is null limit 1`
		).length > 0;
	if (hasMore) {
		await context.ctx.storage.put(progressKey, progress);
		return { processed, hasMore: true };
	}
	await context.ctx.storage.delete(progressKey);
	return { processed, hasMore: false };
}
