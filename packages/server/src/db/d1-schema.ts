import {
	type AuthKeyId,
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
import type { InstanceName } from '@cupboard/protocol/instance';
import type { TrustRuleId } from '@cupboard/protocol/oidc';
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

import {
	type ReadPasswordHash,
	type ReadPasswordSalt
} from '../read/read-auth.ts';

function cacheNameConstraint(column: SQLWrapper): SQL {
	return sql`length(${column}) BETWEEN 1 AND 63 AND substr(${column}, 1, 1) GLOB '[a-z0-9]' AND ${column} NOT GLOB '*[^a-z0-9._-]*'`;
}

export const instanceConfig = sqliteTable('instance_config', {
	id: text('id').primaryKey(),
	name: text('name').$type<InstanceName>().notNull(),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull()
});

// Tracks the current version of each shared R2 object. The row remains after
// collection so the next promotion receives a greater object version in the
// `incarnation` column.
// `pending` has reserved the versioned R2 key, `live` has completed the R2
// write, and `absent` has no current object. Maintenance can recover or retire
// an abandoned promotion when its `blob_state` or `cas_object` row is missing.
export const objectIncarnation = sqliteTable(
	'object_incarnation',
	{
		kind: text('kind', { enum: ['nar', 'cas'] }).notNull(),
		objectId: text('object_id').notNull(),
		incarnation: integer('incarnation').notNull(),
		state: text('state', {
			enum: ['pending', 'live', 'absent']
		}).notNull(),
		reservationOwner: text('reservation_owner'),
		updatedAt: text('updated_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`'1970-01-01T00:00:00.000Z'`)
	},
	(table) => [
		primaryKey({ columns: [table.kind, table.objectId] }),
		index('object_incarnation_recovery_idx').on(
			table.kind,
			table.state,
			table.updatedAt,
			table.objectId
		)
	]
);

// Each row schedules deletion of one versioned R2 object after its `blob_state`
// or `cas_object` row has been deleted. Maintenance deletes the exact R2 key at
// `remove_after` and then removes the marker. A replacement uses a deadline that
// outlives preceding Workers and cached narinfos.
export const objectDeletion = sqliteTable(
	'object_deletion',
	{
		kind: text('kind', { enum: ['nar', 'cas'] }).notNull(),
		objectId: text('object_id').notNull(),
		incarnation: integer('incarnation').notNull(),
		removeAfter: text('remove_after').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.kind, table.objectId, table.incarnation]
		}),
		index('object_deletion_due_idx').on(
			table.kind,
			table.removeAfter,
			table.objectId,
			table.incarnation
		)
	]
);

// Each row records a verified shared NAR at the physical R2 key for one object
// version. The row supplies both availability and the compressed metadata
// advertised by narinfo responses. Upload mismatches remain private to their
// upload rows and cannot change this row. Collection deletes the row and
// schedules deletion of the corresponding R2 key in one transaction.
export const blobState = sqliteTable(
	'blob_state',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().primaryKey(),
		fileHash: text('file_hash').$type<NixSha256HashString>().notNull(),
		fileSize: integer('file_size').notNull(),
		compression: text('compression', { enum: ['zstd'] }).notNull(),
		narSize: integer('nar_size').notNull(),
		incarnation: integer('incarnation').notNull().default(1),
		verifiedAt: text('verified_at').$type<IsoTimestamp>().notNull(),
		// The reaper arms an unreferenced blob by setting this deadline. A new
		// reference clears it. Collection must recheck that the deadline has elapsed
		// and that no reference exists before deleting the row and object. Null means
		// live or not yet armed.
		deleteAfter: text('delete_after').$type<IsoTimestamp>()
	},
	(table) => [index('blob_state_delete_after_idx').on(table.deleteAfter)]
);

// One row per narinfo version: the source-of-truth reference edge from a tenant's
// committed narinfo to the shared NAR hash it points at. `generation` is part of
// the key, so an edge names the exact narinfo version that created it; a deletion
// targets a captured `(tenant, cache, store_path_hash, generation)` and so can
// never remove a newer recommitted edge. The `nar_hash` index backs the reaper's
// "is this hash referenced anywhere" probe, which is on a non-key column.
export const blobReference = sqliteTable(
	'blob_ref',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		cacheGeneration: integer('cache_generation').$type<CacheGeneration>()
	},
	(table) => [
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
		index('blob_ref_tenant_nar_hash_native_idx').on(
			table.tenant,
			table.narHash,
			table.cacheKind,
			table.cacheName,
			table.cacheGeneration
		)
	]
);

