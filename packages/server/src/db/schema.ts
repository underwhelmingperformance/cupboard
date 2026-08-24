import {
	type AuthKeyId,
	authKeyIdSchema,
	type CachePriority,
	type GraceSeconds,
	type NarInfoGeneration,
	narInfoGenerationSchema,
	type NixSha256HashString,
	type RootName,
	type Sha256HexDigest,
	type SigningKeyGeneration,
	signingKeyGenerationSchema,
	type StoredCache,
	type StorePathHash,
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import type { OidcSubject, TrustRuleId } from '@cupboard/protocol/oidc';
import type {
	ReuseViewPriority,
	ReuseViewRevision
} from '@cupboard/protocol/reuse-views';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type { SessionId, UploadId } from '@cupboard/protocol/upload';
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique
} from 'drizzle-orm/sqlite-core';

import type { R2ObjectKey } from '../http/http.ts';

export const narInfos = sqliteTable(
	'narinfo',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		storePath: text('store_path').$type<StorePathString>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		narSize: integer('nar_size').notNull(),
		referencesJson: text('references_json').notNull(),
		deriver: text('deriver'),
		ca: text('ca'),
		sigsJson: text('sigs_json').notNull().default('[]'),
		// The narinfo version, sourced from `generation_seq` on each (re)commit and
		// captured by the D1 reference edge, so a stale deletion compares against it
		// and can never remove a newer recommitted edge.
		generation: integer('generation')
			.$type<NarInfoGeneration>()
			.notNull()
			.default(narInfoGenerationSchema.parse(0)),
		signatureGeneration: integer('signature_generation')
			.$type<SigningKeyGeneration>()
			.notNull()
			.default(signingKeyGenerationSchema.parse(0)),
		pendingSignatureGeneration: integer(
			'pending_signature_generation'
		).$type<SigningKeyGeneration>(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.cache, table.storePathHash] }),
		// Reuse-view lookup starts with a store-path hash. Exact cache selectors use
		// a point lookup, while prefix selectors scan the cache-name range for that
		// hash. Keep `store_path_hash` first in this index.
		index('narinfo_store_path_hash_cache_idx').on(
			table.storePathHash,
			table.cache
		),
		index('narinfo_pending_signature_generation_idx').on(
			table.pendingSignatureGeneration,
			table.signatureGeneration,
			table.cache,
			table.storePathHash
		),
		index('narinfo_signature_generation_idx').on(table.signatureGeneration)
	]
);

// A delete or offboarding does not reset this counter. Recommitting the same NAR
// therefore receives a generation above any deletion that captured the earlier
// row. The tenant's Durable Object owns this database, so the counter does not
// need a tenant column.
export const generationSeq = sqliteTable(
	'generation_seq',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		nextGeneration: integer('next_generation')
			.$type<NarInfoGeneration>()
			.notNull()
			.default(narInfoGenerationSchema.parse(0))
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

export const pendingUploads = sqliteTable(
	'pending_upload',
	{
		id: text('id').$type<UploadId>().primaryKey(),
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		r2Key: text('r2_key').$type<R2ObjectKey>().notNull(),
		metadataJson: text('metadata_json').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull(),
		// This marker survives an interrupted commit so `push --wait` can report the
		// result. Invalid content never creates a shared blob row.
		verdict: text('verdict', {
			enum: ['committing', 'pending', 'servable', 'mismatch', 'over-quota']
		}),
		// Verification re-reads the subscribed session before sending a terminal
		// verdict, so a reconnect can replace this value while verification is running.
		sessionId: text('session_id').$type<SessionId>(),
		// `claimed_at` records the lease time, and `claim_owner` identifies the
		// verification pass. Owner checks prevent an expired pass from changing a row
		// after another pass claims it. Both columns are null while unclaimed; a client
		// re-drive clears them to request an immediate retry.
		claimedAt: text('claimed_at').$type<IsoTimestamp>(),
		claimOwner: text('claim_owner'),
		// Capture the retention decision during negotiation so a later policy change
		// cannot alter this upload. Null also supports rows created before decisions
		// were stored and is treated as no matching policy.
		graceDecisionJson: text('grace_decision_json'),
		// A commit attaches the path to the run root captured during negotiation.
		// Null preserves the behaviour of pushes that did not request a root.
		attachRootName: text('attach_root_name').$type<RootName>()
	},
	// The maintenance reconcile finds the soonest-expiring upload and probes for any
	// still awaiting verification (an existence check, not a count); without these
	// indexes each pass scans the whole in-flight set.
	(table) => [
		index('pending_upload_expires_at_idx').on(table.expiresAt),
		index('pending_upload_verdict_idx').on(table.verdict)
	]
);

export const pendingAttestations = sqliteTable(
	'pending_attestation',
	{
		id: text('id').$type<UploadId>().primaryKey(),
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		r2Key: text('r2_key').$type<R2ObjectKey>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull()
	},
	// The maintenance pass finds the soonest-expiring attestation and GC reaps the
	// expired ones; the index spares both a scan of every staged bundle.
	(table) => [index('pending_attestation_expires_at_idx').on(table.expiresAt)]
);

export const narInfoDeletions = sqliteTable(
	'narinfo_deletion',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		// The generation of the narinfo version this deletion captured, so the D1
		// reference edge it retires is targeted by exact `(…, generation)` and a
		// replayed deletion compares against the live row before acting.
		generation: integer('generation')
			.$type<NarInfoGeneration>()
			.notNull()
			.default(narInfoGenerationSchema.parse(0)),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.cache, table.storePathHash, table.generation]
		})
	]
);

