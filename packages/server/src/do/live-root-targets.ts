import { rootLogger } from '@cupboard/logger';
import {
	type RootName,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';

import { type CacheId } from '../db/cache.ts';
import {
	type RootIncarnation,
	rootIncarnationSchema
} from '../db/root-incarnation.ts';
import * as schema from '../db/schema.ts';

import { type SchemaWriter } from './context.ts';
import { jsonRowLists } from './json-list.ts';
import { WorkSequenceService } from './work-sequence-service.ts';

const targets = schema.retentionRootTargets;
const roots = schema.retentionRoots;

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
Reads a root's identity and incarnation. A name without a root row reads as
a root without an incarnation, so it includes the rows that a late attach by
an earlier version of cupboard left under the name.
*/
export function rootIncarnationKey(
	database: SchemaWriter,
	cacheId: CacheId,
	name: RootName
): RootIncarnationKey {
	return (
		existingRootIncarnationKey(database, cacheId, name) ?? {
			cacheId,
			name,
			incarnation: undefined
		}
	);
}

/**
Adds paths to the target rows that a root keeps. A row that the root's name
already has under another incarnation moves into the root's incarnation, so
the drain of that earlier incarnation's release no longer deletes it. A row
that the root already keeps is left unchanged.
*/
export function insertLiveRootTargets(
	database: SchemaWriter,
	root: RootIncarnationKey,
	entries: readonly {
		readonly storePathHash: StorePathHash;
		readonly storePath: StorePathString;
	}[]
): void {
	const incarnation =
		root.incarnation === undefined ? sql`NULL` : sql`${root.incarnation}`;

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
