import {
	type AuthKeyId,
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
import type { InstanceName } from '@cupboard/protocol/instance';
import type {
	CacheLifecycleState,
	GitHubOwnerId,
	GitHubRepositoryId,
	ManagedCacheGroupId,
	ManagedCacheNamespace,
	ManagedPolicyId,
	ManagedPolicyRevision,
	ManagedPolicyStatus
} from '@cupboard/protocol/managed-caches';
import type { TrustRuleId } from '@cupboard/protocol/oidc';
import { reuseViewDefaultPriority } from '@cupboard/protocol/reuse-views';
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
		cacheGeneration: integer('cache_generation')
			.$type<CacheGeneration>()
			.notNull()
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
		readRevision: integer('read_revision')
			.$type<CacheReadRevision>()
			.notNull()
			.default(cacheReadRevisionSchema.parse(1)),
		state: text('state', {
			enum: ['creating', 'active', 'retiring', 'deleted']
		})
			.$type<CacheLifecycleState>()
			.notNull()
			.default('active'),
		creationExpiresAt: text('creation_expires_at').$type<IsoTimestamp>(),
		managementKind: text('management_kind', {
			enum: ['durable', 'managed']
		})
			.notNull()
			.default('durable'),
		managedPolicyId: text('managed_policy_id').$type<ManagedPolicyId>(),
		managedPolicyRevision: integer(
			'managed_policy_revision'
		).$type<ManagedPolicyRevision>(),
		managedGroupId: text('managed_group_id').$type<ManagedCacheGroupId>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		selectionState: text('selection_state', {
			enum: ['source-active', 'detached', 'reconciling', 'target-active']
		}),
		updateHold: integer('update_hold', { mode: 'boolean' })
			.notNull()
			.default(false),
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
		check(
			'cache_lifecycle_creation_shape_check',
			sql`(${table.state} = 'creating' AND ${table.creationExpiresAt} IS NOT NULL) OR (${table.state} <> 'creating' AND ${table.creationExpiresAt} IS NULL)`
		),
		check(
			'cache_lifecycle_management_shape_check',
			sql`(${table.managementKind} = 'durable' AND ${table.managedPolicyId} IS NULL AND ${table.managedPolicyRevision} IS NULL AND ${table.managedGroupId} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.selectionState} IS NULL) OR (${table.managementKind} = 'managed' AND ${table.managedPolicyId} IS NOT NULL AND ${table.managedPolicyRevision} IS NOT NULL AND ${table.managedGroupId} IS NOT NULL AND ((${table.state} = 'creating' AND ${table.leaseExpiresAt} IS NULL AND ${table.selectionState} = 'detached') OR (${table.state} <> 'creating' AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.selectionState} IS NOT NULL)))`
		),
		uniqueIndex('cache_lifecycle_default_identity_idx')
			.on(table.tenant)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('cache_lifecycle_named_identity_idx')
			.on(table.tenant, table.cacheName)
			.where(sql`${table.cacheKind} = 'named'`),
		index('cache_lifecycle_native_identity_idx').on(
			table.tenant,
			table.cacheKind,
			table.cacheName
		),
		index('cache_lifecycle_managed_capacity_idx').on(
			table.tenant,
			table.managedPolicyId,
			table.state,
			table.leaseExpiresAt
		),
		index('cache_lifecycle_managed_group_selection_idx').on(
			table.tenant,
			table.managedGroupId,
			table.access,
			table.state,
			table.selectionState
		)
	]
);

export const managedCacheGroup = sqliteTable(
	'managed_cache_group',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		id: text('id').$type<ManagedCacheGroupId>().notNull(),
		access: text('access', { enum: ['public', 'private'] })
			.$type<CacheAccessMode>()
			.notNull(),
		reuseViewName: text('reuse_view_name').notNull(),
		reuseViewPriority: integer('reuse_view_priority')
			.notNull()
			.default(reuseViewDefaultPriority),
		state: text('state', {
			enum: ['active', 'transitioning', 'retiring', 'retired']
		})
			.notNull()
			.default('active'),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenant, table.id] }),
		check(
			'managed_cache_group_access_check',
			sql`${table.access} IN ('public', 'private')`
		),
		uniqueIndex('managed_cache_group_view_idx').on(
			table.tenant,
			table.reuseViewName
		)
	]
);