export const authKeys = sqliteTable(
	'auth_key',
	{
		id: text('id').primaryKey(),
		// New keys always have a JWKS key ID so verifiers can select a key across
		// rotation. The empty default preserves rows created before key IDs existed.
		kid: text('kid')
			.$type<AuthKeyId>()
			.notNull()
			.default(authKeyIdSchema.parse('')),
		privateJwkJson: text('private_jwk_json').notNull(),
		publicJwkJson: text('public_jwk_json').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		scheduledRetireAt: text('scheduled_retire_at').$type<IsoTimestamp>(),
		retiredAt: text('retired_at').$type<IsoTimestamp>()
	},
	// The maintenance pass finds the soonest scheduled retirement among the keys
	// still in service; filtering on `retired_at` then ordering by
	// `scheduled_retire_at` uses this index.
	(table) => [
		index('auth_key_retirement_idx').on(
			table.retiredAt,
			table.scheduledRetireAt
		)
	]
);

// A live refresh grant: the wire token is `<id>.<secret>` and only the secret's
// SHA-256 is held here, so a copy of this table issues nothing. Presenting the
// token rotates the row (the spent row is deleted, a successor inserted), which
// makes each refresh token single-use: a replayed one finds no row and fails as
// `invalid_grant`. The rule id re-reads the rule's grants at refresh time, so
// retiring or disabling a trust rule ends its sessions.
export const refreshTokens = sqliteTable(
	'refresh_token',
	{
		id: text('id').primaryKey(),
		secretHash: text('secret_hash').notNull(),
		ruleId: text('rule_id').$type<TrustRuleId>().notNull(),
		subject: text('subject').$type<OidcSubject>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull()
	},
	// The GC pass deletes expired refresh tokens by `expires_at`; the index spares
	// it a scan of every live grant.
	(table) => [index('refresh_token_expires_at_idx').on(table.expiresAt)]
);

// `configure` persists the identity assigned by the control plane. The Durable
// Object uses these values for its tenant namespace, token identity, and fixed
// owner rule. The version fence rejects equal or older deliveries so a retry
// cannot restore stale identity or owner access.
export const tenantIdentity = sqliteTable('tenant_identity', {
	id: text('id').primaryKey(),
	tenant: text('tenant').$type<TenantId>().notNull(),
	issuer: text('issuer').notNull(),
	audience: text('audience').notNull(),
	ownerIssuer: text('owner_issuer').notNull(),
	ownerSubject: text('owner_subject').notNull(),
	ownerAudience: text('owner_audience').notNull(),
	configVersion: integer('config_version').notNull()
});

export const signingKeys = sqliteTable('signing_key', {
	id: text('id').primaryKey(),
	privateJwkJson: text('private_jwk_json').notNull(),
	publicKey: text('public_key').notNull(),
	signing: integer('signing', { mode: 'boolean' }).notNull().default(true),
	published: integer('published', { mode: 'boolean' }).notNull().default(true),
	generation: integer('generation')
		.$type<SigningKeyGeneration>()
		.notNull()
		.default(signingKeyGenerationSchema.parse(0)),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull()
});

