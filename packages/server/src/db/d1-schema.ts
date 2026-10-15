import {
	type AuthKeyId,
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
import {
	type ArtifactJobGeneration,
	artifactJobGenerationSchema,
	type ArtifactJobId,
	type ArtifactTaskGeneration,
	type ArtifactTaskId,
	type ArtifactTaskOwner
} from '@cupboard/protocol/artifact-jobs';
import {
	type ArtifactGeneration,
	type ArtifactId,
	type ArtifactKind,
	artifactKinds,
	type ListingGeneratorRevision,
	type NarListingFact
} from '@cupboard/protocol/artifacts';
import type { LocalStep } from '@cupboard/protocol/deployment';
import type { InstanceName } from '@cupboard/protocol/instance';
import type {
	OidcIssuer,
	OidcSubject,
	TrustRuleId
} from '@cupboard/protocol/oidc';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type { UploadId } from '@cupboard/protocol/upload';
import type { ReadUser } from '@cupboard/shared/http';
import { type SQL, sql, type SQLWrapper } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	sqliteView,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

import type { ArtifactStageId } from '../blob/artifact-staging.ts';
import type {
	ListingAdoptionCaptureSequence,
	ListingAdoptionCaptureSource
} from '../blob/listing-adoption-capture.ts';
import type { ListingAdoptionParentId } from '../blob/listing-adoption-parents.ts';
import type { ListingAdoptionSeedEpoch } from '../blob/listing-adoption-seed.ts';
import {
	type NarCaptureSequence,
	narCaptureSequenceSchema
} from '../blob/nar-source-capture.ts';
import type {
	SharedListingCompletionId,
	SharedListingTaskOutcome,
	SharedListingTaskReason
} from '../blob/shared-listing-completion.ts';
import type { SharedListingDispatchId } from '../blob/shared-listing-dispatch.ts';
import type { SharedListingJobSummary } from '../blob/shared-listing-jobs.ts';
import type { SharedListingOutputEpoch } from '../blob/shared-listing-outputs.ts';
import type { SharedListingTaskClaim } from '../blob/shared-listing-tasks.ts';
import type { SharedListingTaskState } from '../blob/shared-listing-tasks.ts';
import type { R2ObjectKey } from '../http/http.ts';
import {
	type ReadPasswordHash,
	type ReadPasswordSalt
} from '../read/read-auth.ts';

// A default cache has no name and a named cache has one. Every table that
// refers to a cache by its identity columns carries this constraint, so a row
// cannot describe a cache that does not exist.
function cacheIdentityConstraint(kind: SQLWrapper, name: SQLWrapper): SQL {
	return sql`(${kind} = 'default' AND ${name} IS NULL) OR (${kind} = 'named' AND ${name} IS NOT NULL)`;
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
// an abandoned promotion when its `blob_state` or `cas_object_storage` row is missing.
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
// or `cas_object_storage` row has been deleted. Maintenance deletes the exact R2 key at
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
// targets a captured `(tenant, cache_kind, cache_name, store_path_hash,
// generation)` and so can never remove a newer recommitted edge. The `nar_hash`
// index backs the reaper's "is this hash referenced anywhere" probe, which is on
// a non-key column.
//
// A default cache stores a null name, and SQLite treats nulls in a unique index
// as distinct, so each cache kind has its own partial unique index rather than
// one primary key over the identity columns.
//
// NAR reads select candidates from the partial readable index, then check each
// candidate's path revocation fence. Cache selectors and access policy may
// exclude earlier candidates before the read finds an authorised reference.
export const blobReference = sqliteTable(
	'blob_ref_storage',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		readable: integer('readable', { mode: 'boolean' }).notNull().default(true),
		// The generation of the cache name when this edge was committed.
		cacheGeneration: integer('cache_generation')
			.$type<CacheGeneration>()
			.notNull()
	},
	(table) => [
		check(
			'blob_ref_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
		),
		uniqueIndex('blob_ref_default_identity_idx')
			.on(table.tenant, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('blob_ref_named_identity_idx')
			.on(table.tenant, table.cacheName, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'named'`),
		index('blob_ref_readable_path_idx')
			.on(
				table.tenant,
				table.cacheKind,
				table.cacheName,
				table.storePathHash,
				table.cacheGeneration,
				table.generation
			)
			.where(sql`${table.readable} = true`),
		index('blob_ref_readable_cache_generation_idx')
			.on(
				table.tenant,
				table.cacheKind,
				table.cacheName,
				table.cacheGeneration,
				table.storePathHash,
				table.generation
			)
			.where(sql`${table.readable} = true`),
		index('blob_ref_readable_nar_idx')
			.on(
				table.tenant,
				table.narHash,
				table.cacheKind,
				table.cacheName,
				table.cacheGeneration
			)
			.where(sql`${table.readable} = true`),
		index('blob_ref_nar_hash_idx').on(table.narHash),
		index('blob_ref_path_lifecycle_generation_idx').on(
			table.tenant,
			table.cacheKind,
			table.cacheName,
			table.storePathHash,
			table.cacheGeneration,
			table.generation
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

export const pathReadRevocation = sqliteTable(
	'path_read_revocation',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		cacheGeneration: integer('cache_generation')
			.$type<CacheGeneration>()
			.notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		isPending: integer('is_pending', { mode: 'boolean' })
			.notNull()
			.default(true)
	},
	(table) => [
		check(
			'path_read_revocation_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
		),
		uniqueIndex('path_read_revocation_default_identity_idx')
			.on(table.tenant, table.storePathHash)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('path_read_revocation_named_identity_idx')
			.on(table.tenant, table.cacheName, table.storePathHash)
			.where(sql`${table.cacheKind} = 'named'`),
		index('path_read_revocation_pending_idx')
			.on(table.tenant, table.cacheKind, table.cacheName, table.storePathHash)
			.where(sql`${table.isPending} = true`),
		index('path_read_revocation_native_identity_idx').on(
			table.tenant,
			table.cacheKind,
			table.cacheName,
			table.storePathHash
		)
	]
);

export const publication = sqliteTable(
	'publication',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		uploadId: text('upload_id').$type<UploadId>(),
		// The generation of the cache name when this edge was committed.
		cacheGeneration: integer('cache_generation')
			.$type<CacheGeneration>()
			.notNull()
	},
	(table) => [
		check(
			'publication_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
		),
		uniqueIndex('publication_default_identity_idx')
			.on(table.tenant, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('publication_named_identity_idx')
			.on(table.tenant, table.cacheName, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'named'`)
	]
);

// The current generation of one cache name. Only reference edges from this
// generation authorise a read. Deleting a cache advances the generation in one
// write, which revokes all of the cache's existing edges before physical
// cleanup begins. A later cache with the same name uses the advanced generation
// and cannot reach the previous cache's edges.
//
// A missing lifecycle row represents generation 1. The first deletion writes
// generation 2 and immediately revokes those edges.
export const cacheLifecycle = sqliteTable(
	'cache_lifecycle_storage',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		access: text('access', { enum: ['public', 'private'] }).notNull(),
		generation: integer('generation').$type<CacheGeneration>().notNull(),
		// The version of how the cache reads. A deletion advances it, and so
		// does a registration whose access differs from the recorded one. The
		// Workers Cache key for a public read carries it.
		readRevision: integer('read_revision')
			.$type<CacheReadRevision>()
			.notNull()
			.default(cacheReadRevisionSchema.parse(1)),
		// When the cache was last deleted, and null while it is live. Deletion sets
		// it in the same statement that advances the generation, and registering
		// the cache name again clears it.
		//
		// Content reads reject a deleted cache before teardown removes its
		// published narinfo and attestation state.
		//
		// The NAR reference query does not inspect this column. Deletion advances
		// the lifecycle generation, which invalidates every existing reference
		// edge. Registering the cache again clears this column before the new
		// cache can commit an edge, and the new edge records the advanced
		// generation. A generation-authorised edge therefore belongs to the
		// cache's live incarnation.
		deletedAt: text('deleted_at').$type<IsoTimestamp>(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check(
			'cache_lifecycle_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
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
		)
	]
);

export const precedingCacheAdmission = sqliteView('cache_lifecycle').as(
	(query) =>
		query
			.select()
			.from(cacheLifecycle)
			.where(sql`false`)
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

// An operator's sign-in session: a refresh-token family issued by a control
// token exchange. It has the shape of the tenant object's
// `refresh_session_family`. Rotation advances the active member with a
// conditional update, and spent members remain until the family expires so a
// replay can revoke the family.
export const controlRefreshSessionFamily = sqliteTable(
	'control_refresh_session_family',
	{
		id: text('id').primaryKey(),
		activeMemberId: text('active_member_id').notNull(),
		generation: integer('generation').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull(),
		issuer: text('issuer').$type<OidcIssuer>().notNull(),
		subject: text('subject').$type<OidcSubject>().notNull(),
		rule: text('rule').$type<TrustRuleId>()
	},
	(table) => [
		uniqueIndex('control_refresh_session_family_active_member_unique').on(
			table.activeMemberId
		),
		index('control_refresh_session_family_expires_at_idx').on(
			table.expiresAt,
			table.id
		)
	]
);

export const controlRefreshSessionMember = sqliteTable(
	'control_refresh_session_member',
	{
		id: text('id').primaryKey(),
		familyId: text('family_id').notNull(),
		generation: integer('generation').notNull(),
		credentialHash: text('credential_hash').notNull(),
		successorEnvelope: text('successor_envelope'),
		successorExpiresAt: text('successor_expires_at').$type<IsoTimestamp>(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		uniqueIndex('control_refresh_session_member_family_generation_unique').on(
			table.familyId,
			table.generation
		),
		index('control_refresh_session_member_successor_expiry_idx')
			.on(table.successorExpiresAt, table.id)
			.where(sql`${table.successorExpiresAt} IS NOT NULL`)
	]
);

// The nonce of each target-bound subject token that the control plane or
// `/signup` has accepted. Each row is kept until verification would refuse the
// token anyway. `family_id` is the refresh family that the same batch creates,
// and it is NULL when the exchange starts no family.
export const controlConsumedSubjectNonce = sqliteTable(
	'control_consumed_subject_nonce',
	{
		nonce: text('nonce').primaryKey(),
		familyId: text('family_id'),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		index('control_consumed_subject_nonce_expires_at_idx').on(table.expiresAt)
	]
);

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
		retryActiveElapsedMs: integer('retry_active_elapsed_ms')
			.notNull()
			.default(0),
		retryActiveSinceMs: integer('retry_active_since_ms'),
		// Null until a later release's cache reconciliation records the version
		// it reached for this tenant. Nothing in this build reads or writes it.
		cacheCatalogueVersion: integer('cache_catalogue_version'),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		// These columns hold the tenant's fallback read verifier: the Basic-auth
		// user, salt, and password verifier. A cache-specific verifier takes
		// precedence over them. An incomplete verifier rejects every read; the
		// plaintext password is never stored.
		readUser: text('read_user').$type<ReadUser>(),
		readPasswordHash: text('read_password_hash').$type<ReadPasswordHash>(),
		readPasswordSalt: text('read_password_salt').$type<ReadPasswordSalt>(),
		// Scheduled maintenance processes the least recently maintained active
		// tenants first. Null sorts first, so a new tenant is selected promptly.
		lastMaintainedAt: text('last_maintained_at').$type<IsoTimestamp>(),
		// The highest local step this tenant's Durable Object has reported. Null
		// means the control Worker has not woken it since the column was added.
		localStep: integer('local_step').$type<LocalStep>(),
		localSchemaVersion: integer('local_schema_version'),
		localSchemaMigration: text('local_schema_migration'),
		// When a page of this tenant's local-step work last ran, or when a wake
		// last failed to reach its object. Each write replaces the last one. A
		// page that records the step clears it.
		localStepAttemptedAt: text('local_step_attempted_at').$type<IsoTimestamp>(),
		// When a page last made progress: it recorded a higher step, or it
		// projected, moved or rewrote an item, or committed migration work.
		localStepProgressedAt: text(
			'local_step_progressed_at'
		).$type<IsoTimestamp>(),
		// A summary of the error from the last attempt, or null when the last
		// attempt did not fail.
		localStepError: text('local_step_error')
	},
	(table) => [
		index('tenant_maintenance_idx').on(table.status, table.lastMaintainedAt)
	]
);

// One cache's own read verifier, keyed by the cache's identity. Private reads
// use this verifier before the tenant's fallback credential. Deleting
// a cache deletes its row, so a cache created later under the same name has no
// verifier of its own, and its readers authenticate with the tenant credential
// until an operator sets one. Finalising an offboarded tenant deletes all of its
// cache-verifier rows.
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
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
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

// One row per schema transition that a deploy has started, keyed by the
// transition id from `@cupboard/protocol/deployment`. `expanded` means that the
// transition's expand migrations are applied, and `complete` means that its
// contract migrations are applied too. `contracted_at` is set before the first
// contract migration runs, so a build that does not define the transition can
// tell whether those migrations may have removed anything. Other releases
// write ids and states that this build does not define, so the columns are
// plain text and readers parse them. The deploy writes the rows. The Workers
// read them to gate behaviour on a transition being complete, and the control
// Worker reports them through `deployment.transitions`.
export const deploymentTransition = sqliteTable('deployment_transition', {
	id: text('id').primaryKey(),
	state: text('state').notNull(),
	updatedAt: text('updated_at').notNull(),
	contractedAt: text('contracted_at')
});

// v0.0.34 and v0.0.35 read their deployment phase from this one-row table.
// `cupboard deploy` writes it for the `cache-identity` transition so that a
// rollback to one of those releases reads a correct phase. This build's
// Workers do not read it. The deploy reads it to reconcile the recorded
// transitions.
export const deploymentPhase = sqliteTable('deployment_phase', {
	id: text('id').primaryKey(),
	phase: text('phase').notNull(),
	requiredLocalStep: integer('required_local_step')
		.$type<LocalStep>()
		.notNull(),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
});

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

// A row records measured bytes at the physical R2 key for one CAS incarnation.
// The logical publication services validate the bytes before granting access.
export const casObject = sqliteTable(
	'cas_object_storage',
	{
		digest: text('digest').$type<Sha256HexDigest>().primaryKey(),
		size: integer('size').notNull(),
		incarnation: integer('incarnation').notNull().default(1),
		storedAt: text('stored_at').$type<IsoTimestamp>().notNull(),
		deleteAfter: text('delete_after').$type<IsoTimestamp>()
	},
	(table) => [index('cas_object_delete_after_idx').on(table.deleteAfter)]
);

export const casDemotionProgress = sqliteTable(
	'cas_demotion_progress',
	{
		digest: text('digest').$type<Sha256HexDigest>().primaryKey(),
		incarnation: integer('incarnation').notNull(),
		afterTenant: text('after_tenant').$type<TenantId>(),
		revision: integer('revision').notNull().default(1),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		index('cas_demotion_progress_ready_idx').on(
			table.updatedAt,
			table.revision,
			table.digest
		),
		check(
			'cas_demotion_progress_incarnation_check',
			sql`${table.incarnation} >= 1`
		),
		check('cas_demotion_progress_revision_check', sql`${table.revision} >= 1`)
	]
);

// One attestation reference for one committed narinfo generation. Like `blob_ref`,
// generation is part of the key so stale deletion can retire only the captured
// narinfo version and never a later recommit.
export const attestationReference = sqliteTable(
	'attestation_ref_storage',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		predicateType: text('predicate_type').$type<PredicateType>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		readable: integer('readable', { mode: 'boolean' }).notNull().default(true)
	},
	(table) => [
		check(
			'attestation_ref_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
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
		// The identity indexes are partial, so SQLite uses them only for a query
		// that specifies `cache_kind`. Attestation inheritance searches every
		// cache in the tenant for a path.
		index('attestation_ref_tenant_path_idx').on(
			table.tenant,
			table.storePathHash,
			table.generation
		),
		index('attestation_ref_readable_path_idx')
			.on(
				table.tenant,
				table.cacheKind,
				table.cacheName,
				table.storePathHash,
				table.generation,
				table.predicateType,
				table.digest
			)
			.where(sql`${table.readable} = true`),
		index('attestation_ref_readable_digest_idx')
			.on(
				table.tenant,
				table.cacheKind,
				table.cacheName,
				table.digest,
				table.storePathHash,
				table.generation
			)
			.where(sql`${table.readable} = true`),
		index('attestation_ref_digest_idx').on(table.digest),
		index('attestation_ref_digest_tenant_idx').on(table.digest, table.tenant),
		index('attestation_ref_tenant_digest_idx').on(table.tenant, table.digest)
	]
);

export const attestationListRevision = sqliteTable(
	'attestation_list_revision',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		revision: integer('revision').notNull().default(1),
		publishedRevision: integer('published_revision'),
		publishedCacheGeneration: integer(
			'published_cache_generation'
		).$type<CacheGeneration>(),
		publishedNarHash: text('published_nar_hash').$type<NixSha256HashString>(),
		publishedKey: text('published_key').$type<R2ObjectKey>(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		check(
			'attestation_list_revision_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
		),
		check(
			'attestation_list_revision_number_check',
			sql`${table.revision} BETWEEN 1 AND 9007199254740991`
		),
		check(
			'attestation_list_revision_publication_check',
			sql`(${table.publishedRevision} IS NULL AND ${table.publishedCacheGeneration} IS NULL AND ${table.publishedNarHash} IS NULL AND ${table.publishedKey} IS NULL) OR (${table.publishedRevision} IS NOT NULL AND ${table.publishedRevision} BETWEEN 1 AND ${table.revision} AND ${table.publishedCacheGeneration} >= 1 AND ${table.publishedCacheGeneration} IS NOT NULL AND ${table.publishedNarHash} IS NOT NULL)`
		),
		uniqueIndex('attestation_list_revision_default_idx')
			.on(table.tenant, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('attestation_list_revision_named_idx')
			.on(table.tenant, table.cacheName, table.storePathHash, table.generation)
			.where(sql`${table.cacheKind} = 'named'`),
		index('attestation_list_revision_pending_idx')
			.on(table.tenant, table.id)
			.where(
				sql`${table.publishedRevision} IS NULL OR ${table.publishedRevision} != ${table.revision}`
			)
	]
);

// Each tenant has one presence row per CAS digest across all reference kinds.
// The presence row determines the size charged to that tenant.
export const tenantCasBlob = sqliteTable(
	'tenant_cas_blob_storage',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		size: integer('size').notNull()
	},
	(table) => [primaryKey({ columns: [table.tenant, table.digest] })]
);

export const precedingCasObject = sqliteView('cas_object').as((query) =>
	query.select().from(casObject)
);

export const precedingTenantCasBlob = sqliteView('tenant_cas_blob').as(
	(query) => query.select().from(tenantCasBlob)
);

export const tenantNamespaceCleanupGuard = sqliteTable(
	'tenant_namespace_cleanup_guard',
	{
		tenant: text('tenant').$type<TenantId>().primaryKey(),
		startedAt: text('started_at').$type<IsoTimestamp>().notNull(),
		notBefore: text('not_before').$type<IsoTimestamp>().notNull()
	}
);

// The authoritative per-tenant usage and quota counter. `bytes`/`blobs` are NAR
// storage only, matching `tenant_blob`; `cas_bytes`/`cas_blobs` are shared CAS
// storage only, matching `tenant_cas_blob_storage`. `narinfos` is the committed-narinfo
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

export const localStepWakeCursor = sqliteTable('local_step_wake_cursor', {
	id: integer('id').primaryKey(),
	afterTenant: text('after_tenant').$type<TenantId>().notNull()
});

export const readableBlobReference = sqliteView('blob_ref').as((query) =>
	query.select().from(blobReference)
		.where(sql`${blobReference.readable} = true AND NOT EXISTS (
		SELECT 1 FROM path_read_revocation AS fence
		WHERE fence.tenant = ${blobReference.tenant}
		 AND fence.cache_kind = ${blobReference.cacheKind}
		 AND fence.cache_name IS ${blobReference.cacheName}
		 AND fence.store_path_hash = ${blobReference.storePathHash}
		 AND fence.cache_generation = ${blobReference.cacheGeneration}
		 AND fence.generation >= ${blobReference.generation}
	)`)
);

export const readableAttestationReference = sqliteView('attestation_ref').as(
	(query) =>
		query.select().from(attestationReference)
			.where(sql`${attestationReference.readable} = true AND EXISTS (
		SELECT 1 FROM ${readableBlobReference}
		WHERE ${readableBlobReference.tenant} = ${attestationReference.tenant}
		 AND ${readableBlobReference.cacheKind} = ${attestationReference.cacheKind}
		 AND ${readableBlobReference.cacheName} IS ${attestationReference.cacheName}
		 AND ${readableBlobReference.storePathHash} = ${attestationReference.storePathHash}
		 AND ${readableBlobReference.generation} = ${attestationReference.generation}
	)`)
);

export const controlDatabaseSplit = sqliteTable('control_database_split', {
	id: text('id').primaryKey(),
	targetDatabaseId: text('target_database_id').notNull(),
	frozenAt: text('frozen_at').notNull(),
	copiedAt: text('copied_at')
});

export const artifactReference = sqliteTable(
	'artifact_ref',
	{
		tenant: text('tenant').$type<TenantId>().notNull(),
		artifactId: text('artifact_id').$type<ArtifactId>().notNull(),
		artifactGeneration: integer('artifact_generation')
			.$type<ArtifactGeneration>()
			.notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		cacheGeneration: integer('cache_generation')
			.$type<CacheGeneration>()
			.notNull(),
		kind: text('kind', { enum: artifactKinds }).$type<ArtifactKind>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.tenant, table.artifactId, table.artifactGeneration]
		}),
		index('artifact_ref_digest_idx').on(table.digest, table.tenant),
		index('artifact_ref_tenant_digest_idx').on(table.tenant, table.digest),
		index('artifact_ref_cache_idx').on(
			table.tenant,
			table.cacheKind,
			table.cacheName,
			table.cacheGeneration,
			table.artifactId,
			table.artifactGeneration
		),
		check(
			'artifact_ref_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
		),
		check(
			'artifact_ref_generation_check',
			sql`${table.artifactGeneration} >= 1`
		),
		check(
			'artifact_ref_cache_generation_check',
			sql`${table.cacheGeneration} >= 1`
		)
	]
);