export const managedPolicyFamily = sqliteTable(
	'managed_policy_family',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		id: text('id').$type<ManagedPolicyId>().notNull(),
		ownerId: text('owner_id').$type<GitHubOwnerId>().notNull(),
		repositoryId: text('repository_id').$type<GitHubRepositoryId>().notNull(),
		cacheNamespace: text('cache_namespace')
			.$type<ManagedCacheNamespace>()
			.notNull(),
		status: text('status', {
			enum: ['active', 'updating', 'update-failed', 'retiring']
		})
			.$type<ManagedPolicyStatus>()
			.notNull(),
		currentRevision: integer('current_revision')
			.$type<ManagedPolicyRevision>()
			.notNull(),
		pendingRevision: integer('pending_revision').$type<ManagedPolicyRevision>(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenant, table.id] }),
		check(
			'managed_policy_family_status_check',
			sql`${table.status} IN ('active', 'updating', 'update-failed', 'retiring')`
		),
		check(
			'managed_policy_family_revision_check',
			sql`${table.currentRevision} > 0 AND (${table.pendingRevision} IS NULL OR ${table.pendingRevision} > ${table.currentRevision})`
		),
		uniqueIndex('managed_policy_repository_idx').on(
			table.tenant,
			table.repositoryId
		),
		uniqueIndex('managed_policy_namespace_idx').on(
			table.tenant,
			table.cacheNamespace
		)
	]
);

export const managedPolicyRevision = sqliteTable(
	'managed_policy_revision',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		policyId: text('policy_id').$type<ManagedPolicyId>().notNull(),
		revision: integer('revision').$type<ManagedPolicyRevision>().notNull(),
		groupId: text('group_id').$type<ManagedCacheGroupId>().notNull(),
		access: text('access', { enum: ['public', 'private'] })
			.$type<CacheAccessMode>()
			.notNull(),
		priority: integer('priority').notNull(),
		defaultRootTtlSeconds: integer('default_root_ttl_seconds'),
		maximumRootDurationSeconds: integer(
			'maximum_root_duration_seconds'
		).notNull(),
		allowPermanentRoots: integer('allow_permanent_roots', {
			mode: 'boolean'
		}).notNull(),
		graceSeconds: integer('grace_seconds'),
		creationLeaseSeconds: integer('creation_lease_seconds').notNull(),
		provisionalLeaseSeconds: integer('provisional_lease_seconds').notNull(),
		activityLeaseSeconds: integer('activity_lease_seconds').notNull(),
		maximumLiveCaches: integer('maximum_live_caches').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.tenant, table.policyId, table.revision] }),
		check(
			'managed_policy_revision_values_check',
			sql`${table.revision} > 0 AND ${table.priority} > 0 AND ${table.maximumRootDurationSeconds} > 0 AND ${table.creationLeaseSeconds} > 0 AND ${table.provisionalLeaseSeconds} > 0 AND ${table.activityLeaseSeconds} > 0 AND ${table.maximumLiveCaches} > 0`
		),
		index('managed_policy_revision_group_idx').on(
			table.tenant,
			table.groupId,
			table.revision
		)
	]
);

export const managedGroupAccessTransition = sqliteTable(
	'managed_group_access_transition',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		id: text('id').notNull(),
		groupId: text('group_id').$type<ManagedCacheGroupId>().notNull(),
		targetGroupId: text('target_group_id')
			.$type<ManagedCacheGroupId>()
			.notNull(),
		sourceAccess: text('source_access', { enum: ['public', 'private'] })
			.$type<CacheAccessMode>()
			.notNull(),
		targetAccess: text('target_access', { enum: ['public', 'private'] })
			.$type<CacheAccessMode>()
			.notNull(),
		status: text('status', {
			enum: ['running', 'finalising', 'complete', 'failed']
		})
			.notNull()
			.default('running'),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull(),
		lastFailureJson: text('last_failure_json'),
		participantPoliciesJson: text('participant_policies_json')
			.notNull()
			.default('[]'),
		phase: text('phase', {
			enum: [
				'cancel-creations',
				'prepare-policies',
				'capture-caches',
				'move-caches',
				'switch-view',
				'release-holds',
				'activate-policies'
			]
		})
			.notNull()
			.default('cancel-creations'),
		policyCursor: text('policy_cursor').$type<ManagedPolicyId>(),
		cacheCursor: text('cache_cursor').$type<CacheName>()
	},
	(table) => [
		primaryKey({ columns: [table.tenant, table.id] }),
		check(
			'managed_group_access_transition_access_check',
			sql`${table.sourceAccess} IN ('public', 'private') AND ${table.targetAccess} IN ('public', 'private') AND ${table.sourceAccess} <> ${table.targetAccess}`
		),
		uniqueIndex('managed_group_access_transition_active_idx')
			.on(table.tenant, table.groupId)
			.where(sql`${table.status} IN ('running', 'finalising')`),
		index('managed_group_access_transition_work_idx').on(
			table.tenant,
			table.status,
			table.groupId
		)
	]
);

