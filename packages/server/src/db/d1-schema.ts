import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text
} from 'drizzle-orm/sqlite-core';

// The global, cross-tenant shared-blob facts, held in D1 rather than any one
// tenant's Durable Object SQLite. A row exists exactly when a verified shared
// object lives at `nar/<nar_hash>.nar.zst`, so it is both the `available` set and
// the canonical compressed metadata a servable narinfo advertises. Only positive
// facts are recorded — a mismatch is kept on the per-upload record, never here —
// so one tenant's bad upload can never poison a hash for everyone.
export const blobState = sqliteTable('blob_state', {
	narHash: text('nar_hash').primaryKey(),
	fileHash: text('file_hash').notNull(),
	fileSize: integer('file_size').notNull(),
	compression: text('compression', { enum: ['zstd'] }).notNull(),
	narSize: integer('nar_size').notNull(),
	verifiedAt: text('verified_at').notNull()
});

// One row per narinfo version: the source-of-truth reference edge from a tenant's
// committed narinfo to the shared NAR hash it points at. `generation` is part of
// the key, so an edge names the exact narinfo version that created it; a deletion
// targets a captured `(tenant, cache, store_path_hash, generation)` and so can
// never remove a newer recommitted edge. The `nar_hash` index backs the reaper's
// "is this hash referenced anywhere" probe, which is on a non-key column.
export const blobReference = sqliteTable(
	'blob_ref',
	{
		tenant: text('tenant').notNull(),
		cache: text('cache').notNull(),
		storePathHash: text('store_path_hash').notNull(),
		generation: integer('generation').notNull(),
		narHash: text('nar_hash').notNull()
	},
	(table) => [
		primaryKey({
			columns: [
				table.tenant,
				table.cache,
				table.storePathHash,
				table.generation
			]
		}),
		index('blob_ref_nar_hash_idx').on(table.narHash)
	]
);

// Per-tenant unique-blob presence: a tenant references this NAR hash via at least
// one live narinfo version. Maintained by the tenant's DO on the 0↔1 edge
// transition; `file_size` is the tenant's verified stored bytes, the basis for
// once-per-tenant-per-blob quota charging (the charge itself lands later).
export const tenantBlob = sqliteTable(
	'tenant_blob',
	{
		tenant: text('tenant').notNull(),
		narHash: text('nar_hash').notNull(),
		fileSize: integer('file_size').notNull()
	},
	(table) => [primaryKey({ columns: [table.tenant, table.narHash] })]
);