export const listingFact = sqliteTable(
	'listing_fact',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		format: integer('format').$type<1>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		size: integer('size').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.narHash, table.generatorRevision] }),
		check('listing_fact_format_check', sql`${table.format} = 1`),
		check('listing_fact_size_check', sql`${table.size} > 0`)
	]
);

export const listingAdoptionFact = sqliteTable(
	'listing_adoption_fact',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.narHash, table.generatorRevision] }),
		index('listing_adoption_fact_digest_identity_idx').on(
			table.digest,
			table.narHash,
			table.generatorRevision
		)
	]
);

export const listingAdoptionParent = sqliteTable(
	'listing_adoption_parent',
	{
		id: text('id')
			.$type<ListingAdoptionParentId>()
			.primaryKey()
			.notNull()
			.default(sql`(lower(hex(randomblob(16))))`),
		tenant: text('tenant').$type<TenantId>().notNull(),
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }).notNull(),
		cacheName: text('cache_name').$type<CacheName>(),
		cacheGeneration: integer('cache_generation')
			.$type<CacheGeneration>()
			.notNull(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		generation: integer('generation').$type<NarInfoGeneration>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		updatedAt: text('updated_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
	},
	(table) => [
		check(
			'listing_adoption_parent_id_check',
			sql`length(${table.id}) = 32 AND ${table.id} NOT GLOB '*[^0-9a-f]*'`
		),
		check(
			'listing_adoption_parent_cache_identity_check',
			cacheIdentityConstraint(table.cacheKind, table.cacheName)
		),
		check(
			'listing_adoption_parent_generation_check',
			sql`typeof(${table.generation}) = 'integer' AND ${table.generation} BETWEEN 0 AND 9007199254740991 AND typeof(${table.cacheGeneration}) = 'integer' AND ${table.cacheGeneration} BETWEEN 1 AND 9007199254740991`
		),
		uniqueIndex('listing_adoption_parent_default_identity_idx')
			.on(table.tenant, table.storePathHash)
			.where(sql`${table.cacheKind} = 'default'`),
		uniqueIndex('listing_adoption_parent_named_identity_idx')
			.on(table.tenant, table.cacheName, table.storePathHash)
			.where(sql`${table.cacheKind} = 'named'`),
		index('listing_adoption_parent_nar_id_idx').on(table.narHash, table.id),
		index('listing_adoption_parent_tenant_id_idx').on(table.tenant, table.id)
	]
);