export const managedGroupAccessTransitionCache = sqliteTable(
	'managed_group_access_transition_cache',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		transitionId: text('transition_id').notNull(),
		cacheName: text('cache_name').$type<CacheName>().notNull(),
		generation: integer('generation').$type<CacheGeneration>().notNull(),
		targetReadRevision: integer('target_read_revision')
			.$type<CacheReadRevision>()
			.notNull(),
		policyId: text('policy_id').$type<ManagedPolicyId>().notNull(),
		state: text('state', { enum: ['pending', 'moved', 'complete'] })
			.notNull()
			.default('pending')
	},
	(table) => [
		primaryKey({
			columns: [table.tenant, table.transitionId, table.cacheName]
		}),
		index('managed_group_access_transition_cache_work_idx').on(
			table.tenant,
			table.transitionId,
			table.state,
			table.cacheName
		)
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
		// These columns store the tenant fallback read verifier. A cache-specific
		// verifier takes precedence when one exists. An incomplete verifier rejects
		// authentication; the plaintext password is never stored.
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

// The singleton deployment head records the exact artifact installation and
// manifest state which may advance. Transition claims compare its revision in
// the same D1 transaction that changes deployment-control state.
export const deploymentHead = sqliteTable(
	'deployment_head',
	{
		id: text('id').primaryKey(),
		manifestId: text('manifest_id').notNull(),
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		stateId: text('state_id').notNull(),
		revision: integer('revision').notNull(),
		status: text('status', {
			enum: ['active', 'superseding']
		}).notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check('deployment_head_singleton', sql`${table.id} = 'current'`),
		check('deployment_head_revision_nonnegative', sql`${table.revision} >= 0`)
	]
);

// One row owns execution of one declarative transition. A lost response can
// resume the same attempt, but the next transition cannot start until this row
// records completion.
export const deploymentTransitionExecution = sqliteTable(
	'deployment_transition_execution',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		transitionId: text('transition_id').notNull(),
		fromStateId: text('from_state_id').notNull(),
		toStateId: text('to_state_id').notNull(),
		status: text('status', {
			enum: ['pending', 'running', 'completed', 'failed']
		}).notNull(),
		attemptId: text('attempt_id'),
		claimRevision: integer('claim_revision').notNull().default(0),
		claimExpiresAt: text('claim_expires_at').$type<IsoTimestamp>(),
		externalAction: text('external_action', {
			enum: ['not-required', 'required', 'issued', 'observed']
		})
			.notNull()
			.default('not-required'),
		startedAt: text('started_at').$type<IsoTimestamp>(),
		completedAt: text('completed_at').$type<IsoTimestamp>(),
		lastFailureJson: text('last_failure_json'),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.artifactId, table.instanceId, table.transitionId]
		}),
		check(
			'deployment_transition_claim_revision_nonnegative',
			sql`${table.claimRevision} >= 0`
		),
		index('deployment_transition_status_idx').on(
			table.artifactId,
			table.instanceId,
			table.status,
			table.transitionId
		)
	]
);

