import { rootLogger } from '@cupboard/logger';
import {
	type RootName,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import {
	and,
	count,
	eq,
	inArray,
	isNotNull,
	isNull,
	type SQL,
	sql
} from 'drizzle-orm';

import { type CacheId, type ResolvedCache } from '../db/cache.ts';
import {
	type RootIncarnation,
	rootIncarnationSchema
} from '../db/root-incarnation.ts';
import * as schema from '../db/schema.ts';

import { type SchemaWriter } from './context.ts';
import {
	jsonRowLists,
	type JsonValueList,
	jsonValueLists
} from './json-list.ts';
import { type RetentionService } from './retention-service.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

const targets = schema.retentionRootTargets;
const roots = schema.retentionRoots;
const releases = schema.retentionRootReleases;

/**
A root's identity and the incarnation whose target rows it keeps. A root
without an incarnation keeps the target rows that have none.
*/
export interface RootIncarnationKey {
	readonly cacheId: CacheId;
	readonly name: RootName;
	readonly incarnation: RootIncarnation | undefined;
}

/**
Selects the target rows that a root keeps.

Rows of a positive incarnation are found through
`retention_root_target_incarnation_idx`, so the query reads no row of a
released incarnation of the same root. A root without an incarnation has
only rows without one under its name, because every root that is replaced
or recreated gets an incarnation, so its rows are found through the primary
key.
*/
export function liveRootTargets(root: RootIncarnationKey): SQL | undefined {
	if (root.incarnation === undefined) {
		return and(
			eq(targets.cacheId, root.cacheId),
			eq(targets.rootName, root.name),
			isNull(targets.incarnation)
		);
	}

	return eq(targets.incarnation, root.incarnation);
}

/**
Counts the target rows that each `retention_root` row of the enclosing query
keeps. Each branch reads only the rows that it counts. The column names are
qualified by table because Drizzle leaves a column of the query's only table
unqualified, and an unqualified name inside the subquery would refer to the
subquery's table.
*/
export function liveRootTargetCount(): SQL<number> {
	return sql<number>`CASE WHEN retention_root.incarnation IS NULL
		THEN (SELECT count(*) FROM retention_root_target AS target WHERE target.cache_id = retention_root.cache_id AND target.root_name = retention_root.name AND target.incarnation IS NULL)
		ELSE (SELECT count(*) FROM retention_root_target AS target WHERE target.incarnation = retention_root.incarnation) END`;
}

/**
The number of target rows that each `retention_root` row of the enclosing
query keeps. A root with a stored count costs no target row. SQLite
evaluates the `ELSE` branch only for a root without one, which the backfill
has not reached yet.
*/
export function rootTargetCount(): SQL<number> {
	return sql<number>`CASE WHEN retention_root.target_count IS NOT NULL
		THEN retention_root.target_count
		ELSE ${liveRootTargetCount()} END`;
}

/**
Allocates an incarnation for a new or replaced root from the tenant's work
sequence, so no other root of the tenant has the same one.
*/
export function allocateRootIncarnation(
	database: SchemaWriter
): RootIncarnation {
	return rootIncarnationSchema.parse(
		new WorkSequenceService(database).allocate()
	);
}

/**
Reads the identity and incarnation of a root that exists.
*/
export function existingRootIncarnationKey(
	database: SchemaWriter,
	cacheId: CacheId,
	name: RootName
): RootIncarnationKey | undefined {
	const row = database
		.select({ incarnation: roots.incarnation })
		.from(roots)
		.where(and(eq(roots.cacheId, cacheId), eq(roots.name, name)))
		.get();

	return row === undefined
		? undefined
		: { cacheId, name, incarnation: row.incarnation ?? undefined };
}

/**
Selects each requested row of a root's name whose incarnation differs from
the root's, joined to the pending release of the row's incarnation. The
drain test imports this builder to check its query plan.
*/
export function takenTargetReleasesSelect(
	database: SchemaWriter,
	root: RootIncarnationKey,
	hashes: JsonValueList<StorePathHash>
) {
	const incarnation =
		root.incarnation === undefined ? sql`NULL` : sql`${root.incarnation}`;

	return database
		.select({
			storePathHash: targets.storePathHash,
			id: releases.id,
			releasedAt: releases.releasedAt,
			retainUntil: releases.retainUntil,
			closeRetentionEpoch: releases.closeRetentionEpoch
		})
		.from(targets)
		.innerJoin(
			releases,
			and(
				eq(releases.cacheId, targets.cacheId),
				eq(releases.rootName, targets.rootName),
				sql`${releases.incarnation} IS ${targets.incarnation}`
			)
		)
		.where(
			and(
				eq(targets.cacheId, root.cacheId),
				eq(targets.rootName, root.name),
				inArray(targets.storePathHash, hashes),
				sql`${targets.incarnation} IS NOT ${incarnation}`
			)
		);
}

// Grants each requested path the deadline of the pending release that has the
// path's row. It must run before the upsert, which moves the row into the
// root's incarnation. After the move, this query cannot find the row's release.
function grantTakenTargets(
	database: SchemaWriter,
	retention: RetentionService,
	cache: ResolvedCache,
	root: RootIncarnationKey,
	hashes: readonly StorePathHash[]
): void {
	const taken = new Map<
		number,
		{
			readonly releasedAt: IsoTimestamp;
			readonly retainUntil: IsoTimestamp;
			readonly closeRetentionEpoch: number | undefined;
			readonly hashes: StorePathHash[];
		}
	>();

	for (const list of jsonValueLists(hashes)) {
		const rows = takenTargetReleasesSelect(database, root, list).all();

		for (const row of rows) {
			if (row.retainUntil === null) {
				continue;
			}

			const release = taken.get(row.id) ?? {
				releasedAt: row.releasedAt,
				retainUntil: row.retainUntil,
				closeRetentionEpoch: row.closeRetentionEpoch ?? undefined,
				hashes: []
			};
			release.hashes.push(row.storePathHash);
			taken.set(row.id, release);
		}
	}

	for (const { hashes: released, ...release } of taken.values()) {
		retention.extendReleasedGraceDeadlines(cache, released, release, database);
	}
}

interface RootTargetEntry {
	readonly storePathHash: StorePathHash;
	readonly storePath: StorePathString;
}

// A row that the root's name already has under another incarnation moves into
// the root's incarnation, so the drain of that earlier incarnation's release
// no longer deletes it, and the path gets that release's deadline here
// instead. A row that the root already keeps is left unchanged.
function upsertRootTargets(
	database: SchemaWriter,
	retention: RetentionService,
	cache: ResolvedCache,
	root: RootIncarnationKey,
	entries: readonly RootTargetEntry[]
): void {
	const incarnation =
		root.incarnation === undefined ? sql`NULL` : sql`${root.incarnation}`;

	grantTakenTargets(
		database,
		retention,
		cache,
		root,
		entries.map((entry) => entry.storePathHash)
	);

	for (const batch of jsonRowLists(entries)) {
		database
			.insert(targets)
			.select(
				batch.insertSource([
					sql`${root.cacheId}`,
					sql`${root.name}`,
					batch.column('storePathHash'),
					batch.column('storePath'),
					incarnation
				])
			)
			.onConflictDoUpdate({
				target: [targets.cacheId, targets.rootName, targets.storePathHash],
				set: {
					incarnation: sql`excluded.incarnation`,
					storePath: sql`excluded.store_path`
				},
				setWhere: sql`${targets.incarnation} IS NOT excluded.incarnation OR ${targets.storePath} IS NOT excluded.store_path`
			})
			.run();
	}
}

// How many of the paths the root already keeps. Each list is read through the
// root's rows for its paths, so the count reads no other row of the root.
function keptTargetCount(
	database: SchemaWriter,
	root: RootIncarnationKey,
	hashes: readonly StorePathHash[]
): number {
	let kept = 0;

	for (const list of jsonValueLists(hashes)) {
		kept +=
			database
				.select({ count: count() })
				.from(targets)
				.where(and(liveRootTargets(root), inArray(targets.storePathHash, list)))
				.get()?.count ?? 0;
	}

	return kept;
}

/**
Writes the targets of a root's new incarnation, which has no target row yet,
as `upsertRootTargets` describes. The caller stores the number of entries as
the root's `target_count` in the statement that gives the root the
incarnation. The entries must have distinct paths, as `resolveRootTargets`
returns them.
*/
export function insertNewIncarnationTargets(
	database: SchemaWriter,
	retention: RetentionService,
	cache: ResolvedCache,
	root: RootIncarnationKey,
	entries: readonly RootTargetEntry[]
): void {
	upsertRootTargets(database, retention, cache, root, entries);
}

/**
Adds paths to the target rows that a root keeps, as `upsertRootTargets`
describes, and adds the number of paths that the root did not keep yet to
the root's `target_count`.
*/
export function insertLiveRootTargets(
	database: SchemaWriter,
	retention: RetentionService,
	cache: ResolvedCache,
	root: RootIncarnationKey,
	entries: readonly RootTargetEntry[]
): void {
	const hashes = [...new Set(entries.map((entry) => entry.storePathHash))];
	const added = hashes.length - keptTargetCount(database, root, hashes);

	upsertRootTargets(database, retention, cache, root, entries);

	if (added === 0) {
		return;
	}

	database
		.update(roots)
		.set({ targetCount: sql`${roots.targetCount} + ${added}` })
		.where(
			and(
				eq(roots.cacheId, root.cacheId),
				eq(roots.name, root.name),
				isNotNull(roots.targetCount)
			)
		)
		.run();
}

/**
Deletes the target rows of a path in every root of a cache, and subtracts
one from the `target_count` of each root whose incarnation kept a deleted
row. A row of a released incarnation counts for no root.
*/
export function deletePathTargets(
	database: SchemaWriter,
	cacheId: CacheId,
	storePathHash: StorePathHash
): void {
	const deleted = database
		.delete(targets)
		.where(
			and(
				eq(targets.cacheId, cacheId),
				eq(targets.storePathHash, storePathHash)
			)
		)
		.returning({ rootName: targets.rootName, incarnation: targets.incarnation })
		.all();

	if (deleted.length === 0) {
		return;
	}

	// The primary key has the root name, so a name has at most one deleted row.
	const deletedIncarnations = new Map(
		deleted.map((row) => [row.rootName, row.incarnation])
	);
	const deletedNames = deletedIncarnations.keys().toArray();
	const losing: RootName[] = [];

	for (const names of jsonValueLists(deletedNames)) {
		const rows = database
			.select({ name: roots.name, incarnation: roots.incarnation })
			.from(roots)
			.where(and(eq(roots.cacheId, cacheId), inArray(roots.name, names)))
			.all();

		for (const root of rows) {
			if (deletedIncarnations.get(root.name) === root.incarnation) {
				losing.push(root.name);
			}
		}
	}

	for (const names of jsonValueLists(losing)) {
		database
			.update(roots)
			.set({ targetCount: sql`${roots.targetCount} - 1` })
			.where(
				and(
					eq(roots.cacheId, cacheId),
					inArray(roots.name, names),
					isNotNull(roots.targetCount)
				)
			)
			.run();
	}
}

/**
Logs an attach that adds no target because its root no longer exists. A
removal or an expiry can delete the root between a run's negotiation and
the attach of one of its paths. The path is already published by then, and
the run's next negotiation binds the root again.
*/
export function warnRootMissing(
	root: { readonly cacheId: CacheId; readonly name: RootName },
	targetCount: number
): void {
	rootLogger().warn('run-root targets not attached: the root does not exist', {
		cacheId: root.cacheId,
		rootName: root.name,
		targets: targetCount
	});
}
