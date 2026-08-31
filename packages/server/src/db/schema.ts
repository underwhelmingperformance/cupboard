import {
	type AuthKeyId,
	authKeyIdSchema,
	type CacheName,
	type CachePriority,
	type GraceSeconds,
	type NarInfoGeneration,
	narInfoGenerationSchema,
	type NixSha256HashString,
	type PredicateType,
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
	ReuseViewRevision,
	StoredReuseView
} from '@cupboard/protocol/reuse-views';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';
import type { SessionId, UploadId } from '@cupboard/protocol/upload';
import { sql } from 'drizzle-orm';
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';

import type { R2ObjectKey } from '../http/http.ts';

export const cacheIdentities = sqliteTable(
	'cache_identity',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		kind: text('kind', { enum: ['default', 'named'] }).notNull(),
		name: text('name'),
		access: text('access', { enum: ['public', 'private'] }),
		priority: integer('priority').notNull(),
		graceManaged: integer('grace_managed', { mode: 'boolean' })
			.notNull()
			.default(false),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		deletedAt: text('deleted_at').$type<IsoTimestamp>()
	},
	(table) => [
		check(
			'cache_identity_shape_check',
			sql`(${table.kind} = 'default' AND ${table.name} IS NULL) OR (${table.kind} = 'named' AND ${table.name} IS NOT NULL)`
		),
		uniqueIndex('cache_identity_default_idx')
			.on(table.kind)
			.where(sql`${table.kind} = 'default' AND ${table.deletedAt} IS NULL`),
		uniqueIndex('cache_identity_name_idx')
			.on(table.name)
			.where(sql`${table.kind} = 'named' AND ${table.deletedAt} IS NULL`)
	]
);

export const narInfos = sqliteTable(
	'narinfo',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		cacheId: integer('cache_id'),
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
		cacheKind: text('cache_kind', { enum: ['default', 'named'] }),
		cacheName: text('cache_name').$type<CacheName>(),
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
		cacheId: integer('cache_id'),
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
		attachRootName: text('attach_root_name').$type<RootName>(),
		// The verdict reported by the queue consumer. It remains here until a pass
		// has enough D1 allowance to apply it. A recorded verdict prevents another
		// consumer from claiming the row and repeating the decode. Rows created
		// before this column was added contain null.
		recordedVerdictJson: text('recorded_verdict_json')
	},
	// Maintenance finds the soonest-expiring upload, probes for work awaiting
	// verification, and checks listed staging keys for pending owners. Without
	// these indexes each pass scans the whole in-flight set.
	(table) => [
		index('pending_upload_expires_at_idx').on(table.expiresAt),
		index('pending_upload_terminal_expires_at_idx')
			.on(table.expiresAt, table.id)
			.where(
				sql`${table.verdict} IS NULL OR ${table.verdict} = 'servable' OR ${table.verdict} = 'mismatch' OR ${table.verdict} = 'over-quota'`
			),
		index('pending_upload_verdict_idx').on(table.verdict),
		index('pending_upload_r2_key_idx').on(table.r2Key),
		index('pending_upload_recorded_verdict_idx')
			.on(table.id)
			.where(sql`${table.recordedVerdictJson} IS NOT NULL`)
	]
);

export const pendingAttestations = sqliteTable(
	'pending_attestation',
	{
		id: text('id').$type<UploadId>().primaryKey(),
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		cacheId: integer('cache_id'),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		predicateType: text('predicate_type').$type<PredicateType>(),
		r2Key: text('r2_key').$type<R2ObjectKey>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull()
	},
	// Maintenance finds the soonest-expiring upload or completed response and
	// checks listed staging keys for their owners. The indexes spare scans of
	// every staged bundle.
	(table) => [
		index('pending_attestation_expires_at_idx').on(table.expiresAt),
		index('pending_attestation_r2_key_idx').on(table.r2Key)
	]
);

