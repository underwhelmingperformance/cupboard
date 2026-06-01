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
	cache: text('cache').notNull().default(''),
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
		cache: text('cache').notNull().default(''),
		storePathHash: text('store_path_hash').notNull(),
		narHash: text('nar_hash').notNull(),
		generation: integer('generation').notNull().default(0),
		createdAt: text('created_at').notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.cache, table.storePathHash, table.generation]
		})
	]
);

export const authKeys = sqliteTable('auth_key', {
	id: text('id').primaryKey(),
	// The JWKS key id carried in each minted token's header so a verifier can
	// pick the right key across a rotation. Always populated on key creation.
	kid: text('kid').notNull().default(''),
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

export const retentionPolicies = sqliteTable('retention_policy', {
	id: text('id').primaryKey(),
	scope: text('scope', { enum: ['cache', 'root-name-prefix'] }).notNull(),
	pattern: text('pattern').notNull(),
	defaultTtlSeconds: integer('default_ttl_seconds').notNull(),
	createdAt: text('created_at').notNull()
});

// Where the last background verification pass stopped, so the next pass resumes
// from that point. A single `id = 'active'` row holding a composite
// `(cache, store_path_hash)` position; an empty position starts (or wraps) at
// the lowest hash of the first cache.
export const verificationCursor = sqliteTable('verification_cursor', {
	id: text('id').primaryKey(),
	cache: text('cache').notNull().default(''),
	lastStorePathHash: text('last_store_path_hash'),
	updatedAt: text('updated_at').notNull()
});

// An OIDC trust rule federates an external identity into a cupboard scope: an
// inbound token verified against `issuer`'s JWKS, with `audience` and every
// `claims_json` entry matched exactly, grants `scope`. A `write` rule binds the
// minted token to `allowed_roots_json`; the owner's `admin` rule is seeded from
// deploy config. `disabled_at` soft-disables a rule without losing the audit row.
export const oidcTrust = sqliteTable('oidc_trust', {
	id: text('id').primaryKey(),
	issuer: text('issuer').notNull(),
	jwksUrl: text('jwks_url').notNull(),
	audience: text('audience').notNull(),
	scope: text('scope', { enum: ['write', 'admin'] }).notNull(),
	claimsJson: text('claims_json').notNull().default('{}'),
	allowedRootsJson: text('allowed_roots_json').notNull().default('[]'),
	createdAt: text('created_at').notNull(),
	disabledAt: text('disabled_at')
});