// Verified rows bind an applied migration name to the SQL digest this release
// observed. Pre-ledger migrations remain explicit unverified baselines.
export const structuralMigrationChecksum = sqliteTable(
	'structural_migration_checksum',
	{
		kind: text('kind', { enum: ['d1', 'durable-object'] }).notNull(),
		migrationId: text('migration_id').notNull(),
		sha256: text('sha256').notNull(),
		verificationState: text('verification_state', {
			enum: ['verified', 'unverified-baseline']
		})
			.notNull()
			.default('verified'),
		appliedAt: text('applied_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.kind, table.migrationId] }),
		check(
			'structural_migration_checksum_shape',
			sql`${table.verificationState} IN ('verified', 'unverified-baseline') AND length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`
		)
	]
);

// Global execution owns the fixed tenant cohort and proves fleet completion.
// Per-tenant rows record results independently so an interrupted batch resumes
// without repeating completed tenants.
export const globalDataMigration = sqliteTable(
	'global_data_migration',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		migrationId: text('migration_id').notNull(),
		status: text('status', {
			enum: ['pending', 'running', 'complete', 'failed']
		}).notNull(),
		cohortCreatedAt: text('cohort_created_at').$type<IsoTimestamp>().notNull(),
		cohortHighWater: integer('cohort_high_water').notNull(),
		scanHighWaterJson: text('scan_high_water_json'),
		claimId: text('claim_id'),
		claimRevision: integer('claim_revision').notNull().default(0),
		claimExpiresAt: text('claim_expires_at').$type<IsoTimestamp>(),
		fleetCompletionRevision: integer('fleet_completion_revision'),
		completedAt: text('completed_at').$type<IsoTimestamp>(),
		lastFailureJson: text('last_failure_json')
	},
	(table) => [
		primaryKey({
			columns: [table.artifactId, table.instanceId, table.migrationId]
		}),
		check(
			'global_data_migration_cohort_high_water_nonnegative',
			sql`${table.cohortHighWater} >= 0`
		),
		check(
			'global_data_migration_claim_revision_nonnegative',
			sql`${table.claimRevision} >= 0`
		)
	]
);

export const tenantDataMigration = sqliteTable(
	'tenant_data_migration',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		migrationId: text('migration_id').notNull(),
		implementationRevision: text('implementation_revision').notNull(),
		tenant: text('tenant').$type<TenantId>().notNull(),
		status: text('status', {
			enum: ['pending', 'running', 'complete', 'not-applicable', 'failed']
		}).notNull(),
		attempts: integer('attempts').notNull().default(0),
		claimId: text('claim_id'),
		claimRevision: integer('claim_revision').notNull().default(0),
		claimExpiresAt: text('claim_expires_at').$type<IsoTimestamp>(),
		nextAttemptAt: text('next_attempt_at').$type<IsoTimestamp>(),
		startedAt: text('started_at').$type<IsoTimestamp>(),
		completedAt: text('completed_at').$type<IsoTimestamp>(),
		lastFailureJson: text('last_failure_json')
	},
	(table) => [
		primaryKey({
			columns: [
				table.artifactId,
				table.instanceId,
				table.migrationId,
				table.tenant
			]
		}),
		check(
			'tenant_data_migration_attempts_nonnegative',
			sql`${table.attempts} >= 0`
		),
		check(
			'tenant_data_migration_claim_revision_nonnegative',
			sql`${table.claimRevision} >= 0`
		),
		index('tenant_data_migration_work_idx').on(
			table.artifactId,
			table.instanceId,
			table.migrationId,
			table.status,
			table.nextAttemptAt,
			table.tenant
		)
	]
);

// Admission remains permanent after this release. Future local migrations use
// the same per-tenant barrier instead of adding another request-path mechanism.
export const localContractMigration = sqliteTable(
	'local_contract_migration',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		tenant: text('tenant').$type<TenantId>().notNull(),
		phase: text('phase', {
			enum: [
				'pending',
				'bookmark-recorded',
				'contracting',
				'restoration-scheduled',
				'restored-awaiting-verification',
				'complete',
				'terminal-failure'
			]
		}).notNull(),
		admission: text('admission', { enum: ['closed', 'open'] }).notNull(),
		admissionRevision: integer('admission_revision').notNull().default(0),
		preContractBookmark: text('pre_contract_bookmark'),
		restoreUndoBookmark: text('restore_undo_bookmark'),
		claimId: text('claim_id'),
		claimRevision: integer('claim_revision').notNull().default(0),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull(),
		lastFailureJson: text('last_failure_json')
	},
	(table) => [
		primaryKey({ columns: [table.artifactId, table.instanceId, table.tenant] }),
		check(
			'local_contract_admission_revision_nonnegative',
			sql`${table.admissionRevision} >= 0`
		),
		check(
			'local_contract_claim_revision_nonnegative',
			sql`${table.claimRevision} >= 0`
		)
	]
);

