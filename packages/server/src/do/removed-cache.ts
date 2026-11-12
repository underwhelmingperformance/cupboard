import { and, asc, eq, type SQL, sql, type SQLWrapper } from 'drizzle-orm';

import * as schema from '../db/schema.ts';

import { type ServerContext } from './context.ts';

type NarInfoRow = typeof schema.narInfos.$inferSelect;

/**
A position in the walk over every cache's narinfo rows, which visits them in
`(cache_id, store_path_hash)` order.
*/
interface NarInfoWalkPosition {
	readonly cacheId: number;
	readonly storePathHash: string;
}

/**
A condition on `pending_upload` that is false for the uploads of a removed
cache. Verification and its schedule skip those uploads, and the teardown
drain concludes them. The condition reads one `cache_identity` row for each
upload that it tests.
*/
export function pendingUploadOfLiveCache(): SQL {
	return ofLiveCache(schema.pendingUploads.cacheId);
}

/**
A condition on `narinfo` that is false for the rows of a removed cache. The
signing-key backfill neither re-signs those rows nor counts them as
remaining. The condition reads one `cache_identity` row for each row that it
tests.
*/
export function narInfoOfLiveCache(): SQL {
	return ofLiveCache(schema.narInfos.cacheId);
}

function ofLiveCache(cacheId: SQLWrapper): SQL {
	return sql`NOT EXISTS (SELECT 1 FROM ${schema.cacheIdentities} WHERE ${schema.cacheIdentities.id} = ${cacheId} AND ${schema.cacheIdentities.deletedAt} IS NOT NULL)`;
}

/**
Reads up to `limit` narinfo rows after `after` in the walk order, leaving out
the rows of removed caches. Fewer than `limit` rows means that the walk has
reached its end.

A removed cache keeps its rows until the teardown drain deletes them. The
walk reads the first row of each cache that it enters and, for a removed
cache, continues after that cache, so a removed cache costs two row reads
whatever the number of its rows.
*/
export function liveNarInfoPage(
	context: Pick<ServerContext, 'db' | 'cacheRepository'>,
	after: NarInfoWalkPosition | undefined,
	limit: number
): NarInfoRow[] {
	const rows: NarInfoRow[] = [];
	// SQLite seeks on the row-value comparison. It does not seek on the
	// equivalent `cache_id > ? OR (cache_id = ? AND store_path_hash > ?)`,
	// and reads every earlier row of the cursor's cache instead.
	let position: SQL | undefined =
		after === undefined
			? undefined
			: sql`(${schema.narInfos.cacheId}, ${schema.narInfos.storePathHash}) > (${after.cacheId}, ${after.storePathHash})`;

	while (rows.length < limit) {
		const first = context.db
			.select({ cacheId: schema.narInfos.cacheId })
			.from(schema.narInfos)
			.where(position)
			.orderBy(asc(schema.narInfos.cacheId), asc(schema.narInfos.storePathHash))
			.limit(1)
			.get();

		if (first === undefined) {
			return rows;
		}

		position = sql`${schema.narInfos.cacheId} > ${first.cacheId}`;
		if (context.cacheRepository.isRemoved(first.cacheId)) {
			continue;
		}

		const requested = limit - rows.length;
		const page = context.db
			.select()
			.from(schema.narInfos)
			.where(
				and(
					eq(schema.narInfos.cacheId, first.cacheId),
					after?.cacheId === first.cacheId
						? sql`${schema.narInfos.storePathHash} > ${after.storePathHash}`
						: undefined
				)
			)
			.orderBy(asc(schema.narInfos.storePathHash))
			.limit(requested)
			.all();

		rows.push(...page);
	}

	return rows;
}