export const narInfoDeletions = sqliteTable(
	'narinfo_deletion',
	{
		cache: text('cache').$type<StoredCache>().notNull().default(''),
		cacheId: integer('cache_id'),
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

// Keep the retired table empty for one expand-contract window. A preceding
// Worker can then finish or be restored after this migration applies: its token
// lookup returns no row and its expiry cleanup remains valid. Current runtime
// services do not read or write this table.
export const legacyRefreshTokens = sqliteTable(
	'refresh_token',
	{
		id: text('id').primaryKey(),
		secretHash: text('secret_hash').notNull(),
		ruleId: text('rule_id').$type<TrustRuleId>().notNull(),
		subject: text('subject').$type<OidcSubject>().notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [index('refresh_token_expires_at_idx').on(table.expiresAt)]
);

// A refresh-token family has one active member and an absolute expiry. Rotation
// advances the active member. Spent members remain so replay can revoke the
// family. The stored grants start with the authority granted by the external
// exchange and narrow when a refresh requests less authority. Every later
// rotation is bounded by the stored grants.
export const refreshTokenFamilies = sqliteTable(
	'refresh_token_family',
	{
		id: text('id').primaryKey(),
		activeMemberId: text('active_member_id').notNull(),
		generation: integer('generation').notNull(),
		ruleId: text('rule_id').$type<TrustRuleId>().notNull(),
		subject: text('subject').$type<OidcSubject>().notNull(),
		grantsJson: text('grants_json'),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
		expiresAt: text('expires_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		unique('refresh_token_family_active_member_unique').on(
			table.activeMemberId
		),
		index('refresh_token_family_rule_idx').on(table.ruleId, table.id),
		index('refresh_token_family_expires_at_idx').on(table.expiresAt, table.id)
	]
);

// Every member remains until its family expires or is revoked. Only the hash of
// the bearer secret is stored. A spent member can therefore identify its family
// and prove possession without recovering any successor token.
export const refreshTokenMembers = sqliteTable(
	'refresh_token_member',
	{
		id: text('id').primaryKey(),
		familyId: text('family_id').notNull(),
		generation: integer('generation').notNull(),
		secretHash: text('secret_hash').notNull(),
		createdAt: text('created_at').$type<IsoTimestamp>().notNull()
	},
	(table) => [
		unique('refresh_token_member_family_generation_unique').on(
			table.familyId,
			table.generation
		),
		index('refresh_token_member_family_idx').on(table.familyId)
	]
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
		cacheId: integer('cache_id'),
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
		cacheId: integer('cache_id'),
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
		cacheId: integer('cache_id'),
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
		cacheId: integer('cache_id'),
		revision: integer('revision').notNull().default(0)
	}
);

export const garbageCollectionScans = sqliteTable('garbage_collection_scan', {
	cache: text('cache').$type<StoredCache>().primaryKey(),
	cacheId: integer('cache_id'),
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
		cacheId: integer('cache_id'),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

export const garbageCollectionMarks = sqliteTable(
	'garbage_collection_mark',
	{
		cache: text('cache').$type<StoredCache>().notNull(),
		cacheId: integer('cache_id'),
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
		cache: text('cache').$type<StoredCache>().notNull(),
		cacheId: integer('cache_id')
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
		kind: text('kind', { enum: ['cache', 'root-name-prefix'] }),
		cacheId: integer('cache_id'),
		rootNamePrefix: text('root_name_prefix'),
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
	cacheId: integer('cache_id'),
	lastStorePathHash: text('last_store_path_hash'),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
});

// Decoded issuer and audience values select a configured verification target.
// After verification, the claims and requested grants select a policy rule.
// The owner rule takes its wildcard identity from `tenant_identity`.
// `display_json` records provenance from a preset, and disabling a rule retains
// its audit row.
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
	name: text('name').$type<StoredReuseView>().primaryKey(),
	access: text('access', { enum: ['public', 'private'] }),
	revision: integer('revision').$type<ReuseViewRevision>().notNull(),
	priority: integer('priority').$type<ReuseViewPriority>().notNull(),
	createdAt: text('created_at').$type<IsoTimestamp>().notNull(),
	updatedAt: text('updated_at').$type<IsoTimestamp>().notNull()
});

export const reuseViewSelectors = sqliteTable(
	'reuse_view_selector',
	{
		view: text('view').$type<StoredReuseView>().notNull(),
		kind: text('kind', { enum: ['exact', 'prefix'] }).notNull(),
		pattern: text('pattern').notNull()
	},
	(table) => [primaryKey({ columns: [table.view, table.kind, table.pattern] })]
);

export const nativeReuseViewSelectors = sqliteTable(
	'reuse_view_selector_native',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		view: text('view').notNull(),
		kind: text('kind', {
			enum: ['default', 'named', 'prefix', 'all-named', 'all']
		}).notNull(),
		cacheName: text('cache_name'),
		prefix: text('prefix')
	},
	(table) => [
		check(
			'reuse_view_selector_native_shape_check',
			sql`(${table.kind} IN ('default', 'all-named', 'all') AND ${table.cacheName} IS NULL AND ${table.prefix} IS NULL) OR (${table.kind} = 'named' AND ${table.cacheName} IS NOT NULL AND ${table.prefix} IS NULL) OR (${table.kind} = 'prefix' AND ${table.cacheName} IS NULL AND ${table.prefix} IS NOT NULL AND length(${table.prefix}) > 0)`
		)
	]
);

// Removing a view does not delete its counter. A view recreated under the same
// name therefore receives a new revision, which lets the read path distinguish
// that replacement from an unchanged view.
export const reuseViewRevisionSeq = sqliteTable('reuse_view_revision_seq', {
	name: text('name').$type<StoredReuseView>().primaryKey(),
	nextRevision: integer('next_revision').$type<ReuseViewRevision>().notNull()
});