// Ordinary D1 mutations use this revision as an admission token. Deployment
// control and the bounded repair executor have separate mutation classes.
export const d1AppMutationFence = sqliteTable(
	'd1_application_mutation_fence',
	{
		id: text('id').primaryKey(),
		state: text('state', { enum: ['open', 'closed'] }).notNull(),
		revision: integer('revision').notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check(
			'd1_application_mutation_fence_singleton',
			sql`${table.id} = 'application'`
		),
		check(
			'd1_application_mutation_fence_revision_nonnegative',
			sql`${table.revision} >= 0`
		)
	]
);

export const d1AppMutationAdmission = sqliteTable(
	'd1_application_mutation_admission',
	{
		id: text('id').primaryKey(),
		fenceRevision: integer('fence_revision').notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check(
			'd1_application_mutation_admission_revision_nonnegative',
			sql`${table.fenceRevision} >= 0`
		),
		index('d1_application_mutation_admission_drain_idx').on(
			table.fenceRevision,
			table.expiresAt
		)
	]
);

// Transition executors update these controls before advancing the manifest
// head. Tenant and control request paths read them when the transition needs to
// fence a representation independently of the current head state.
export const deploymentRuntimeControl = sqliteTable(
	'deployment_runtime_control',
	{
		id: text('id').primaryKey(),
		retentionAdministration: text('retention_administration', {
			enum: ['open', 'closed']
		}).notNull(),
		retentionRevision: integer('retention_revision').notNull(),
		legacyR2Writes: text('legacy_r2_writes', {
			enum: ['enabled', 'disabled']
		}).notNull(),
		legacyR2ReadFallback: text('legacy_r2_read_fallback', {
			enum: ['enabled', 'disabled']
		}).notNull(),
		legacyR2Deletion: text('legacy_r2_deletion', {
			enum: ['forbidden', 'eligible']
		}).notNull(),
		tenantLocalContractAdmission: text('tenant_local_contract_admission', {
			enum: ['not-required', 'required']
		}).notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check('deployment_runtime_control_singleton', sql`${table.id} = 'current'`),
		check(
			'deployment_runtime_control_retention_revision_nonnegative',
			sql`${table.retentionRevision} >= 0`
		)
	]
);

export const deploymentWriterCutover = sqliteTable(
	'deployment_writer_cutover',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		writerEpoch: text('writer_epoch').notNull(),
		cutoverAt: text('cutover_at').$type<IsoTimestamp>().notNull(),
		cohortCreatedAt: text('cohort_created_at').$type<IsoTimestamp>().notNull(),
		maximumLegacyDeadline: text('maximum_legacy_deadline')
			.$type<IsoTimestamp>()
			.notNull(),
		afterTenant: text('after_tenant').$type<TenantId>(),
		scanComplete: integer('scan_complete', { mode: 'boolean' })
			.notNull()
			.default(false),
		completedAt: text('completed_at').$type<IsoTimestamp>()
	},
	(table) => [primaryKey({ columns: [table.artifactId, table.instanceId] })]
);

export const deploymentWriterDrainTenant = sqliteTable(
	'deployment_writer_drain_tenant',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		tenant: text('tenant').$type<TenantId>().notNull(),
		status: text('status', {
			enum: ['pending', 'complete', 'not-applicable', 'failed']
		})
			.notNull()
			.default('pending'),
		attempts: integer('attempts').notNull().default(0),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull(),
		lastFailureJson: text('last_failure_json')
	},
	(table) => [
		primaryKey({ columns: [table.artifactId, table.instanceId, table.tenant] }),
		check(
			'deployment_writer_drain_tenant_attempts_nonnegative',
			sql`${table.attempts} >= 0`
		),
		index('deployment_writer_drain_tenant_work_idx').on(
			table.artifactId,
			table.instanceId,
			table.status,
			table.tenant
		)
	]
);