export const listingAdoptionFactSeed = sqliteTable(
	'listing_adoption_fact_seed',
	{
		id: integer('id').primaryKey(),
		epoch: text('epoch')
			.$type<ListingAdoptionSeedEpoch>()
			.notNull()
			.default(sql`(lower(hex(randomblob(16))))`),
		afterNarHash: text('after_nar_hash').$type<NixSha256HashString>(),
		afterGeneratorRevision: text(
			'after_generator_revision'
		).$type<ListingGeneratorRevision>(),
		throughNarHash: text('through_nar_hash').$type<NixSha256HashString>(),
		throughGeneratorRevision: text(
			'through_generator_revision'
		).$type<ListingGeneratorRevision>(),
		scanned: integer('scanned').notNull().default(0),
		captured: integer('captured').notNull().default(0),
		isComplete: integer('is_complete', { mode: 'boolean' })
			.notNull()
			.default(false),
		updatedAt: text('updated_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
	},
	(table) => [
		check('listing_adoption_fact_seed_id_check', sql`${table.id} = 1`),
		check(
			'listing_adoption_fact_seed_epoch_check',
			sql`length(${table.epoch}) = 32 AND ${table.epoch} NOT GLOB '*[^0-9a-f]*'`
		),
		check(
			'listing_adoption_fact_seed_cursor_check',
			sql`${table.isComplete} IN (0,1) AND (${table.afterNarHash} IS NULL) = (${table.afterGeneratorRevision} IS NULL)
 AND (${table.throughNarHash} IS NULL) = (${table.throughGeneratorRevision} IS NULL)
 AND (${table.throughNarHash} IS NOT NULL OR ${table.isComplete} = 1)
 AND (${table.afterNarHash} IS NULL OR (${table.throughNarHash} IS NOT NULL AND (${table.afterNarHash},${table.afterGeneratorRevision}) <= (${table.throughNarHash},${table.throughGeneratorRevision})))
 AND (${table.isComplete} = 0 OR ${table.throughNarHash} IS NULL OR (${table.afterNarHash} IS NOT NULL AND (${table.afterNarHash},${table.afterGeneratorRevision}) = (${table.throughNarHash},${table.throughGeneratorRevision})))`
		),
		check(
			'listing_adoption_fact_seed_counts_check',
			sql`typeof(${table.scanned}) = 'integer' AND ${table.scanned} BETWEEN 0 AND 9007199254740991
 AND typeof(${table.captured}) = 'integer' AND ${table.captured} BETWEEN 0 AND ${table.scanned}`
		)
	]
);

export const listingAdoptionCaptureEvent = sqliteTable(
	'listing_adoption_capture_event',
	{
		id: integer('id')
			.$type<ListingAdoptionCaptureSequence>()
			.primaryKey({ autoIncrement: true }),
		source: text('source', { mode: 'json' })
			.$type<ListingAdoptionCaptureSource>()
			.notNull(),
		createdAt: text('created_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
	},
	(table) => [
		check(
			'listing_adoption_capture_event_id_check',
			sql`${table.id} BETWEEN 1 AND 9007199254740991`
		),
		check(
			'listing_adoption_capture_event_source_check',
			sql`coalesce(json_valid(${table.source}) AND json_type(${table.source}) = 'object' AND json_extract(${table.source}, '$.kind') IN ('parent','listing','cas'), 0)`
		)
	]
);

export const listingAdoptionCaptureState = sqliteTable(
	'listing_adoption_capture_state',
	{
		id: integer('id').primaryKey(),
		latest: integer('latest')
			.$type<ListingAdoptionCaptureSequence>()
			.notNull()
			.default(sql`0`),
		prunedThrough: integer('pruned_through')
			.$type<ListingAdoptionCaptureSequence>()
			.notNull()
			.default(sql`0`),
		isReady: integer('is_ready', { mode: 'boolean' }).notNull().default(false)
	},
	(table) => [
		check('listing_adoption_capture_state_id_check', sql`${table.id} = 1`),
		check(
			'listing_adoption_capture_state_position_check',
			sql`${table.prunedThrough} BETWEEN 0 AND ${table.latest} AND ${table.latest} <= 9007199254740991`
		)
	]
);

export const sharedListingOutputReference = sqliteTable(
	'shared_listing_output_ref',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		epoch: text('epoch').$type<SharedListingOutputEpoch>().notNull(),
		sourceIncarnation: integer('source_incarnation').notNull(),
		computationGeneration: integer('computation_generation').notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		size: integer('size').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.narHash, table.generatorRevision] }),
		index('shared_listing_output_ref_digest_idx').on(table.digest),
		check(
			'shared_listing_output_ref_generation_check',
			sql`typeof(${table.sourceIncarnation}) = 'integer' AND ${table.sourceIncarnation} BETWEEN 1 AND 9007199254740991
  AND typeof(${table.computationGeneration}) = 'integer' AND ${table.computationGeneration} BETWEEN 1 AND 9007199254740991`
		),
		check(
			'shared_listing_output_ref_size_check',
			sql`typeof(${table.size}) = 'integer' AND ${table.size} BETWEEN 1 AND 67108864`
		)
	]
);