export const signingKeySequence = sqliteTable('signing_key_sequence', {
	id: text('id').primaryKey(),
	nextGeneration: integer('next_generation')
		.$type<SigningKeyGeneration>()
		.notNull()
});

export const signingKeyBackfills = sqliteTable('signing_key_backfill', {
	keyId: text('key_id').primaryKey(),
	generation: integer('generation').$type<SigningKeyGeneration>().notNull(),
	state: text('state', {
		enum: ['running', 'retrying', 'complete']
	}).notNull(),
	startedAt: text('started_at').$type<IsoTimestamp>().notNull(),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull(),
	completedAt: text('completed_at').$type<IsoTimestamp>(),
	resigned: integer('resigned').notNull().default(0),
	failureOperation: text('failure_operation', {
		enum: ['resigning', 'cache-purge']
	}),
	failedAt: text('failed_at').$type<IsoTimestamp>(),
	failureMessage: text('failure_message')
});

export const cachePurgeContinuations = sqliteTable(
	'cache_purge_continuation',
	{
		id: text('id').primaryKey(),
		kind: text('kind', { enum: ['backfill', 'mutation'] }).notNull(),
		signingKeyId: text('signing_key_id'),
		entriesJson: text('entries_json').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull(),
		lastAttemptAt: text('last_attempt_at').$type<IsoTimestamp>(),
		lastError: text('last_error')
	},
	(table) => [
		index('cache_purge_kind_created_at_idx').on(table.kind, table.createdAt)
	]
);

export const retentionRoots = sqliteTable(
	'retention_root',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		name: text('name').$type<RootName>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
	},
	// The maintenance pass finds the soonest-expiring TTL root; the index spares
	// it a scan of every root.
	(table) => [
		primaryKey({ columns: [table.cache, table.name] }),
		index('retention_root_expires_at_idx').on(table.expiresAt),
		index('retention_root_cache_expires_at_name_idx').on(
			table.cache,
			table.expiresAt,
			table.name
		)
	]
);

export const retentionRootTargets = sqliteTable(
	'retention_root_target',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		rootName: text('root_name').$type<RootName>().notNull(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		storePath: text('store_path').$type<StorePathString>().notNull()
	},
	(table) => [
		primaryKey({
			columns: [table.cache, table.rootName, table.storePathHash]
		})
	]
);

// The collector treats an unexpired grace deadline as another reachability
// source, so it retains the path's whole closure. Deadlines extend monotonically
// and disappear when they expire or when the narinfo is deleted. Admin summaries
// expose only the earliest live deadline for each cache.
export const retentionGrace = sqliteTable(
	'retention_grace',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		retainUntil: text('retain_until').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.cache, table.storePathHash] }),
		index('retention_grace_retain_until_idx').on(table.retainUntil)
	]
);

// A monotonically increasing revision for every cache input that can change
// reachability. SQLite triggers maintain it independently of the write path, so
// an incremental garbage-collection scan can detect any mutation between its
// bounded chunks before it deletes from an obsolete mark set.
export const garbageCollectionRevisions = sqliteTable(
	'garbage_collection_revision',
	{
		cache: text('cache').$type<StoredCache>().primaryKey(),
		revision: integer('revision').notNull().default(0)
	}
);

export const garbageCollectionScans = sqliteTable('garbage_collection_scan', {
	cache: text('cache').$type<StoredCache>().primaryKey(),
	revision: integer('revision').notNull(),
	phase: text('phase', {
		enum: ['expire-roots', 'expire-grace', 'roots', 'grace', 'mark', 'collect']
	}).notNull(),
	cursor: text('cursor').notNull().default(''),
	markStorePathHash: text('mark_store_path_hash').$type<StorePathHash>(),
	referenceCursor: integer('reference_cursor').notNull().default(-1),
	allowEmptyCollection: integer('allow_empty_collection', { mode: 'boolean' })
		.notNull()
		.default(false)
});

