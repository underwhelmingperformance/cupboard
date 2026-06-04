import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
