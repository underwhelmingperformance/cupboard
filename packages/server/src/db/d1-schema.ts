import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text
} from 'drizzle-orm/sqlite-core';

// The global, cross-tenant shared-blob facts, held in D1 rather than any one
// tenant's Durable Object SQLite. A row exists exactly when a verified shared
// object lives at `nar/<nar_hash>.nar.zst`, so it is both the `available` set and
// the canonical compressed metadata a servable narinfo advertises. Only positive
// facts are recorded — a mismatch is kept on the per-upload record, never here —
// so one tenant's bad upload can never poison a hash for everyone.
export const blobState = sqliteTable(
	'blob_state',
	{
		narHash: text('nar_hash').primaryKey(),
		fileHash: text('file_hash').notNull(),
		fileSize: integer('file_size').notNull(),
		compression: text('compression', { enum: ['zstd'] }).notNull(),
		narSize: integer('nar_size').notNull(),
		verifiedAt: text('verified_at').notNull(),
		// The reaper's grace timer. The arm pass sets it to `now + grace` once no
		// `blob_ref` references this hash; a commit that re-references the hash
		// (promote or reuse) clears it back to NULL; the collect pass deletes the row
		// and the shared object once it has elapsed and the hash is still
		// unreferenced. NULL means live, or not yet armed.
		deleteAfter: text('delete_after')
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
		tenant: text('tenant').notNull(),
		cache: text('cache').notNull(),
		storePathHash: text('store_path_hash').notNull(),
		generation: integer('generation').notNull(),
		narHash: text('nar_hash').notNull()
	},
	(table) => [
		primaryKey({
			columns: [
				table.tenant,
				table.cache,
				table.storePathHash,
				table.generation
			]
		}),
		index('blob_ref_nar_hash_idx').on(table.narHash)
	]
);

// The control-plane signing key set, held in D1 so the stateless Worker can mint
// and rotate control tokens (which authorise global-admin operations). Only the
// public metadata and the *wrapped* private JWK live here; the wrapping secret is
// bound only on the control-plane Worker (see control-key.ts), and the tenant
// Durable Object runs in a separate script that never binds it, so a DO that can
// read this table (D1 is database-wide) still cannot recover a key. `retired_at`
// is NULL while a key still verifies; the newest non-retired key is the one that
// mints.
export const controlAuthKey = sqliteTable('control_auth_key', {
	id: text('id').primaryKey(),
	kid: text('kid').notNull(),
	publicJwkJson: text('public_jwk_json').notNull(),
	wrappedPrivateJwk: text('wrapped_private_jwk').notNull(),
	createdAt: text('created_at').notNull(),
	retiredAt: text('retired_at')
});

// The control-plane trust policy: which external OIDC identity may exchange a
// subject token for a control admin token. It mirrors a tenant `oidc_trust` rule
// but is global and always grants the control admin scope — `iss`/`aud` must
// match and every `claims_json` entry (a pinned `sub` lives here) must match
// exactly. Seeded by the gated first-signup claim; the control plane is its own
// issuer, entirely separate from any tenant's.
export const controlTrust = sqliteTable('control_trust', {
	id: text('id').primaryKey(),
	issuer: text('issuer').notNull(),
	audience: text('audience').notNull(),
	claimsJson: text('claims_json').notNull().default('{}'),
	createdAt: text('created_at').notNull()
});

// The tenant registry: one row per provisioned cache, written only by the Worker.
// `status` gates admission: `active` serves and accepts writes, `suspended` stops
// writes at once and reads after the manifest TTL, `offboarding` drains, and
// `offboarded` is the terminal scrubbed tombstone (kept so the slug is never reused,
// excluded from the manifest, never maintained). `read_mode`
// and the owner OIDC triple are projected into the KV admission manifest and seeded
// into the tenant Durable Object at provision time. `config_version` is the
// monotonic fence carried on every dispatch, so a Durable Object applies identity
// updates in order and never downgrades to an older one.
export const tenant = sqliteTable(
	'tenant',
	{
		id: text('id').primaryKey(),
		status: text('status', {
			enum: ['active', 'suspended', 'offboarding', 'offboarded']
		}).notNull(),
		readMode: text('read_mode', { enum: ['public', 'private'] }).notNull(),
		ownerIssuer: text('owner_issuer').notNull(),
		ownerSubject: text('owner_subject').notNull(),
		ownerAudience: text('owner_audience').notNull(),
		configVersion: integer('config_version').notNull(),
		createdAt: text('created_at').notNull(),
		// The per-tenant read verifier for a private cache: the Basic-auth user and a
		// hash of its password. Both are NULL for a public cache, or for a private one
		// with no credential, which then fails closed and rejects every read. Only the
		// hash, never the plaintext, is projected into the KV manifest the read path
		// checks, so a read secret never leaves the control plane in the clear.
		readUser: text('read_user'),
		readPasswordHash: text('read_password_hash'),
		readPasswordSalt: text('read_password_salt'),
		// When the cron last ran maintenance (GC + verify) for this tenant. The sweep
		// processes the most-overdue active tenants first and stamps this, so the
		// table carries its own round-robin position rather than a separate cursor;
		// NULL (a never-maintained tenant) sorts first, so a new tenant is picked up
		// promptly.
		lastMaintainedAt: text('last_maintained_at')
	},
	(table) => [
		index('tenant_maintenance_idx').on(table.status, table.lastMaintainedAt)
	]
);

