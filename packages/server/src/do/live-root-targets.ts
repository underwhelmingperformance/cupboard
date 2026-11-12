import { type RootName } from '@cupboard/nix-store/scalars';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';

import { type CacheId } from '../db/cache.ts';
import { type RootIncarnation } from '../db/root-incarnation.ts';
import * as schema from '../db/schema.ts';

import { type SchemaWriter } from './context.ts';

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
Reads a root's identity and incarnation. A name without a root row reads as
a root without an incarnation, so target rows that an earlier release left
under the name without a root remain visible.
*/
export function rootIncarnationKey(
	database: SchemaWriter,
	cacheId: CacheId,
	name: RootName
): RootIncarnationKey {
	const row = database
		.select({ incarnation: roots.incarnation })
		.from(roots)
		.where(and(eq(roots.cacheId, cacheId), eq(roots.name, name)))
		.get();

	return { cacheId, name, incarnation: row?.incarnation ?? undefined };
}