export const projectionRepairIntent = sqliteTable(
	'projection_repair_intent',
	{
		id: text('id').primaryKey(),
		tenant: text('tenant').$type<TenantId>().notNull(),
		writerEpoch: text('writer_epoch').notNull(),
		fenceRevision: integer('fence_revision').notNull(),
		status: text('status', {
			enum: ['pending', 'running', 'complete', 'rolled-back', 'failed']
		}).notNull(),
		operation: text('operation').notNull(),
		payloadJson: text('payload_json').notNull(),
		claimId: text('claim_id'),
		claimExpiresAt: text('claim_expires_at').$type<IsoTimestamp>(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull(),
		lastFailureJson: text('last_failure_json')
	},
	(table) => [
		check(
			'projection_repair_intent_fence_revision_nonnegative',
			sql`${table.fenceRevision} >= 0`
		),
		index('projection_repair_intent_work_idx').on(
			table.status,
			table.writerEpoch,
			table.tenant,
			table.id
		)
	]
);

export const deploymentD1RecoveryPoint = sqliteTable(
	'deployment_d1_recovery_point',
	{
		artifactId: text('artifact_id').notNull(),
		instanceId: text('instance_id').notNull(),
		transitionId: text('transition_id').notNull(),
		attemptId: text('attempt_id').notNull(),
		databaseId: text('database_id').notNull(),
		bookmark: text('bookmark').notNull(),
		envelopeKey: text('envelope_key').notNull(),
		envelopeSha256: text('envelope_sha256').notNull(),
		capturedAt: text('captured_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.artifactId, table.instanceId, table.transitionId]
		})
	]
);

export const freshInstallationBootstrap = sqliteTable(
	'fresh_installation_bootstrap',
	{
		databaseId: text('database_id').primaryKey(),
		accountId: text('account_id').notNull(),
		artifactId: text('artifact_id').notNull(),
		intendedResourcesJson: text('intended_resources_json').notNull(),
		observedResourcesJson: text('observed_resources_json').notNull(),
		instanceId: text('instance_id'),
		topologyDigest: text('topology_digest'),
		phase: text('phase', {
			enum: [
				'claimed',
				'resources-created',
				'topology-sealed',
				'schema-applied',
				'tenant-uploaded',
				'control-uploaded',
				'runtime-deployed',
				'administrator-onboarded',
				'complete'
			]
		}).notNull(),
		claimId: text('claim_id').notNull(),
		claimRevision: integer('claim_revision').notNull(),
		claimOwner: text('claim_owner').notNull(),
		claimExpiresAt: text('claim_expires_at').$type<IsoTimestamp>().notNull(),
		onboardingChallengeHash: text('onboarding_challenge_hash'),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check(
			'fresh_installation_claim_revision_nonnegative',
			sql`${table.claimRevision} >= 0`
		),
		check(
			'fresh_installation_topology_shape',
			sql`(${table.phase} IN ('claimed', 'resources-created') AND ${table.instanceId} IS NULL AND ${table.topologyDigest} IS NULL) OR (${table.phase} NOT IN ('claimed', 'resources-created') AND ${table.instanceId} IS NOT NULL AND ${table.topologyDigest} IS NOT NULL)`
		)
	]
);

export const successorDeploymentPreparation = sqliteTable(
	'successor_deployment_preparation',
	{
		predecessorArtifactId: text('predecessor_artifact_id').notNull(),
		predecessorInstanceId: text('predecessor_instance_id').notNull(),
		successorArtifactId: text('successor_artifact_id').notNull(),
		successorInstanceId: text('successor_instance_id').notNull(),
		predecessorStateId: text('predecessor_state_id').notNull(),
		predecessorRevision: integer('predecessor_revision').notNull(),
		transitionId: text('transition_id').notNull(),
		attemptId: text('attempt_id').notNull(),
		executionSnapshotJson: text('execution_snapshot_json').notNull(),
		status: text('status', {
			enum: ['prepared', 'adopting', 'complete', 'failed']
		}).notNull(),
		claimExpiresAt: text('claim_expires_at').$type<IsoTimestamp>().notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [
				table.predecessorArtifactId,
				table.predecessorInstanceId,
				table.successorArtifactId,
				table.successorInstanceId
			]
		}),
		check(
			'successor_preparation_revision_nonnegative',
			sql`${table.predecessorRevision} >= 0`
		)
	]
);

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
