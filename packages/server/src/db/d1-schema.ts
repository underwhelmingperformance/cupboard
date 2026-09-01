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
import { sql } from 'drizzle-orm';
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
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL)`
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
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL)`
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
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL)`
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

// The applied digest prevents a migration file from changing under an existing
// name. Both bootstrap and ordinary deployment transitions consult this table.
export const structuralMigrationChecksum = sqliteTable(
	'structural_migration_checksum',
	{
		kind: text('kind', { enum: ['d1', 'durable-object'] }).notNull(),
		migrationId: text('migration_id').notNull(),
		sha256: text('sha256').notNull(),
		appliedAt: text('applied_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.kind, table.migrationId] }),
		check(
			'structural_migration_checksum_sha256',
			sql`length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`
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
			sql`(${table.cacheKind} = 'default' AND ${table.cacheName} IS NULL) OR (${table.cacheKind} = 'named' AND ${table.cacheName} IS NOT NULL)`
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
