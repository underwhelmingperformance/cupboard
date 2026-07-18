import {
	type CachePriority,
	type NixSha256HashString,
	type RootName,
	type Sha256HexDigest,
	type StorePathHash,
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique
} from 'drizzle-orm/sqlite-core';

export const narInfos = sqliteTable(
	'narinfo',
	{
		cache: text('cache').notNull().default(''),
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
		generation: integer('generation').notNull().default(0),
		createdAt: text('created_at').notNull()
	},
	(table) => [
		primaryKey({ columns: [table.cache, table.storePathHash] }),
		// The reuse-view local lookup range-scans from a hash: an exact selector
		// is a point lookup and a prefix selector is a range bounded by both the
		// hash and the cache-name prefix, so this leads with `store_path_hash`
		// rather than `cache` the way the primary key does.
		index('narinfo_store_path_hash_cache_idx').on(
			table.storePathHash,
			table.cache
		)
	]
);

// The durable, strictly-increasing generation counter per store path. It is
// advanced on every (re)commit and is never reset by a delete or offboarding, so
// a delete-then-recommit (even one reproducing the same NAR hash) always lands a
// higher generation than any captured deletion. It is per-tenant by virtue of
// living in the tenant's own DO SQLite, so it carries no `tenant` column.
export const generationSeq = sqliteTable(
	'generation_seq',
	{
		cache: text('cache').notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		nextGeneration: integer('next_generation').notNull().default(0)
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

export const pendingUploads = sqliteTable(
	'pending_upload',
	{
		id: text('id').primaryKey(),
		cache: text('cache').notNull().default(''),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		r2Key: text('r2_key').notNull(),
		metadataJson: text('metadata_json').notNull(),
		createdAt: text('created_at').notNull(),
		expiresAt: text('expires_at').notNull(),
		// The commit-saga status of an accepted upload, the durable marker a crashed
		// commit is re-driven from and a `push --wait` client polls. `committing` once an
		// inline commit starts, before it reserves the narinfo row; `pending` once a blob
		// above the inline-verify budget is accepted, awaiting the background NAR-hash
		// check; then a terminal `servable` once the background pass commits it, `mismatch`
		// once the NAR-hash check fails, or `over-quota` once the background pass finds the
		// canonical size exceeds the tenant's quota. The three terminal verdicts are
		// retained through a status-observation window for a later reader to observe,
		// distinguished so a quota rejection is not misreported as bad content; null while
		// a row still awaits its bytes. The verdict is per-upload and never written globally
		// by nar_hash, so a bad upload leaves no global trace. The background verify pass
		// re-drives both `committing` and `pending` rows.
		verdict: text('verdict', {
			enum: ['committing', 'pending', 'servable', 'mismatch', 'over-quota']
		}),
		// The commit session socket a waiting client holds for this upload, read by
		// the verify pass to route the terminal verdict to the right connection.
		// Null until a commit attaches its session; re-pointed when a reconnected
		// socket re-subscribes. Looked up by the upload's id, so it needs no index.
		sessionId: text('session_id'),
		// The lease a verify pass takes when it claims this row, so an overlapping
		// pass (the alarm backstop's duplicate message, the cron crossing a
		// consumer run) claims nothing already being worked. Null while unclaimed;
		// a crashed pass's lease simply expires. A client re-drive resets it so
		// the pass it requests need not wait the lease out.
		claimedAt: text('claimed_at'),
		// The retention grace decision captured at negotiation, applied when this
		// upload materialises. A policy changed afterwards does not alter it. Null
		// on a row negotiated before the decision existed, which materialises as
		// though no policy matched.
		graceDecisionJson: text('grace_decision_json')
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
		id: text('id').primaryKey(),
		cache: text('cache').notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		digest: text('digest').$type<Sha256HexDigest>().notNull(),
		r2Key: text('r2_key').notNull(),
		createdAt: text('created_at').notNull(),
		expiresAt: text('expires_at').notNull()
	},
	// The maintenance sweep finds the soonest-expiring attestation and GC reaps the
	// expired ones; the index spares both a scan of every staged bundle.
	(table) => [index('pending_attestation_expires_at_idx').on(table.expiresAt)]
);

export const narInfoDeletions = sqliteTable(
	'narinfo_deletion',
	{
		cache: text('cache').notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		narHash: text('nar_hash').$type<NixSha256HashString>().notNull(),
		// The generation of the narinfo version this deletion captured, so the D1
		// reference edge it retires is targeted by exact `(…, generation)` and a
		// replayed deletion compares against the live row before acting.
		generation: integer('generation').notNull().default(0),
		createdAt: text('created_at').notNull()
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
		// The JWKS key id carried in each issued token's header so a verifier can
		// pick the right key across a rotation. Always populated on key creation.
		kid: text('kid').notNull().default(''),
		privateJwkJson: text('private_jwk_json').notNull(),
		publicJwkJson: text('public_jwk_json').notNull(),
		createdAt: text('created_at').notNull(),
		scheduledRetireAt: text('scheduled_retire_at'),
		retiredAt: text('retired_at')
	},
	// The maintenance sweep finds the soonest scheduled retirement among the keys
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
		ruleId: text('rule_id').notNull(),
		subject: text('subject').notNull(),
		createdAt: text('created_at').notNull(),
		expiresAt: text('expires_at').notNull()
	},
	// The GC sweep deletes expired refresh tokens by `expires_at`; the index spares
	// it a scan of every live grant.
	(table) => [index('refresh_token_expires_at_idx').on(table.expiresAt)]
);

// The Durable Object's own identity, set by the control plane's `configure` RPC at
// provision time and on config-version bumps. It is the sole identity source for a
// configured tenant: the slug it serves, the path-based issuer and audience it pins
// into issued tokens, and the owner OIDC triple its admin rule is seeded from.
// `config_version` is a monotonic fence: a `configure` carrying a version no greater
// than the applied one is ignored, so identity never moves backwards. A single row,
// keyed `singleton`, since one Durable Object backs one tenant.
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
	createdAt: text('created_at').notNull()
});

