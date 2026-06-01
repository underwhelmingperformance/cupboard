import {
	integer,
	primaryKey,
	sqliteTable,
	text
} from 'drizzle-orm/sqlite-core';

export const narInfos = sqliteTable(
	'narinfo',
	{
		cache: text('cache').notNull().default(''),
		storePathHash: text('store_path_hash').notNull(),
		storePath: text('store_path').notNull(),
		narHash: text('nar_hash').notNull(),
		narSize: integer('nar_size').notNull(),
		fileHash: text('file_hash').notNull(),
		fileSize: integer('file_size').notNull(),
		compression: text('compression', { enum: ['zstd'] }).notNull(),
		referencesJson: text('references_json').notNull(),
		deriver: text('deriver'),
		ca: text('ca'),
		sigsJson: text('sigs_json').notNull().default('[]'),
		createdAt: text('created_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

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

export const authKeys = sqliteTable('auth_key', {
	id: text('id').primaryKey(),
	privateJwkJson: text('private_jwk_json').notNull(),
	publicJwkJson: text('public_jwk_json').notNull(),
	createdAt: text('created_at').notNull(),
	retiredAt: text('retired_at')
});

export const signingKeys = sqliteTable('signing_key', {
	id: text('id').primaryKey(),
	privateJwkJson: text('private_jwk_json').notNull(),
	publicKey: text('public_key').notNull(),
	signing: integer('signing', { mode: 'boolean' }).notNull().default(true),
	published: integer('published', { mode: 'boolean' }).notNull().default(true),
	createdAt: text('created_at').notNull()
});

export const retentionRoots = sqliteTable(
	'retention_root',
	{
		cache: text('cache').notNull().default(''),
		name: text('name').notNull(),
		expiresAt: text('expires_at'),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.name] })]
);

export const retentionRootTargets = sqliteTable(
	'retention_root_target',
	{
		cache: text('cache').notNull().default(''),
		rootName: text('root_name').notNull(),
		storePathHash: text('store_path_hash').notNull(),
		storePath: text('store_path').notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.cache, table.rootName, table.storePathHash]
		})
	]
);

export const caches = sqliteTable('cache', {
	name: text('name').primaryKey(),
	priority: integer('priority').notNull(),
	createdAt: text('created_at').notNull()
});
