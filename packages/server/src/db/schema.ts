import {
	integer,
	primaryKey,
	sqliteTable,
	text
} from 'drizzle-orm/sqlite-core';

export const narInfos = sqliteTable('narinfo', {
	storePathHash: text('store_path_hash').primaryKey(),
	storePath: text('store_path').notNull(),
	narHash: text('nar_hash').notNull(),
	narSize: integer('nar_size').notNull(),
	fileHash: text('file_hash').notNull(),
	fileSize: integer('file_size').notNull(),
	compression: text('compression', { enum: ['zstd'] }).notNull(),
	referencesJson: text('references_json').notNull(),
	deriver: text('deriver'),
	ca: text('ca'),
	sig: text('sig'),
	createdAt: text('created_at').notNull()
});

export const narBlobs = sqliteTable('nar_blob', {
	narHash: text('nar_hash').primaryKey(),
	r2Key: text('r2_key').notNull(),
	compression: text('compression', { enum: ['zstd'] }).notNull(),
	fileHash: text('file_hash').notNull(),
	fileSize: integer('file_size').notNull(),
	createdAt: text('created_at').notNull()
});

export const pendingUploads = sqliteTable('pending_upload', {
	id: text('id').primaryKey(),
	narHash: text('nar_hash').notNull(),
	r2Key: text('r2_key').notNull(),
	expectedSize: integer('expected_size').notNull(),
	metadataJson: text('metadata_json').notNull(),
	createdAt: text('created_at').notNull(),
	expiresAt: text('expires_at').notNull()
});

export const orphanBlobDeletions = sqliteTable('orphan_blob_deletion', {
	r2Key: text('r2_key').primaryKey(),
	notBefore: text('not_before').notNull().default('1970-01-01T00:00:00.000Z'),
	createdAt: text('created_at').notNull()
});

export const narInfoDeletions = sqliteTable(
	'narinfo_deletion',
	{
		storePathHash: text('store_path_hash').notNull(),
		narHash: text('nar_hash').notNull(),
		generation: integer('generation').notNull().default(0),
		createdAt: text('created_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.storePathHash, table.generation] })]
);

export const tokens = sqliteTable('token', {
	id: text('id').primaryKey(),
	hash: text('hash').notNull(),
	scope: text('scope', { enum: ['admin'] }).notNull(),
	createdAt: text('created_at').notNull()
});

export const signingKeys = sqliteTable('signing_key', {
	id: text('id').primaryKey(),
	privateJwkJson: text('private_jwk_json').notNull(),
	publicKey: text('public_key').notNull(),
	createdAt: text('created_at').notNull()
});