export const sharedListingOutputCleanup = sqliteTable(
	'shared_listing_output_cleanup',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().primaryKey(),
		epoch: text('epoch')
			.notNull()
			.default(sql`(lower(hex(randomblob(16))))`),
		cursor: text('cursor').$type<ListingGeneratorRevision>(),
		owner: text('owner').$type<ArtifactTaskOwner>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		nextAttemptAt: text('next_attempt_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`'1970-01-01T00:00:00.000Z'`)
	},
	(table) => [
		index('shared_listing_output_cleanup_due_idx').on(
			table.nextAttemptAt,
			table.narHash
		),
		check(
			'shared_listing_output_cleanup_epoch_check',
			sql`length(${table.epoch}) = 32 AND ${table.epoch} NOT GLOB '*[^0-9a-f]*'`
		),
		check(
			'shared_listing_output_cleanup_owner_check',
			sql`(${table.owner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.owner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
		)
	]
);

export const sharedListingStage = sqliteTable(
	'shared_listing_stage',
	{
		id: text('id').$type<ArtifactStageId>().primaryKey(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		sourceIncarnation: integer('source_incarnation').notNull(),
		computationGeneration: integer('computation_generation').notNull(),
		r2Key: text('r2_key').$type<R2ObjectKey>().notNull(),
		maximumBytes: integer('maximum_bytes').notNull(),
		state: text('state', { enum: ['pending', 'ready', 'retired'] }).notNull(),
		multipartId: text('multipart_id'),
		writesSealed: integer('writes_sealed', { mode: 'boolean' })
			.notNull()
			.default(false),
		digest: text('digest').$type<Sha256HexDigest>(),
		size: integer('size'),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull(),
		writeUntil: text('write_until').$type<IsoTimestamp>().notNull(),
		cleanupAfter: text('cleanup_after').$type<IsoTimestamp>().notNull(),
		nextCleanupAt: text('next_cleanup_at').$type<IsoTimestamp>().notNull(),
		cleanupGeneration: integer('cleanup_generation').notNull().default(0),
		cleanupOwner: text('cleanup_owner').$type<ArtifactTaskOwner>(),
		cleanupLeaseExpiresAt: text(
			'cleanup_lease_expires_at'
		).$type<IsoTimestamp>()
	},
	(table) => [
		uniqueIndex('shared_listing_stage_computation_idx').on(
			table.narHash,
			table.generatorRevision,
			table.computationGeneration
		),
		index('shared_listing_stage_recovery_idx').on(
			table.narHash,
			table.generatorRevision,
			table.state,
			table.cleanupAfter,
			table.id
		),
		index('shared_listing_stage_cleanup_idx').on(table.nextCleanupAt, table.id),
		check(
			'shared_listing_stage_state_check',
			sql`${table.state} IN ('pending', 'ready', 'retired')`
		),
		check(
			'shared_listing_stage_generation_check',
			sql`typeof(${table.sourceIncarnation}) = 'integer' AND ${table.sourceIncarnation} BETWEEN 1 AND 9007199254740991
		AND typeof(${table.computationGeneration}) = 'integer' AND ${table.computationGeneration} BETWEEN 1 AND 9007199254740991
		AND typeof(${table.cleanupGeneration}) = 'integer' AND ${table.cleanupGeneration} BETWEEN 0 AND 9007199254740991`
		),
		check(
			'shared_listing_stage_budget_check',
			sql`typeof(${table.maximumBytes}) = 'integer' AND ${table.maximumBytes} BETWEEN 1 AND 67108864
		AND (${table.size} IS NULL OR (typeof(${table.size}) = 'integer' AND ${table.size} BETWEEN 0 AND ${table.maximumBytes}))`
		),
		check(
			'shared_listing_stage_seal_check',
			sql`(${table.writesSealed} = 0 AND ${table.digest} IS NULL AND ${table.size} IS NULL)
		OR (${table.writesSealed} = 1 AND ${table.multipartId} IS NOT NULL AND ${table.digest} IS NOT NULL AND ${table.size} IS NOT NULL)`
		),
		check(
			'shared_listing_stage_ready_check',
			sql`${table.state} <> 'ready' OR ${table.writesSealed} = 1`
		),
		check(
			'shared_listing_stage_cleanup_claim_check',
			sql`(${table.cleanupGeneration} = 0 AND ${table.cleanupOwner} IS NULL AND ${table.cleanupLeaseExpiresAt} IS NULL)
		OR (${table.cleanupGeneration} > 0 AND ${table.cleanupOwner} IS NOT NULL AND ${table.state} = 'retired')`
		)
	]
);

export const listingGeneration = sqliteTable(
	'listing_generation',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		sourceIncarnation: integer('source_incarnation').notNull(),
		generation: integer('generation').notNull(),
		tenant: text('tenant').$type<TenantId>(),
		owner: text('owner').$type<ArtifactTaskOwner>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.narHash, table.generatorRevision] }),
		index('listing_generation_tenant_idx').on(
			table.tenant,
			table.narHash,
			table.generatorRevision
		),
		check(
			'listing_generation_version_check',
			sql`${table.sourceIncarnation} >= 1 AND ${table.generation} BETWEEN 1 AND 9007199254740991`
		),
		check(
			'listing_generation_ownership_check',
			sql`(${table.tenant} IS NULL AND ${table.owner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.tenant} IS NOT NULL AND ${table.owner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
		)
	]
);

export const sharedListingJob = sqliteTable(
	'shared_listing_job',
	{
		id: text('id').$type<ArtifactJobId>().primaryKey(),
		generation: integer('generation')
			.$type<ArtifactJobGeneration>()
			.notNull()
			.default(artifactJobGenerationSchema.parse(1)),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		state: text('state')
			.$type<SharedListingJobSummary['state']>()
			.notNull()
			.default('running'),
		phase: text('phase')
			.$type<SharedListingJobSummary['phase']>()
			.notNull()
			.default('historical'),
		cursor: text('cursor').$type<NixSha256HashString>(),
		eventCursor: integer('event_cursor')
			.$type<NarCaptureSequence>()
			.notNull()
			.default(narCaptureSequenceSchema.parse(0)),
		eventThrough: integer('event_through').$type<NarCaptureSequence>(),
		discovered: integer('discovered').notNull().default(0),
		completed: integer('completed').notNull().default(0),
		skipped: integer('skipped').notNull().default(0),
		failed: integer('failed').notNull().default(0),
		claimGeneration: integer('claim_generation').notNull().default(0),
		owner: text('owner').$type<ArtifactTaskOwner>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		index('shared_listing_job_capture_idx').on(table.phase, table.eventCursor),
		check(
			'shared_listing_job_generation_check',
			sql`${table.generation} BETWEEN 1 AND 9007199254740991 AND ${table.claimGeneration} BETWEEN 0 AND 9007199254740991`
		),
		check(
			'shared_listing_job_state_check',
			sql`${table.state} IN ('running', 'cancelled', 'complete') AND ${table.phase} IN ('historical', 'catchup', 'processing')`
		),
		check(
			'shared_listing_job_progress_check',
			sql`${table.completed} >= 0 AND ${table.skipped} >= 0 AND ${table.failed} >= 0 AND ${table.discovered} BETWEEN 0 AND 9007199254740991 AND ${table.discovered} >= ${table.completed} + ${table.skipped} + ${table.failed}`
		),
		check(
			'shared_listing_job_owner_check',
			sql`(${table.owner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.owner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
		)
	]
);

export const sharedListingJobDispatch = sqliteTable(
	'shared_listing_job_dispatch',
	{
		id: integer('id')
			.$type<SharedListingDispatchId>()
			.primaryKey({ autoIncrement: true }),
		jobId: text('job_id').$type<ArtifactJobId>().notNull(),
		jobGeneration: integer('job_generation')
			.$type<ArtifactJobGeneration>()
			.notNull(),
		nextDeliveryAt: text('next_delivery_at').$type<IsoTimestamp>(),
		claimGeneration: integer('claim_generation').notNull().default(0),
		owner: text('owner').$type<ArtifactTaskOwner>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		isSeeded: integer('is_seeded', { mode: 'boolean' }).notNull().default(true),
		seedAfter: text('seed_after').$type<NixSha256HashString>(),
		seedThrough: text('seed_through').$type<NixSha256HashString>()
	},
	(table) => [
		uniqueIndex('shared_listing_job_dispatch_job_idx').on(table.jobId),
		index('shared_listing_job_dispatch_due_idx').on(
			table.nextDeliveryAt,
			table.id
		),
		check(
			'shared_listing_job_dispatch_version_check',
			sql`typeof(${table.id}) = 'integer' AND ${table.id} BETWEEN 1 AND 9007199254740991 AND typeof(${table.jobGeneration}) = 'integer' AND ${table.jobGeneration} BETWEEN 1 AND 9007199254740991 AND typeof(${table.claimGeneration}) = 'integer' AND ${table.claimGeneration} BETWEEN 0 AND 9007199254740991`
		),
		check(
			'shared_listing_job_dispatch_owner_check',
			sql`(${table.owner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.owner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.nextDeliveryAt} IS NOT NULL AND ${table.claimGeneration} >= 1 AND ${table.nextDeliveryAt} = ${table.leaseExpiresAt})`
		),
		check(
			'shared_listing_job_dispatch_seed_check',
			sql`${table.isSeeded} IN (0,1) AND (${table.seedAfter} IS NULL OR (${table.seedThrough} IS NOT NULL AND ${table.seedAfter} <= ${table.seedThrough}))`
		)
	]
);

export const sharedListingDispatchSeed = sqliteTable(
	'shared_listing_dispatch_seed',
	{
		id: integer('id').primaryKey(),
		after: text('after').$type<ArtifactJobId>(),
		through: text('through').$type<ArtifactJobId>(),
		isComplete: integer('is_complete', { mode: 'boolean' })
			.notNull()
			.default(false)
	},
	(table) => [
		check('shared_listing_dispatch_seed_id_check', sql`${table.id} = 1`),
		check(
			'shared_listing_dispatch_seed_cursor_check',
			sql`${table.isComplete} IN (0,1) AND (${table.after} IS NULL OR (${table.through} IS NOT NULL AND ${table.after} <= ${table.through})) AND (${table.through} IS NOT NULL OR ${table.isComplete} = 1)`
		)
	]
);

export const sharedListingTask = sqliteTable(
	'shared_listing_task',
	{
		id: text('id').$type<ArtifactTaskId>().primaryKey(),
		jobId: text('job_id').$type<ArtifactJobId>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		sourceIncarnation: integer('source_incarnation').notNull(),
		narSize: integer('nar_size').notNull(),
		fileSize: integer('file_size').notNull(),
		discoveryPage: text('discovery_page').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		state: text('state')
			.$type<SharedListingTaskState>()
			.notNull()
			.default('pending'),
		claimGeneration: integer('claim_generation').notNull().default(0),
		claimJobGeneration: integer('claim_job_generation').notNull().default(0),
		claimOwner: text('claim_owner').$type<ArtifactTaskOwner>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		readyAt: text('ready_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`'1970-01-01T00:00:00.000Z'`),
		updatedAt: text('updated_at').$type<IsoTimestamp>()
	},
	(table) => [
		uniqueIndex('shared_listing_task_source_idx').on(
			table.jobId,
			table.narHash
		),
		index('shared_listing_task_page_idx').on(table.discoveryPage),
		index('shared_listing_task_ready_idx').on(
			table.jobId,
			table.state,
			table.readyAt,
			table.id
		),
		index('shared_listing_task_lease_idx').on(
			table.jobId,
			table.state,
			table.leaseExpiresAt,
			table.id
		),
		index('shared_listing_task_job_claim_idx').on(
			table.jobId,
			table.state,
			table.claimJobGeneration,
			table.id
		),
		check(
			'shared_listing_task_source_check',
			sql`${table.sourceIncarnation} >= 1 AND ${table.narSize} >= 0 AND ${table.fileSize} >= 0`
		)
	]
);

export const sharedListingTaskDelivery = sqliteTable(
	'shared_listing_task_delivery',
	{
		taskId: text('task_id').$type<ArtifactTaskId>().primaryKey(),
		jobId: text('job_id').$type<ArtifactJobId>().notNull(),
		jobGeneration: integer('job_generation')
			.$type<ArtifactJobGeneration>()
			.notNull(),
		state: text('state', { enum: ['pending', 'running'] }).notNull(),
		epoch: text('epoch')
			.notNull()
			.default(sql`(lower(hex(randomblob(16))))`),
		nextAt: text('next_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		index('shared_listing_task_delivery_due_idx').on(
			table.jobId,
			table.state,
			table.nextAt,
			table.taskId
		),
		index('shared_listing_task_delivery_generation_idx').on(
			table.jobId,
			table.state,
			table.jobGeneration,
			table.nextAt,
			table.taskId
		),
		check(
			'shared_listing_task_delivery_generation_check',
			sql`typeof(${table.jobGeneration}) = 'integer' AND ${table.jobGeneration} BETWEEN 1 AND 9007199254740991`
		),
		check(
			'shared_listing_task_delivery_state_check',
			sql`${table.state} IN ('pending', 'running')`
		),
		check(
			'shared_listing_task_delivery_epoch_check',
			sql`length(${table.epoch}) = 32 AND ${table.epoch} NOT GLOB '*[^0-9a-f]*'`
		)
	]
);

export const sharedListingTaskOutcome = sqliteTable(
	'shared_listing_task_outcome',
	{
		taskId: text('task_id').$type<ArtifactTaskId>().primaryKey(),
		jobId: text('job_id').$type<ArtifactJobId>().notNull(),
		jobGeneration: integer('job_generation')
			.$type<ArtifactJobGeneration>()
			.notNull(),
		taskGeneration: integer('task_generation')
			.$type<ArtifactTaskGeneration>()
			.notNull(),
		owner: text('owner').$type<ArtifactTaskOwner>().notNull(),
		claim: text('claim', { mode: 'json' })
			.$type<SharedListingTaskClaim>()
			.notNull(),
		completionId: text('completion_id')
			.$type<SharedListingCompletionId>()
			.notNull(),
		kind: text('kind').$type<SharedListingTaskOutcome['kind']>().notNull(),
		fact: text('fact', { mode: 'json' }).$type<NarListingFact>(),
		incarnation: integer('incarnation'),
		referenceEpoch: text('reference_epoch').$type<SharedListingOutputEpoch>(),
		computationGeneration: integer('computation_generation'),
		stageId: text('stage_id').$type<ArtifactStageId>(),
		reason: text('reason').$type<SharedListingTaskReason>(),
		completedAt: text('completed_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		index('shared_listing_task_outcome_job_idx').on(table.jobId, table.taskId),
		check(
			'shared_listing_task_outcome_generation_check',
			sql`typeof(${table.jobGeneration}) = 'integer' AND ${table.jobGeneration} BETWEEN 1 AND 9007199254740991
 AND typeof(${table.taskGeneration}) = 'integer' AND ${table.taskGeneration} BETWEEN 1 AND 9007199254740991
 AND (${table.computationGeneration} IS NULL OR (typeof(${table.computationGeneration}) = 'integer' AND ${table.computationGeneration} BETWEEN 1 AND 9007199254740991))
 AND (${table.incarnation} IS NULL OR (typeof(${table.incarnation}) = 'integer' AND ${table.incarnation} BETWEEN 1 AND 9007199254740991))`
		),
		check(
			'shared_listing_task_outcome_claim_check',
			sql`coalesce(json_valid(${table.claim}) AND json_extract(${table.claim}, '$.id') = ${table.taskId}
 AND json_extract(${table.claim}, '$.job.id') = ${table.jobId} AND json_extract(${table.claim}, '$.job.generation') = ${table.jobGeneration}
 AND json_extract(${table.claim}, '$.generation') = ${table.taskGeneration} AND json_extract(${table.claim}, '$.owner') = ${table.owner}, 0)`
		),
		check(
			'shared_listing_task_outcome_fact_check',
			sql`${table.fact} IS NULL OR coalesce(json_valid(${table.fact})
 AND json_extract(${table.fact}, '$.narHash') = json_extract(${table.claim}, '$.narHash')
 AND json_extract(${table.fact}, '$.generatorRevision') = json_extract(${table.claim}, '$.generatorRevision')
 AND json_extract(${table.fact}, '$.format') = 1
 AND json_type(${table.fact}, '$.size') = 'integer' AND json_extract(${table.fact}, '$.size') BETWEEN 1 AND 9007199254740991
 AND length(json_extract(${table.fact}, '$.digest')) = 64 AND json_extract(${table.fact}, '$.digest') NOT GLOB '*[^0-9a-f]*', 0)`
		),
		check(
			'shared_listing_task_outcome_kind_check',
			sql`coalesce((${table.kind} = 'generated' AND ${table.fact} IS NOT NULL AND ${table.incarnation} IS NOT NULL AND ${table.referenceEpoch} IS NOT NULL AND ${table.computationGeneration} IS NOT NULL AND ${table.stageId} IS NOT NULL AND ${table.reason} IS NULL)
 OR (${table.kind} = 'reused' AND ${table.fact} IS NOT NULL AND ${table.incarnation} IS NOT NULL AND ${table.referenceEpoch} IS NOT NULL AND ${table.stageId} IS NULL AND ${table.reason} IS NULL)
 OR (${table.kind} IN ('skipped','failed') AND ${table.fact} IS NULL AND ${table.incarnation} IS NULL AND ${table.referenceEpoch} IS NULL AND ${table.computationGeneration} IS NULL AND ${table.stageId} IS NULL AND ${table.reason} IN ('source-unavailable','source-mismatch','unsupported-source','unsupported-generator-revision','resource-limit','generation-failed')), 0)`
		)
	]
);

export const sharedListingGeneration = sqliteTable(
	'shared_listing_generation',
	{
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		generatorRevision: text('generator_revision')
			.$type<ListingGeneratorRevision>()
			.notNull(),
		sourceIncarnation: integer('source_incarnation').notNull(),
		generation: integer('generation').notNull(),
		jobId: text('job_id').$type<ArtifactJobId>().notNull(),
		jobGeneration: integer('job_generation')
			.$type<ArtifactJobGeneration>()
			.notNull(),
		taskId: text('task_id').$type<ArtifactTaskId>().notNull(),
		taskGeneration: integer('task_generation')
			.$type<ArtifactTaskGeneration>()
			.notNull(),
		owner: text('owner').$type<ArtifactTaskOwner>(),
		leaseExpiresAt: text('lease_expires_at').$type<IsoTimestamp>(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.narHash, table.generatorRevision] }),
		check(
			'shared_listing_generation_integer_check',
			sql`typeof(${table.generation}) = 'integer' AND ${table.generation} BETWEEN 1 AND 9007199254740991
		AND typeof(${table.sourceIncarnation}) = 'integer' AND ${table.sourceIncarnation} BETWEEN 1 AND 9007199254740991
		AND typeof(${table.jobGeneration}) = 'integer' AND ${table.jobGeneration} BETWEEN 1 AND 9007199254740991
		AND typeof(${table.taskGeneration}) = 'integer' AND ${table.taskGeneration} BETWEEN 1 AND 9007199254740991`
		),
		check(
			'shared_listing_generation_ownership_check',
			sql`(${table.owner} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.owner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`
		)
	]
);

export const narCaptureState = sqliteTable(
	'nar_capture_state',
	{
		id: integer('id').primaryKey(),
		latest: integer('latest')
			.$type<NarCaptureSequence>()
			.notNull()
			.default(narCaptureSequenceSchema.parse(0)),
		prunedThrough: integer('pruned_through')
			.$type<NarCaptureSequence>()
			.notNull()
			.default(narCaptureSequenceSchema.parse(0)),
		isReady: integer('is_ready', { mode: 'boolean' }).notNull().default(false)
	},
	(table) => [
		check('nar_capture_state_identity_check', sql`${table.id} = 1`),
		check(
			'nar_capture_state_position_check',
			sql`${table.prunedThrough} BETWEEN 0 AND ${table.latest} AND ${table.latest} <= 9007199254740991`
		)
	]
);

export const narCaptureEvent = sqliteTable(
	'nar_capture_event',
	{
		id: integer('id')
			.$type<NarCaptureSequence>()
			.primaryKey({ autoIncrement: true }),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		sourceIncarnation: integer('source_incarnation').notNull(),
		createdAt: text('created_at')
			.$type<IsoTimestamp>()
			.notNull()
			.default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
	},
	(table) => [
		check(
			'nar_capture_event_position_check',
			sql`${table.id} BETWEEN 1 AND 9007199254740991 AND ${table.sourceIncarnation} BETWEEN 1 AND 9007199254740991`
		)
	]
);
