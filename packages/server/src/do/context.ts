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

// Keep this environment narrower than the control plane's environment. Tenant
// Durable Objects cannot access control-plane secrets or bindings.
export type RuntimeEnv = WidenStringBindings<TenantEnv>;

export type SchemaDatabase = DrizzleSqliteDODatabase<typeof schema>;

export type SchemaWriter =
	SchemaDatabase | Parameters<Parameters<SchemaDatabase['transaction']>[0]>[0];

// Admin-created rules use generated IDs, so this reserved ID cannot collide
// with them.
export const ownerRuleId = trustRuleIdSchema.parse('owner');

// Parse both forms accepted by `addRule`. Rejecting a stored pattern would make
// every trust-rule read fail for the tenant, including token exchange.
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

// The newest non-retired key signs tokens. Every non-retired key verifies
// tokens and appears in the JWKS; retirement removes it from all three uses.
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

export type ReserveOutcome =
	| { kind: 'reserved'; generation: NarInfoGeneration }
	| { kind: 'mine'; generation: NarInfoGeneration }
	| { kind: 'lost'; narHash: NixSha256HashString };

export type MaterialiseOutcome =
	| {
			readonly kind: 'materialised';
			readonly narInfo: NarInfo;
			readonly graceRetainUntil?: IsoTimestamp;
	  }
	| { readonly kind: 'superseded' }
	| { readonly kind: 'blob-gone' }
	| { readonly kind: 'over-quota' }
	| {
			readonly kind: 'tenant-inactive';
			readonly tenantStatus: TenantStatus | undefined;
	  };

export class ServerContext {
	private presigner: R2Presigner | undefined;
	private credentialIssuer: PushCredentialIssuer | undefined;
	readonly db: SchemaDatabase;
	readonly d1: DrizzleD1Database<typeof d1Schema>;
	gateBudgetMs = criticalSectionBudgetMs;
	readonly dbCost = new DatabaseCostMeter();
	env: RuntimeEnv;
	readonly ctx: DurableObjectState;
	discovery = new OidcDiscoveryStore();
	// This closes the warm-instance race between an in-flight commit and the
	// offboarding drain. New writes are already rejected at the Worker.
	offboarding = false;
	readonly negotiateHints = new NegotiateHintStore();
	// A timed-out R2 mutation can continue in the background. Keep later writes
	// to the same key behind it so they cannot land out of order.
	readonly objectWrites = new ObjectWriteOrder();

	constructor(ctx: DurableObjectState, env: RuntimeEnv) {
		this.ctx = ctx;
		// Bound all storage subrequests before a service can use them. Otherwise a
		// stalled request inside the input gate can force the runtime to reset the
		// Durable Object after about 30 seconds.
		this.env = { ...env, BLOBS: boundedBlobs(env.BLOBS) };
		this.db = drizzle(meteredStorage(ctx.storage, this.dbCost), { schema });
		this.d1 = drizzleD1(boundedD1(env.CUPBOARD_DB), { schema: d1Schema });
	}

	// Do not let an error escape from `blockConcurrencyWhile`: the runtime would
	// break the Durable Object and fail every in-flight request. Return the error
	// through the gate and reject only this caller instead.
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

	// Derive D1 reference and R2 narinfo ownership from the Durable Object's
	// assigned tenant identity. Do not accept tenant scope from a request.
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
