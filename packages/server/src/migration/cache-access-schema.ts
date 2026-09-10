import {
	type CacheAccessMode,
	type CacheGeneration,
	type CacheName,
	type NarInfoGeneration,
	type NixSha256HashString,
	type PredicateType,
	type Sha256HexDigest,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type { TenantStatus } from '@cupboard/protocol/tenants';
import type { ReadUser } from '@cupboard/shared/http';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { CacheId } from '../db/cache.ts';
import type { ReadPasswordHash, ReadPasswordSalt } from '../read/read-auth.ts';

export const cacheIdentities = sqliteTable('cache_identity', {
	id: integer('id').$type<CacheId>().primaryKey({ autoIncrement: true }),
	kind: text('kind', { enum: ['default', 'named'] }).notNull(),
	name: text('name').$type<CacheName>(),
	access: text('access', {
		enum: ['public', 'private']
	}).$type<CacheAccessMode>(),
	priority: integer('priority').notNull(),
	graceManaged: integer('grace_managed', { mode: 'boolean' })
		.notNull()
		.default(false),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	deletedAt: text('deleted_at').$type<IsoTimestamp>()
});

export const reuseViews = sqliteTable('reuse_view', {
	name: text('name').primaryKey(),
	access: text('access', {
		enum: ['public', 'private']
	}).$type<CacheAccessMode>()
});

export const tenants = sqliteTable('tenant', {
	id: text('id').$type<TenantId>().primaryKey(),
	status: text('status').$type<TenantStatus>().notNull(),
	readMode: text('read_mode', { enum: ['public', 'private'] })
		.$type<CacheAccessMode>()
		.notNull(),
	ownerIssuer: text('owner_issuer').notNull(),
	ownerSubject: text('owner_subject').notNull(),
	ownerAudience: text('owner_audience').notNull(),
	configVersion: integer('config_version').notNull(),
	cacheCatalogueVersion: integer('cache_catalogue_version'),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	readUser: text('read_user').$type<ReadUser>(),
	readPasswordHash: text('read_password_hash').$type<ReadPasswordHash>(),
	readPasswordSalt: text('read_password_salt').$type<ReadPasswordSalt>(),
	lastMaintainedAt: text('last_maintained_at').$type<IsoTimestamp>()
});

export const cacheLifecycles = sqliteTable('cache_lifecycle', {
	tenant: text('tenant').$type<TenantId>().notNull(),
	legacyCache: text('cache').notNull(),
	cacheKind: text('cache_kind', { enum: ['default', 'named'] }),
	cacheName: text('cache_name').$type<CacheName>(),
	access: text('access', {
		enum: ['public', 'private']
	}).$type<CacheAccessMode>(),
	generation: integer('generation').$type<CacheGeneration>().notNull(),
	deletedAt: text('deleted_at').$type<IsoTimestamp>(),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
});

export const cacheReadCredentials = sqliteTable(
	'tenant_cache_read_credential',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		legacyCache: text('cache').notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }),
		cacheName: text('cache_name').$type<CacheName>(),
		readUser: text('read_user').$type<ReadUser>().notNull(),
		readPasswordHash: text('read_password_hash')
			.$type<ReadPasswordHash>()
			.notNull(),
		readPasswordSalt: text('read_password_salt')
			.$type<ReadPasswordSalt>()
			.notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	}
);

export const blobReferences = sqliteTable('blob_ref', {
	tenant: text('tenant').$type<TenantId>().notNull(),
	legacyCache: text('cache').notNull(),
	cacheKind: text('cache_kind', { enum: ['default', 'named'] }),
	cacheName: text('cache_name').$type<CacheName>(),
	storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
	generation: integer('generation').$type<NarInfoGeneration>().notNull(),
	narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
	cacheGeneration: integer('cache_generation').$type<CacheGeneration>()
});

export const attestationReferences = sqliteTable('attestation_ref', {
	tenant: text('tenant').$type<TenantId>().notNull(),
	legacyCache: text('cache').notNull(),
	cacheKind: text('cache_kind', { enum: ['default', 'named'] }),
	cacheName: text('cache_name').$type<CacheName>(),
	storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
	generation: integer('generation').$type<NarInfoGeneration>().notNull(),
	predicateType: text('predicate_type').$type<PredicateType>().notNull(),
	digest: text('digest').$type<Sha256HexDigest>().notNull()
});