export const retentionRoots = sqliteTable(
	'retention_root',
	{
		cache: text('cache').notNull().default(''),
		name: text('name').$type<RootName>().notNull(),
		expiresAt: text('expires_at'),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull()
	},
	// The maintenance sweep finds the soonest-expiring TTL root; the index spares
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
		cache: text('cache').notNull().default(''),
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

// A retention grace deadline: an internal, expiring reachability source the
// collector walks exactly like a root target, so the deadline keeps the whole
// closure its path references. Not durable retention anyone asked for: it is
// extended monotonically, removed when it expires or its narinfo row is
// deleted, and surfaced to admins only in aggregate, as a cache summary's
// earliest live deadline.
export const retentionGrace = sqliteTable(
	'retention_grace',
	{
		cache: text('cache').notNull().default(''),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull(),
		retainUntil: text('retain_until').notNull()
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
		cache: text('cache').primaryKey(),
		revision: integer('revision').notNull().default(0)
	}
);

export const garbageCollectionScans = sqliteTable('garbage_collection_scan', {
	cache: text('cache').primaryKey(),
	revision: integer('revision').notNull(),
	phase: text('phase', {
		enum: ['expire-roots', 'expire-grace', 'roots', 'grace', 'mark', 'sweep']
	}).notNull(),
	cursor: text('cursor').notNull().default(''),
	markStorePathHash: text('mark_store_path_hash').$type<StorePathHash>(),
	referenceCursor: integer('reference_cursor').notNull().default(-1),
	allowEmptySweep: integer('allow_empty_sweep', { mode: 'boolean' })
		.notNull()
		.default(false)
});

export const garbageCollectionFrontier = sqliteTable(
	'garbage_collection_frontier',
	{
		cache: text('cache').notNull(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

export const garbageCollectionMarks = sqliteTable(
	'garbage_collection_mark',
	{
		cache: text('cache').notNull(),
		storePathHash: text('store_path_hash').$type<StorePathHash>().notNull()
	},
	(table) => [primaryKey({ columns: [table.cache, table.storePathHash] })]
);

// A tenant-wide sweep advances through one cache at a time. The current cache
// remains here until its incremental scan completes, then the next cache is
// selected lexicographically without loading the complete cache registry.
export const garbageCollectionTenantRuns = sqliteTable(
	'garbage_collection_tenant_run',
	{
		id: integer('id').primaryKey(),
		cache: text('cache').notNull()
	}
);

export const caches = sqliteTable('cache', {
	name: text('name').primaryKey(),
	priority: integer('priority').$type<CachePriority>().notNull(),
	// Set when the first grace-policy event applies to this cache and never
	// cleared while the cache exists: the empty-cache collection guard stays off
	// even if every policy is later removed, so a partially drained cache cannot
	// strand between continuation runs.
	graceManaged: integer('grace_managed', { mode: 'boolean' })
		.notNull()
		.default(false),
	createdAt: text('created_at').notNull()
});

export const retentionPolicies = sqliteTable('retention_policy', {
	id: text('id').primaryKey(),
	scope: text('scope', { enum: ['cache', 'root-name-prefix'] }).notNull(),
	pattern: text('pattern').notNull(),
	defaultTtlSeconds: integer('default_ttl_seconds').notNull(),
	createdAt: text('created_at').notNull()
});

// A retention grace policy applies a grace period to every path successfully
// published to a cache whose name starts with `cache_prefix`; the empty prefix
// is the tenant-wide default. The prefix is unique so a publication resolves at
// most one matching policy per cache, and the longest matching prefix wins.
export const retentionGracePolicies = sqliteTable(
	'retention_grace_policy',
	{
		id: text('id').primaryKey(),
		cachePrefix: text('cache_prefix').notNull(),
		graceSeconds: integer('grace_seconds').notNull(),
		createdAt: text('created_at').notNull()
	},
	(table) => [
		unique('retention_grace_policy_cache_prefix_unique').on(table.cachePrefix)
	]
);

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

// An OIDC trust rule federates an external identity into a set of cupboard
// grants: an inbound token verified against `issuer`'s discovered JWKS, with
// `audience` and every `claims_json` entry matched exactly, may exchange for the
// grants `permitted_grants_json` permits. The issuer's `jwks_uri` and signing
// algorithms come from its OIDC metadata, not this row. The owner's rule is
// seeded from deploy config with a wildcard grant; `display_json` carries the
// human-facing provenance a preset pins. `disabled_at` soft-disables a rule
// without losing the audit row.
export const oidcTrust = sqliteTable('oidc_trust', {
	id: text('id').primaryKey(),
	issuer: text('issuer').notNull(),
	audience: text('audience').notNull(),
	claimsJson: text('claims_json').notNull().default('{}'),
	permittedGrantsJson: text('permitted_grants_json').notNull().default('[]'),
	displayJson: text('display_json'),
	createdAt: text('created_at').notNull(),
	disabledAt: text('disabled_at')
});

// A named reuse view: tenant configuration naming a set of caches another
// cache's reads may substitute from. `revision` is issued by
// `reuse_view_revision_seq`, its own persistent counter; source selectors
// live in `reuse_view_selector`, keyed by name so a wholesale replace of a
// view's selectors is a delete-and-reinsert under one name.
export const reuseViews = sqliteTable('reuse_view', {
	name: text('name').primaryKey(),
	revision: integer('revision').notNull(),
	priority: integer('priority').notNull(),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull()
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

// The durable, strictly-increasing revision counter per reuse-view name.
// Mirrors `generation_seq`: it is NEVER deleted when the view it names is
// removed, so a view recreated under the same name can never repeat a
// revision. The read path's ABA fence (telling a genuine recreation apart
// from no change at all) depends on that guarantee holding.
export const reuseViewRevisionSeq = sqliteTable('reuse_view_revision_seq', {
	name: text('name').primaryKey(),
	nextRevision: integer('next_revision').notNull()
});
