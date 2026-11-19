import { and, eq, or, sql, type SQLWrapper } from 'drizzle-orm';

import { type CacheId } from '../db/cache.ts';
import * as schema from '../db/schema.ts';

import { type SchemaDatabase } from './context.ts';

/**
Selects an upload in `cacheId` that is still in flight for `storePathHash`,
which defaults to the narinfo row that the outer statement is looking at.
Use it inside `exists` or `notExists`.

`pending` and `committing` are live commit states: verification has not yet
decided them, so the path's row is not yet committed.

`pending_upload_gc_path_idx` covers `(cache, json_extract(metadata_json,
'$.storePathHash'), verdict)`. Migrations create it, and recreate it after
each rebuild of `pending_upload`, but `schema.ts` does not declare it, so
Drizzle gives no warning when this predicate stops matching the index
expression. The comparison has the TEXT affinity of
`narinfo.store_path_hash`, and the index expression has none, so SQLite
cannot use that index term. The unary plus removes the affinity. Without
it, SQLite searches the index on `cache_id` alone and reads every in-flight
upload of the cache for each narinfo row.
*/
export function inFlightUploadSelect(
	database: SchemaDatabase,
	cacheId: CacheId | SQLWrapper,
	storePathHash: SQLWrapper = schema.narInfos.storePathHash
) {
	const reservedVerdict = or(
		eq(schema.pendingUploads.verdict, 'committing'),
		eq(schema.pendingUploads.verdict, 'pending')
	);
	const uploadPath = sql`json_extract(${schema.pendingUploads.metadataJson}, '$.storePathHash')`;

	return database
		.select({ one: sql`1` })
		.from(schema.pendingUploads)
		.where(
			and(
				eq(schema.pendingUploads.cacheId, cacheId),
				reservedVerdict,
				eq(uploadPath, sql`+${storePathHash}`)
			)
		);
}