// Deleting a cache advances its generation. Existing D1 reference edges then
// stop authorising reads before their asynchronous physical cleanup finishes.
export const cacheLifecycle = sqliteTable(
	'cache_lifecycle',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		access: text('access', { enum: ['public', 'private'] })
			.$type<CacheAccessMode>()
			.notNull(),
		generation: integer('generation').$type<CacheGeneration>().notNull(),
		deletedAt: text('deleted_at').$type<IsoTimestamp>(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
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

// The control-plane signing key set, held in D1 so the stateless Worker can issue
// and rotate control tokens (which authorise global-admin operations). Only the
// public metadata and the *wrapped* private JWK live here; the wrapping secret is
// bound only on the control-plane Worker (see control-key.ts), and the tenant
// Durable Object runs in a separate script that never binds it, so a DO that can
// read this table (D1 is database-wide) still cannot recover a key. `retired_at`
// is NULL while a key still verifies; the newest non-retired key is the one that
// issues.
export const controlAuthKey = sqliteTable('control_auth_key', {
	id: text('id').primaryKey(),
	kid: text('kid').$type<AuthKeyId>().notNull(),
	publicJwkJson: text('public_jwk_json').notNull(),
	wrappedPrivateJwk: text('wrapped_private_jwk').notNull(),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	scheduledRetireAt: text('scheduled_retire_at').$type<IsoTimestamp>(),
	retiredAt: text('retired_at').$type<IsoTimestamp>()
});

// These rules determine which external OIDC identities can receive control
// grants. Decoded issuer and audience values select a configured verification
// target. After verification, the claims and requested grants select a policy
// rule. The initial signup creates the wildcard owner rule, and the control
// admin API adds scoped identities. Disabling a rule retains its audit row.
// Control tokens use an issuer separate from every tenant issuer.
export const controlTrust = sqliteTable('control_trust', {
	id: text('id').$type<TrustRuleId>().primaryKey(),
	issuer: text('issuer').notNull(),
	audience: text('audience').notNull(),
	claimsJson: text('claims_json').notNull().default('{}'),
	permittedGrantsJson: text('permitted_grants_json')
		.notNull()
		.default('[{"type":"cupboard_wildcard"}]'),
	displayJson: text('display_json'),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	disabledAt: text('disabled_at').$type<IsoTimestamp>()
});

// Each provisioned cache has one authoritative tenant row. `status` gates every
// request: `active` serves reads and accepts writes, `suspended` refuses both,
// `offboarding` drains, and `offboarded` is the terminal scrubbed tombstone. The
// tombstone prevents reuse of the slug and is excluded from maintenance and
// membership hints. `config_version` orders identity updates sent to the tenant
// Durable Object.
export const tenant = sqliteTable(
	'tenant',
	{
		id: text('id').$type<TenantId>().primaryKey(),
		status: text('status', {
			enum: ['active', 'suspended', 'offboarding', 'offboarded']
		}).notNull(),
		ownerIssuer: text('owner_issuer').notNull(),
		ownerSubject: text('owner_subject').notNull(),
		ownerAudience: text('owner_audience').notNull(),
		configVersion: integer('config_version').notNull(),
		cacheCatalogueVersion: integer('cache_catalogue_version'),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		// Private caches store the Basic-auth user, salt, and password verifier.
		// Public caches keep all three columns null. A private cache with an
		// incomplete verifier rejects every read; the plaintext password is never
		// stored.
		readUser: text('read_user').$type<ReadUser>(),
		readPasswordHash: text('read_password_hash').$type<ReadPasswordHash>(),
		readPasswordSalt: text('read_password_salt').$type<ReadPasswordSalt>(),
		// Scheduled maintenance processes the least recently maintained active
		// tenants first. Null sorts first, so a new tenant is selected promptly.
		lastMaintainedAt: text('last_maintained_at').$type<IsoTimestamp>()
	},
	(table) => [
		index('tenant_maintenance_idx').on(table.status, table.lastMaintainedAt)
	]
);

// A cache can replace the tenant's fallback read verifier with one of its own.
export const tenantCacheReadCredential = sqliteTable(
	'tenant_cache_read_credential',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
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

// Keep the latest maintenance success and failure for each tenant and pass. A
// failure remains visible after its Worker log has expired. A later success
// clears the failure streak but preserves the time of the last successful pass.
export const tenantMaintenanceFailure = sqliteTable(
	'tenant_maintenance_failure',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		pass: text('pass', { enum: ['maintenance', 'offboard'] }).notNull(),
		consecutiveFailures: integer('consecutive_failures').notNull().default(0),
		lastError: text('last_error'),
		lastFailedAt: text('last_failed_at').$type<IsoTimestamp>(),
		lastSuccessAt: text('last_success_at').$type<IsoTimestamp>()
	},
	(table) => [primaryKey({ columns: [table.tenant, table.pass] })]
);

// This row is a fail-open hint for scheduled tenant maintenance. The tenant
// Durable Object recomputes it after mutations that can create or clear work.
// The scheduler uses a current idle hint to avoid waking that tenant.
export const tenantMaintenanceEligibility = sqliteTable(
	'tenant_maintenance_eligibility',
	{
		tenant: text('tenant').$type<TenantId>().primaryKey(),
		// The tenant's next wake time: a fixed past sentinel when work is due now, the
		// soonest deferred deadline otherwise, or null when the tenant is idle.
		nextWakeAt: text('next_wake_at').$type<IsoTimestamp>(),
		// This records when eligibility was recomputed, but it is not monotonic.
		// Conflict resolution can retain an older timestamp when that row has an
		// earlier wake time. Consumers use it only to detect stale hints, so moving
		// backwards can schedule extra work but cannot skip due work.
		reconciledAt: text('reconciled_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		index('tenant_maintenance_eligibility_due_idx').on(
			table.nextWakeAt,
			table.reconciledAt
		)
	]
);

// Existing databases retain this table for migration compatibility. Admission
// now reads tenant rows from D1 and uses KV only for negative membership hints.
export const manifestState = sqliteTable('manifest_state', {
	id: text('id').primaryKey(),
	version: integer('version').notNull()
});

// The first successful signup inserts the singleton global-administrator row.
// Its primary key prevents later claims from replacing the administrator.
// `issuer`, `subject`, and `audience` identify that principal.
export const globalAdmin = sqliteTable('global_admin', {
	id: text('id').primaryKey(),
	issuer: text('issuer').notNull(),
	subject: text('subject').notNull(),
	audience: text('audience').notNull().default(''),
	claimedAt: text('claimed_at').$type<IsoTimestamp>().notNull()
});

// One row means that this tenant has at least one live narinfo reference to the
// NAR hash. The same atomic batch inserts the first presence row and charges its
// `file_size`. Removing the last reference deletes the row and credits that size.
export const tenantBlob = sqliteTable(
	'tenant_blob',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		fileSize: integer('file_size').notNull()
	},
	(table) => [primaryKey({ columns: [table.tenant, table.narHash] })]
);

// A row records measured attestation bytes stored at the physical R2 key for one
// object version of `cas/<digest>`. It does not mean that the bundle passed
// Sigstore, DSSE, or trust-root verification.
export const casObject = sqliteTable(
	'cas_object',
	{
		digest: text('digest').$type<Sha256HexDigest>().primaryKey(),
		size: integer('size').notNull(),
		incarnation: integer('incarnation').notNull().default(1),
		storedAt: text('stored_at').$type<IsoTimestamp>().notNull(),
		deleteAfter: text('delete_after').$type<IsoTimestamp>()
	},
	(table) => [index('cas_object_delete_after_idx').on(table.deleteAfter)]
);

// One attestation reference for one committed narinfo generation. Like `blob_ref`,
// generation is part of the key so stale deletion can retire only the captured
// narinfo version and never a later recommit.
export const attestationReference = sqliteTable(
	'attestation_ref',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		predicateType: text('predicate_type').$type<PredicateType>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull()
	},
	(table) => [
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

// Per-tenant unique-bundle presence: a tenant references this bundle via at least
// one live attestation edge. This drives once-per-tenant-per-bundle CAS accounting.
export const tenantCasBlob = sqliteTable(
	'tenant_cas_blob',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		size: integer('size').notNull()
	},
	(table) => [primaryKey({ columns: [table.tenant, table.digest] })]
);

// The authoritative per-tenant usage and quota counter. `bytes`/`blobs` are NAR
// storage only, matching `tenant_blob`; `cas_bytes`/`cas_blobs` are attestation CAS
// storage only, matching `tenant_cas_blob`. `narinfos` is the committed-narinfo
// count. The quota applies to total charged bytes (`bytes + cas_bytes`). The
// counters are maintained incrementally by the owning tenant's Durable Object as it
// charges on 0-to-1 presence transitions and credits on 1-to-0 transitions.
// `quota_bytes` is the admin-set limit (NULL means unlimited), written only by the
// Worker. The CHECK makes an over-quota charge fail its D1 batch, so no edge and no
// charge are ever stranded over quota.
export const tenantUsage = sqliteTable(
	'tenant_usage',
	{
		tenant: text('tenant').$type<TenantId>().primaryKey(),
		bytes: integer('bytes').notNull().default(0),
		narinfos: integer('narinfos').notNull().default(0),
		blobs: integer('blobs').notNull().default(0),
		casBytes: integer('cas_bytes').notNull().default(0),
		casBlobs: integer('cas_blobs').notNull().default(0),
		quotaBytes: integer('quota_bytes'),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check('tenant_usage_bytes_nonnegative', sql`${table.bytes} >= 0`),
		check('tenant_usage_narinfos_nonnegative', sql`${table.narinfos} >= 0`),
		check('tenant_usage_blobs_nonnegative', sql`${table.blobs} >= 0`),
		check('tenant_usage_cas_bytes_nonnegative', sql`${table.casBytes} >= 0`),
		check('tenant_usage_cas_blobs_nonnegative', sql`${table.casBlobs} >= 0`),
		check(
			'tenant_usage_within_quota',
			sql`${table.quotaBytes} IS NULL OR ${table.bytes} + ${table.casBytes} <= ${table.quotaBytes}`
		)
	]
);
