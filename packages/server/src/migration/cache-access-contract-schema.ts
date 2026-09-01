import {
	type CacheAccessMode,
	type CacheGeneration,
	type CacheName,
	type CacheReadRevision,
	cacheReadRevisionSchema,
	type NarInfoGeneration,
	type NixSha256HashString,
	type PredicateType,
	type Sha256HexDigest,
	type StorePathHash,
	type TenantId
} from '@cupboard/nix-store/scalars';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type { ReadUser } from '@cupboard/shared/http';
import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

import type { ReadPasswordHash, ReadPasswordSalt } from '../read/read-auth.ts';

export {
	blobState,
	casObject,
	controlAuthKey,
	controlTrust,
	d1AppMutationFence,
	deploymentHead,
	deploymentTransitionExecution,
	freshInstallationBootstrap,
	globalAdmin,
	globalDataMigration,
	instanceConfig,
	localContractMigration,
	manifestState,
	objectDeletion,
	objectIncarnation,
	structuralMigrationChecksum,
	successorDeploymentPreparation,
	tenantBlob,
	tenantCasBlob,
	tenantDataMigration,
	tenantMaintenanceEligibility,
	tenantMaintenanceFailure,
	tenantUsage
} from '../db/d1-schema.ts';

function cacheNameConstraint(column: SQLWrapper): SQL {
	return sql`length(${column}) BETWEEN 1 AND 63 AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND ${column} NOT GLOB '*[^a-z0-9._-]*'`;
}

export const blobReference = sqliteTable(
	'blob_ref',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		legacyCache: text('cache'),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		cacheGeneration: integer('cache_generation').$type<CacheGeneration>()
	},
	(table) => [
		primaryKey({
			columns: [
				table.tenant,
				table.legacyCache,
				table.storePathHash,
				table.generation
			]
		}),
		check(
			'blob_ref_cache_identity_check',
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL AND ${cacheNameConstraint(table.cacheName)})`
		),
		uniqueIndex('blob_ref_default_identity_idx')
			.on(table.tenant, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('blob_ref_named_identity_idx')
			.on(table.tenant, table.cacheName, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'named'`),
		index('blob_ref_nar_hash_idx').on(table.narHash),
		index('blob_ref_tenant_nar_hash_cache_idx').on(
			table.tenant,
			table.narHash,
			table.legacyCache,
			table.cacheGeneration
		),
		index('blob_ref_tenant_nar_hash_native_idx').on(
			table.tenant,
			table.narHash,
			table.cacheKind,
			table.cacheName,
			table.cacheGeneration
		)
	]
);

export const cacheLifecycle = sqliteTable(
	'cache_lifecycle',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		legacyCache: text('cache'),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		access: text('access', { enum: ['public', 'private'] })
			.$type<CacheAccessMode>()
			.notNull(),
		generation: integer('generation').$type<CacheGeneration>().notNull(),
		readRevision: integer('read_revision')
			.$type<CacheReadRevision>()
			.notNull()
			.default(cacheReadRevisionSchema.parse(1)),
		deletedAt: text('deleted_at').$type<IsoTimestamp>(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenant, table.legacyCache] }),
		check(
			'cache_lifecycle_identity_check',
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL AND ${cacheNameConstraint(table.cacheName)})`
		),
		check(
			'cache_lifecycle_access_check',
			sql`${table.access} IN ('public', 'private')`
		),
		uniqueIndex('cache_lifecycle_default_identity_idx')
			.on(table.tenant)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('cache_lifecycle_named_identity_idx')
			.on(table.tenant, table.cacheName)
			.where(sql`${table.cacheKind} = 'named'`)
	]
);

export const tenant = sqliteTable(
	'tenant',
	{
		id: text('id').$type<TenantId>().primaryKey(),
		status: text('status', {
			enum: ['active', 'suspended', 'offboarding', 'offboarded']
		}).notNull(),
		readMode: text('read_mode', { enum: ['public', 'private'] }).notNull(),
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
	},
	(table) => [
		index('tenant_maintenance_idx').on(table.status, table.lastMaintainedAt)
	]
);

export const tenantCacheReadCredential = sqliteTable(
	'tenant_cache_read_credential',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		legacyCache: text('cache'),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		readUser: text('read_user').$type<ReadUser>().notNull(),
		readPasswordHash: text('read_password_hash')
			.$type<ReadPasswordHash>()
			.notNull(),
		readPasswordSalt: text('read_password_salt')
			.$type<ReadPasswordSalt>()
			.notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenant, table.legacyCache] }),
		check(
			'tenant_cache_read_credential_identity_check',
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL AND ${cacheNameConstraint(table.cacheName)})`
		),
		uniqueIndex('tenant_cache_read_credential_default_identity_idx')
			.on(table.tenant)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('tenant_cache_read_credential_named_identity_idx')
			.on(table.tenant, table.cacheName)
			.where(sql`${table.cacheKind} = 'named'`)
	]
);

export const attestationReference = sqliteTable(
	'attestation_ref',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		legacyCache: text('cache'),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		predicateType: text('predicate_type').$type<PredicateType>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [
				table.tenant,
				table.legacyCache,
				table.storePathHash,
				table.generation,
				table.predicateType,
				table.digest
			]
		}),
		check(
			'attestation_ref_cache_identity_check',
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL AND ${cacheNameConstraint(table.cacheName)})`
		),
		uniqueIndex('attestation_ref_default_identity_idx')
			.on(
				table.tenant,
				table.storePathHash,
				table.generation,
				table.predicateType,
				table.digest
			)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('attestation_ref_named_identity_idx')
			.on(
				table.tenant,
				table.cacheName,
				table.storePathHash,
				table.generation,
				table.predicateType,
				table.digest
			)
			.where(sql`${table.cacheKind} = 'named'`),
		index('attestation_ref_digest_idx').on(table.digest)
	]
);