export const garbageCollectionFrontier = sqliteTable(
	'garbage_collection_frontier',
	{
		cache: text('cache').$type<StoredCache>().notNull(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

export const garbageCollectionMarks = sqliteTable(
	'garbage_collection_mark',
	{
		cache: text('cache').$type<StoredCache>().notNull(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

// A tenant-wide collection advances through one cache at a time. The current
// cache remains here until its incremental scan completes, then the next cache
// is selected lexicographically without loading the complete cache registry.
export const garbageCollectionTenantRuns = sqliteTable(
	'garbage_collection_tenant_run',
	{
		id: integer('id').primaryKey(),
		cache: text('cache').$type<StoredCache>().notNull()
	}
);

export const caches = sqliteTable('cache', {
	name: text('name').$type<StoredCache>().primaryKey(),
	priority: integer('priority').$type<CachePriority>().notNull(),
	// Set when the first grace-policy event applies to this cache and never
	// cleared while the cache exists: the empty-cache collection guard stays off
	// even if every policy is later removed, so a partially drained cache cannot
	// strand between continuation runs.
	graceManaged: integer('grace_managed', { mode: 'boolean' })
		.notNull()
		.default(false),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull()
});

export const retentionPolicies = sqliteTable(
	'retention_policy',
	{
		id: text('id').primaryKey(),
		scope: text('scope', { enum: ['cache', 'root-name-prefix'] }).notNull(),
		pattern: text('pattern').notNull(),
		defaultTtlSeconds: integer('default_ttl_seconds').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		unique('retention_policy_scope_pattern_unique').on(
			table.scope,
			table.pattern
		)
	]
);

// A policy applies to each path published to a cache whose name starts with
// `cache_prefix`; the empty prefix is the tenant-wide default. Prefixes are
// unique, and the longest matching prefix wins when several policies cover a
// cache.
export const retentionGracePolicies = sqliteTable(
	'retention_grace_policy',
	{
		id: text('id').primaryKey(),
		cachePrefix: text('cache_prefix').notNull(),
		graceSeconds: integer('grace_seconds').$type<GraceSeconds>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		unique('retention_grace_policy_cache_prefix_unique').on(table.cachePrefix)
	]
);

// Background verification resumes after this composite cache and store-path
// position. An empty position starts, or wraps, at the first cache and hash.
export const verificationCursor = sqliteTable('verification_cursor', {
	id: text('id').primaryKey(),
	cache: text('cache').$type<StoredCache>().notNull().default(''),
	lastStorePathHash: text('last_store_path_hash'),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
});

// Decoded issuer, audience, and claim values select a candidate trust rule. The
// caller must then verify the token against the issuer's discovered JWKS before
// granting any authority from `permitted_grants_json`. The owner rule takes its
// wildcard identity from `tenant_identity`. `display_json` records provenance
// from a preset, and disabling a rule retains its audit row.
export const oidcTrust = sqliteTable('oidc_trust', {
	id: text('id').$type<TrustRuleId>().primaryKey(),
	issuer: text('issuer').notNull(),
	audience: text('audience').notNull(),
	claimsJson: text('claims_json').notNull().default('{}'),
	permittedGrantsJson: text('permitted_grants_json').notNull().default('[]'),
	displayJson: text('display_json'),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	disabledAt: text('disabled_at').$type<IsoTimestamp>()
});

export const reuseViews = sqliteTable('reuse_view', {
	name: text('name').primaryKey(),
	revision: integer('revision').$type<ReuseViewRevision>().notNull(),
	priority: integer('priority').$type<ReuseViewPriority>().notNull(),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
});

export const reuseViewSelectors = sqliteTable(
	'reuse_view_selector',
	{
		view: text('view').notNull(),
		kind: text('kind', { enum: ['exact', 'prefix'] }).notNull(),
		pattern: text('pattern').notNull()
	},
	(table) => [primaryKey({ columns: [table.view, table.kind, table.pattern] })]
);

// Removing a view does not delete its counter. A view recreated under the same
// name therefore receives a new revision, which lets the read path distinguish
// that replacement from an unchanged view.
export const reuseViewRevisionSeq = sqliteTable('reuse_view_revision_seq', {
	name: text('name').primaryKey(),
	nextRevision: integer('next_revision').$type<ReuseViewRevision>().notNull()
});