// Durable operational state for tenant-routed cron passes. A row records the latest
// success and failure facts for one tenant/pass pair, so a failing tenant remains
// visible after the Worker log line has gone and a later success clears the failure
// streak without erasing when that pass last ran cleanly.
export const tenantMaintenanceFailure = sqliteTable(
	'tenant_maintenance_failure',
	{
		tenant: text('tenant').notNull(),
		pass: text('pass', { enum: ['maintenance', 'offboard'] }).notNull(),
		consecutiveFailures: integer('consecutive_failures').notNull().default(0),
		lastError: text('last_error'),
		lastFailedAt: text('last_failed_at'),
		lastSuccessAt: text('last_success_at')
	},
	(table) => [primaryKey({ columns: [table.tenant, table.pass] })]
);

// A fail-open admission hint for cron-driven tenant maintenance. The tenant DO
// owns the source tables and rewrites this row after mutations that can create
// or clear deferred work; cron uses it only to avoid waking tenants whose row is
// current and has no due work.
export const tenantMaintenanceEligibility = sqliteTable(
	'tenant_maintenance_eligibility',
	{
		tenant: text('tenant').primaryKey(),
		pendingVerificationCount: integer('pending_verification_count')
			.notNull()
			.default(0),
		earliestUploadExpiry: text('earliest_upload_expiry'),
		queuedNarInfoDeletionCount: integer('queued_narinfo_deletion_count')
			.notNull()
			.default(0),
		earliestRootExpiry: text('earliest_root_expiry'),
		nextMaintenanceAt: text('next_maintenance_at'),
		reconciledAt: text('reconciled_at').notNull()
	},
	(table) => [
		index('tenant_maintenance_eligibility_due_idx').on(
			table.nextMaintenanceAt,
			table.reconciledAt
		)
	]
);

// The monotonic version of the published admission manifest, a single row the
// Worker advances every time it republishes. Sourcing the version from D1 (rather
// than the KV version key) keeps concurrent provisioning operations from minting
// the same version: each provisioning batch bumps it, writes the manifest body
// under that version's immutable KV key, then bumps the KV version pointer last.
export const manifestState = sqliteTable('manifest_state', {
	id: text('id').primaryKey(),
	version: integer('version').notNull()
});

// The single global administrator, established once by the gated first-signup
// claim. The fixed `id = 'singleton'` makes the first-writer-wins insert both the
// irreversible bootstrap and the claim's consumption marker: a later claim by a
// different principal hits the primary-key conflict and is refused. `issuer` and
// `subject` identify the principal the claim promoted.
export const globalAdmin = sqliteTable('global_admin', {
	id: text('id').primaryKey(),
	issuer: text('issuer').notNull(),
	subject: text('subject').notNull(),
	claimedAt: text('claimed_at').notNull()
});

// Per-tenant unique-blob presence: a tenant references this NAR hash via at least
// one live narinfo version. Maintained by the tenant's DO on the 0↔1 edge
// transition; `file_size` is the tenant's verified stored bytes, the basis for
// once-per-tenant-per-blob quota charging (the charge itself lands later).
export const tenantBlob = sqliteTable(
	'tenant_blob',
	{
		tenant: text('tenant').notNull(),
		narHash: text('nar_hash').notNull(),
		fileSize: integer('file_size').notNull()
	},
	(table) => [primaryKey({ columns: [table.tenant, table.narHash] })]
);

// The authoritative per-tenant usage and quota counter. `bytes` is the sum of the
// tenant's verified stored blob sizes (so it equals SUM(tenant_blob.file_size));
// `narinfos` and `blobs` are its committed-narinfo and unique-blob counts. The
// counters are maintained incrementally by the owning tenant's Durable Object as it
// charges on the 0-to-1 blob transition and credits on the 1-to-0, and reconciled by
// the cron roll-up. `quota_bytes` is the admin-set limit (NULL means unlimited),
// written only by the Worker. The CHECK makes an over-quota charge fail its D1
// batch, so the whole reservation rolls back: no edge and no charge are ever
// stranded over quota.
export const tenantUsage = sqliteTable(
	'tenant_usage',
	{
		tenant: text('tenant').primaryKey(),
		bytes: integer('bytes').notNull().default(0),
		narinfos: integer('narinfos').notNull().default(0),
		blobs: integer('blobs').notNull().default(0),
		quotaBytes: integer('quota_bytes'),
		updatedAt: text('updated_at').notNull()
	},
	(table) => [
		check('tenant_usage_bytes_nonnegative', sql`${table.bytes} >= 0`),
		check(
			'tenant_usage_within_quota',
			sql`${table.quotaBytes} IS NULL OR ${table.bytes} <= ${table.quotaBytes}`
		)
	]
);
