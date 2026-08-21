import { type NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type AuthKeyId,
	type NarInfoGeneration,
	type NixSha256HashString,
	type RootName,
	type TenantId,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import { type ResolvedRootTarget } from '@cupboard/nix-store/store-path';
import {
	oidcTrustDisplaySchema,
	storedPermittedGrantsSchema
} from '@cupboard/protocol/grants';
import {
	claimMatchSchema,
	type OidcAudience,
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	type OidcTrustSummary,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { type OidcTrustRule } from '@cupboard/protocol/oidc-trust-match';
import {
	type GracePolicySummary,
	type RetentionPolicySummary
} from '@cupboard/protocol/retention';
import {
	type ParsedReuseViewSelector,
	type ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import { type IsoTimestamp } from '@cupboard/protocol/scalars';
import { type TenantStatus } from '@cupboard/protocol/tenants';
import { drizzle as drizzleD1, type DrizzleD1Database } from 'drizzle-orm/d1';
import {
	drizzle,
	type DrizzleSqliteDODatabase
} from 'drizzle-orm/durable-sqlite';
import { z } from 'zod';

import { r2PresignConfiguration, R2Presigner } from '../blob/presign.ts';
import {
	PushCredentialIssuer,
	pushIdSigningKey
} from '../blob/push-credential.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	StoredOidcTrustInvalidError,
	TenantNotConfiguredError
} from '../errors.ts';
import { parseStored } from '../http/parse.ts';
import { OidcDiscoveryStore } from '../oidc/oidc.ts';

import { boundedBlobs, boundedD1 } from './bounded-io.ts';
import { DatabaseCostMeter, meteredStorage } from './database-cost-meter.ts';
import { criticalSectionBudgetMs, withDeadlineBudget } from './deadline.ts';
import { boundedSubrequest } from './deadline.ts';
import { NegotiateHintStore } from './negotiate-hints.ts';
import { ObjectWriteOrder } from './object-write-order.ts';

type WidenStringBindings<T> = {
	readonly [Key in keyof T]: T[Key] extends string ? string : T[Key];
};

// `TenantEnv` is generated from `wrangler.tenant.jsonc`, the config for the script
// this Durable Object actually runs in. It deliberately excludes the control-plane
// bindings (the signing-key wrapping secret, the control audience): the Durable
// Object runs in its own script's context and cannot reach them, and this type
// makes any attempt to read one a compile error.
export type RuntimeEnv = WidenStringBindings<TenantEnv>;

export type SchemaDatabase = DrizzleSqliteDODatabase<typeof schema>;

// Either the DO database or a transaction handle from db.transaction(...); both
// expose the same query builder, so writes can be parameterised over the handle.
export type SchemaWriter =
	SchemaDatabase | Parameters<Parameters<SchemaDatabase['transaction']>[0]>[0];

// The owner's admin trust rule is seeded under a fixed id from deploy config;
// the admin CRUD uses generated ids, so it never collides with this one.
export const ownerRuleId = trustRuleIdSchema.parse('owner');

// A stored claim value is an exact string or a `{ pattern }` match, the same
// shape the admin contract accepts and stores. Reading must admit every value
// `addRule` can persist, or one pattern claim would fail every rule read on the
// tenant, including the batch that token exchange matches against.
export const storedClaimsSchema = z.record(z.string(), claimMatchSchema);

export interface OwnerConfig {
	readonly issuer: OidcIssuer;
	readonly subject: OidcSubject;
	readonly audience: OidcAudience;
}

export interface GarbageCollectionOutcome {
	readonly pendingUploadsDeleted: number;
	readonly pendingAttestationsDeleted: number;
	readonly rootsExpired: number;
	readonly pathsCollected: number;
	readonly hasMoreExpiredRoots: boolean;
	readonly hasMoreWork: boolean;
	readonly narInfosDeleted: number;
	readonly orphanStagingDeleted: number;
}

// A key in the auth signing set. The newest non-retired key issues; every
// non-retired key verifies and is published in the JWKS. Retiring sets
// `retired`, dropping the key from issuing, verification and the JWKS at once.
export interface AuthKey {
	readonly kid: AuthKeyId;
	readonly privateJwk: JsonWebKey;
	readonly publicJwk: JsonWebKey;
	readonly createdAt: IsoTimestamp;
	readonly scheduledRetireAt?: IsoTimestamp;
	readonly retired: boolean;
}

export interface RootSetCommand {
	readonly name: RootName;
	readonly targets: readonly ResolvedRootTarget[];
	readonly ttlSeconds: TtlSeconds | undefined;
}

// The outcome of reserving a narinfo row: `reserved` when this commit inserted
// the row (it owns the path and reports `committed`), `mine` when an identical
// commit already holds it (a concurrent winner or this same upload re-driven),
// `lost` when a different narinfo version holds it.
export type ReserveOutcome =
	| { kind: 'reserved'; generation: NarInfoGeneration }
	| { kind: 'mine'; generation: NarInfoGeneration }
	| { kind: 'lost'; narHash: NixSha256HashString };

// The outcome of materialising a reserved narinfo: `materialised` on success,
// carrying the rendered narinfo whose object the caller publishes after the
// gate; `superseded` when a concurrent recommit replaced the reserved version;
// `blob-gone` when the shared blob (`blob_state` or the canonical object) is no
// longer present and the path must be re-uploaded; `over-quota` when charging the
// blob's canonical size would exceed the tenant's quota (the caller reclaims the
// reserved row); `tenant-inactive` when the tenant is no longer active (suspended,
// offboarding, offboarded, or gone) and the caller reclaims the reserved row.
export type MaterialiseOutcome =
	| {
			readonly kind: 'materialised';
			readonly narInfo: NarInfo;
			// The grace deadline this materialisation extended the path to, when
			// its captured decision granted one.
			readonly graceRetainUntil?: IsoTimestamp;
	  }
	| { readonly kind: 'superseded' }
	| { readonly kind: 'blob-gone' }
	| { readonly kind: 'over-quota' }
	| {
			readonly kind: 'tenant-inactive';
			// The status the gate observed, or undefined when the registry row is
			// gone.
			readonly tenantStatus: TenantStatus | undefined;
	  };

// The shared state every service is constructed with: the DO SQLite handle, the
// global D1 handle, the runtime environment, the DO state (for critical
// sections), the inbound-OIDC discovery store, and the lazy R2 presigner.
export class ServerContext {
	private presigner: R2Presigner | undefined;
	private credentialIssuer: PushCredentialIssuer | undefined;
	readonly db: SchemaDatabase;
	readonly d1: DrizzleD1Database<typeof d1Schema>;
	// The deadline a critical section imposes on its subrequests. A field, not the
	// bare constant, so a test can shorten it to exercise the timeout path without
	// waiting the full budget.
	gateBudgetMs = criticalSectionBudgetMs;
	// Sums the rows this DO's SQLite reads and writes, so a request's cost can be
	// logged when it ends and asserted on in tests.
	readonly dbCost = new DatabaseCostMeter();
	env: RuntimeEnv;
	readonly ctx: DurableObjectState;
	discovery = new OidcDiscoveryStore();
	// Set once the control plane begins offboarding this tenant, so the verify-restore
	// path no-ops while the drain removes narinfo objects.
	// In-memory is sufficient: a new write is already refused by the Worker's status
	// gate, so the only caller to guard is an in-flight commit settling on this warm
	// instance, which sees the flag set by the same instance's offboard RPC.
	offboarding = false;
	// The Worker-staged negotiate hints awaiting their dispatch; see
	// {@link NegotiateHintStore}.
	readonly negotiateHints = new NegotiateHintStore();
	// Orders the mutations of path-keyed R2 objects behind any abandoned
	// (timed-out) mutation of the same key; see {@link ObjectWriteOrder}.
	readonly objectWrites = new ObjectWriteOrder();

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		this.ctx = ctx;
		// Every R2 and D1 call the services make is bounded, so a stalled
		// subrequest cannot hold this object's input gate to the ~30s
		// `blockConcurrencyWhile` reset. R2 is reached through `env.BLOBS`, so the
		// binding is replaced with a bounded one here rather than at every call site.
		this.env = { ...env, BLOBS: boundedBlobs(env.BLOBS) };
		this.db = drizzle(meteredStorage(ctx.storage, this.dbCost), { schema });
		// The global shared-blob facts live in D1, readable and writable by every
		// tenant DO and the Worker.
		this.d1 = drizzleD1(boundedD1(env.CUPBOARD_DB), { schema: d1Schema });
	}

	// A request-path critical section: arriving events are gated out while `run`
	// executes, exactly as `blockConcurrencyWhile` gates them, but a failure
	// propagates to the caller as an ordinary rejection. The runtime breaks the
	// whole object when the gated callback itself throws, turning one transient
	// storage fault into a failure for every in-flight request; every section
	// here is an idempotent saga step whose caller already handles the
	// rejection, so the object must survive it.
	async criticalSection<T>(run: () => Promise<T>): Promise<T> {
		type Outcome = { ok: true; value: T } | { ok: false; error: unknown };

		const outcome = await this.ctx.blockConcurrencyWhile(
			async (): Promise<Outcome> => {
				try {
					return {
						ok: true,
						value: await withDeadlineBudget(this.gateBudgetMs, run)
					};
				} catch (error) {
					return { ok: false, error };
				}
			}
		);

		if (!outcome.ok) {
			throw outcome.error;
		}

		return outcome.value;
	}

	r2Presigner(): R2Presigner {
		this.presigner ??= new R2Presigner(r2PresignConfiguration(this.env));

		return this.presigner;
	}

	pushCredentials(): PushCredentialIssuer {
		this.credentialIssuer ??= new PushCredentialIssuer(
			() => r2PresignConfiguration(this.env),
			pushIdSigningKey(this.env)
		);

		return this.credentialIssuer;
	}

	async purgeCacheTags(tags: readonly string[]): Promise<void> {
		interface CachePurgeEntrypoint {
			purgeTags(tags: string[]): Promise<void>;
		}

		const { CachedTenantReads: entrypoint } = this.ctx.exports as unknown as {
			CachedTenantReads: CachePurgeEntrypoint;
		};
		await boundedSubrequest(
			() => entrypoint.purgeTags([...tags]),
			'cache.purge'
		);
	}

	// This Durable Object's tenant slug, the sole source of the tenant scope in
	// its D1 reference edges and R2 narinfo keys. It comes from the assigned
	// identity, so a route that reaches a write has already passed the
	// not-configured guard; an absent row here is a programming error and is
	// surfaced as an exception.
	requireTenant(): TenantId {
		const row = this.db
			.select({ tenant: schema.tenantIdentity.tenant })
			.from(schema.tenantIdentity)
			.get();

		if (row === undefined) {
			throw new TenantNotConfiguredError();
		}

		return row.tenant;
	}
}

export function oidcTrustRuleFromRow(
	row: typeof schema.oidcTrust.$inferSelect
): OidcTrustRule {
	const fault = (cause: Error): StoredOidcTrustInvalidError =>
		new StoredOidcTrustInvalidError(row.id, cause);

	return {
		id: row.id,
		issuer: oidcIssuerSchema.parse(row.issuer),
		audience: oidcAudienceSchema.parse(row.audience),
		claims: parseStored(storedClaimsSchema, row.claimsJson, fault),
		permittedGrants: parseStored(
			storedPermittedGrantsSchema,
			row.permittedGrantsJson,
			fault
		),
		...(row.displayJson !== null && {
			display: parseStored(oidcTrustDisplaySchema, row.displayJson, fault)
		})
	};
}

// The admin-facing view of a rule. It omits `jwks_url`, so the listing says who
// is trusted without restating where their keys are fetched from.
export function oidcTrustSummaryFromRow(
	row: typeof schema.oidcTrust.$inferSelect
): OidcTrustSummary {
	const rule = oidcTrustRuleFromRow(row);

	return {
		id: rule.id,
		issuer: rule.issuer,
		audience: rule.audience,
		claims: { ...rule.claims },
		permittedGrants: [...rule.permittedGrants],
		...(rule.display !== undefined && { display: rule.display }),
		disabled: Boolean(row.disabledAt)
	};
}

export function policySummaryFromRow(
	row: typeof schema.retentionPolicies.$inferSelect
): RetentionPolicySummary {
	return {
		id: row.id,
		scope: row.scope,
		pattern: row.pattern,
		ttlSeconds: row.defaultTtlSeconds
	};
}

export function gracePolicySummaryFromRow(
	row: typeof schema.retentionGracePolicies.$inferSelect
): GracePolicySummary {
	return {
		id: row.id,
		cachePrefix: row.cachePrefix,
		graceSeconds: row.graceSeconds,
		createdAt: row.createdAt
	};
}

export function reuseViewSummaryFromRow(
	row: typeof schema.reuseViews.$inferSelect,
	selectors: readonly ParsedReuseViewSelector[]
): ReuseViewSummary {
	return {
		name: row.name,
		revision: row.revision,
		priority: row.priority,
		selectors: [...selectors],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}
