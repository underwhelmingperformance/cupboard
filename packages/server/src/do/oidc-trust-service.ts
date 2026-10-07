import { type Logger } from '@cupboard/logger';
import { isDeepEqual } from '@cupboard/protocol/deep-equal';
import {
	type OidcAudience,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	type OidcTrustAddBody,
	type OidcTrustExtendBody,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import {
	hasMatchingIssuerAndAudience,
	type OidcClaims,
	type OidcTrustRule,
	type OidcTrustVerificationTarget,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import * as schema from '../db/schema.ts';
import {
	OidcIssuerTransportRequiredError,
	OidcTrustRuleChangedError,
	OidcTrustRuleNotFoundError,
	OwnerConfigurationInvalidError,
	OwnerRuleImmutableError,
	StoredOidcTrustInvalidError,
	SubjectTokenNotJwtError
} from '../errors.ts';
import { InboundTokenVerifier } from '../oidc/inbound-verifier.ts';
import {
	canUseLoopbackHttp,
	isAllowedIssuerTransport
} from '../oidc/issuer-policy.ts';
import { decodeInboundClaims } from '../oidc/oidc.ts';

import {
	oidcTrustRuleFromRow,
	oidcTrustSummaryFromRow,
	type OwnerConfig,
	ownerRuleId,
	type SchemaWriter,
	type ServerContext
} from './context.ts';
import { StoredGrantSpelling } from './stored-grant-spelling.ts';
import { type TenantIdentityService } from './tenant-identity-service.ts';

export interface OidcTrustRuleSnapshot {
	readonly rule: OidcTrustRule;
	readonly row: typeof schema.oidcTrust.$inferSelect;
}

interface UnreadableOidcTrustRow {
	readonly issuer: string;
	readonly audience: string;
	readonly error: StoredOidcTrustInvalidError;
}

/**
 * The enabled trust rules that the server can read, together with the stored
 * issuer and audience of each enabled row that it cannot read.
 */
export class EnabledOidcTrustRules {
	constructor(
		readonly snapshots: readonly OidcTrustRuleSnapshot[],
		private readonly unreadable: readonly UnreadableOidcTrustRow[]
	) {}

	get rules(): OidcTrustRule[] {
		return this.snapshots.map(({ rule }) => rule);
	}

	/**
	 * Throws the `StoredOidcTrustInvalidError` of an unreadable row whose issuer
	 * and audience match `claims`. Rule selection uses only the most specific
	 * matching rules. Without the unreadable row, a broader readable rule could
	 * therefore give the token more authority than the row would have allowed.
	 */
	requireReadableFor(claims: OidcClaims): void {
		const match = this.unreadable.find((row) =>
			hasMatchingIssuerAndAudience(row, claims)
		);

		if (match !== undefined) {
			throw match.error;
		}
	}
}

export class OidcTrustService {
	private readonly grantSpelling: StoredGrantSpelling;
	private readonly verifier: InboundTokenVerifier;

	constructor(
		private readonly context: ServerContext,
		private readonly tenantIdentity: TenantIdentityService
	) {
		this.grantSpelling = new StoredGrantSpelling(context);
		this.verifier = new InboundTokenVerifier(context.discovery);
	}

	private ownerConfig(
		database: SchemaWriter = this.context.db
	): OwnerConfig | undefined {
		// Tenant identity is the only source for the owner rule. An unconfigured
		// Durable Object therefore has no owner rule to seed.
		const identity = this.tenantIdentity.current(database);

		if (identity === undefined) {
			return undefined;
		}

		return this.validatedOwner(
			identity.ownerIssuer,
			identity.ownerSubject,
			identity.ownerAudience
		);
	}

	private validatedOwner(
		issuer: OidcIssuer,
		subject: OidcSubject,
		audience: OidcAudience
	): OwnerConfig | undefined {
		// A binding may be absent or empty when no owner is configured (e.g. in
		// local development); either way there is no rule to seed.
		if (!issuer || !subject || !audience) {
			return undefined;
		}

		// A configured-but-malformed issuer is a deploy error: surface it now
		// to prevent seeding a rule that can never match.
		const issuerUrl = IssuerUrl.parse(issuer);

		if (
			issuerUrl === undefined ||
			!isAllowedIssuerTransport(
				issuerUrl.value,
				canUseLoopbackHttp(this.context.env)
			)
		) {
			throw new OwnerConfigurationInvalidError(issuer);
		}

		return {
			issuer: oidcIssuerSchema.parse(issuerUrl.value),
			subject,
			audience
		};
	}

	listRules(): OidcTrustListResponse {
		const rules = this.context.db
			.select()
			.from(schema.oidcTrust)
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all()
			.map((row) =>
				oidcTrustSummaryFromRow(row, canUseLoopbackHttp(this.context.env))
			);

		return { rules };
	}

	getRule(id: TrustRuleId): OidcTrustSummary {
		const row = this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(eq(schema.oidcTrust.id, id))
			.get();

		if (row === undefined) {
			throw new OidcTrustRuleNotFoundError(id);
		}

		return oidcTrustSummaryFromRow(row, canUseLoopbackHttp(this.context.env));
	}

	async addRule(body: OidcTrustAddBody): Promise<OidcTrustSummary> {
		if (
			!isAllowedIssuerTransport(
				body.issuer,
				canUseLoopbackHttp(this.context.env)
			)
		) {
			throw new OidcIssuerTransportRequiredError(body.issuer);
		}

		const id = trustRuleIdSchema.parse(crypto.randomUUID());
		const createdAt = isoTimestamp(new Date());
		const permittedGrantsJson = await this.grantSpelling.permittedGrantsJson(
			body.permittedGrants
		);

		this.context.db
			.insert(schema.oidcTrust)
			.values({
				id,
				issuer: body.issuer,
				audience: body.audience,
				claimsJson: JSON.stringify(body.claims),
				permittedGrantsJson:
					this.grantSpelling.permittedGrantsForWrite(permittedGrantsJson),
				displayJson:
					body.display === undefined ? undefined : JSON.stringify(body.display),
				createdAt
			})
			.run();

		return {
			id,
			issuer: body.issuer,
			audience: body.audience,
			claims: body.claims,
			permittedGrants: body.permittedGrants,
			...(body.display !== undefined && { display: body.display }),
			disabled: false
		};
	}

	async extendRule(
		id: TrustRuleId,
		body: OidcTrustExtendBody
	): Promise<OidcTrustSummary> {
		if (id === ownerRuleId) {
			throw new OwnerRuleImmutableError(id);
		}

		const grants = [...body.expected.permittedGrants];

		for (const grant of body.permittedGrants) {
			if (grants.every((existing) => !isDeepEqual(existing, grant))) {
				grants.push(grant);
			}
		}

		const prepared = await this.grantSpelling.permittedGrantsJson(grants);

		return this.context.db.transaction((tx) => {
			const row = tx
				.select()
				.from(schema.oidcTrust)
				.where(eq(schema.oidcTrust.id, id))
				.get();

			if (
				row?.disabledAt !== null ||
				!isDeepEqual(
					oidcTrustSummaryFromRow(row, canUseLoopbackHttp(this.context.env)),
					body.expected
				)
			) {
				throw new OidcTrustRuleChangedError(id);
			}

			tx.update(schema.oidcTrust)
				.set({
					permittedGrantsJson:
						this.grantSpelling.permittedGrantsForWrite(prepared)
				})
				.where(eq(schema.oidcTrust.id, id))
				.run();

			return { ...body.expected, permittedGrants: grants };
		});
	}

	removeRule(id: TrustRuleId): OidcTrustRemoveResponse {
		const existing = this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(eq(schema.oidcTrust.id, id))
			.get();

		if (existing !== undefined && id === ownerRuleId) {
			throw new OwnerRuleImmutableError(id);
		}

		// Soft-disable so the audit row survives; `removed` reports whether this
		// call is what disabled an enabled rule.
		const wasRemoved = existing !== undefined && !existing.disabledAt;

		if (wasRemoved) {
			this.context.db
				.update(schema.oidcTrust)
				.set({ disabledAt: isoTimestamp(new Date()) })
				.where(eq(schema.oidcTrust.id, id))
				.run();
		}

		return { id, removed: wasRemoved };
	}

	decodeInbound(token: string): OidcClaims {
		try {
			return decodeInboundClaims(token);
		} catch {
			throw new SubjectTokenNotJwtError();
		}
	}

	verifyInbound(
		target: OidcTrustVerificationTarget,
		token: string,
		trustedAudiences: ReadonlySet<string>
	): Promise<VerifiedOidcClaims> {
		return this.verifier.verify(target, token, trustedAudiences);
	}

	enabledOidcTrustRules(logger: Logger): OidcTrustRule[] {
		return this.enabledOidcTrustRuleSnapshots(logger).rules;
	}

	/**
	 * The enabled rules to evaluate for `claims`, which are a verified token's
	 * claims or a refresh family's stored identity. Throws
	 * `StoredOidcTrustInvalidError` when an enabled row that the server cannot
	 * read has the same issuer and audience.
	 */
	enabledOidcTrustRulesFor(
		logger: Logger,
		claims: OidcClaims
	): OidcTrustRule[] {
		const enabled = this.enabledOidcTrustRuleSnapshots(logger);
		enabled.requireReadableFor(claims);

		return enabled.rules;
	}

	/**
	 * Returns readable enabled rules and the stored issuer and audience of
	 * unreadable enabled rows. Logs each unreadable row.
	 */
	enabledOidcTrustRuleSnapshots(logger: Logger): EnabledOidcTrustRules {
		const snapshots: OidcTrustRuleSnapshot[] = [];
		const unreadable: UnreadableOidcTrustRow[] = [];
		const rows = this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(isNull(schema.oidcTrust.disabledAt))
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all();

		for (const row of rows) {
			try {
				snapshots.push({
					rule: oidcTrustRuleFromRow(row, canUseLoopbackHttp(this.context.env)),
					row
				});
			} catch (error: unknown) {
				const fault =
					error instanceof StoredOidcTrustInvalidError
						? error
						: new StoredOidcTrustInvalidError(
								row.id,
								error instanceof Error ? error : new Error(String(error))
							);

				logger.error('stored OIDC trust rule skipped', {
					rule: row.id,
					reason: fault.message,
					cause: fault.cause
				});
				unreadable.push({
					issuer: row.issuer,
					audience: row.audience,
					error: fault
				});
			}
		}

		return new EnabledOidcTrustRules(snapshots, unreadable);
	}

	isEnabledSnapshotCurrent(
		snapshot: OidcTrustRuleSnapshot,
		database: SchemaWriter = this.context.db
	): boolean {
		const { row } = snapshot;
		const displayMatches =
			row.displayJson === null
				? isNull(schema.oidcTrust.displayJson)
				: eq(schema.oidcTrust.displayJson, row.displayJson);

		return (
			database
				.select({ id: schema.oidcTrust.id })
				.from(schema.oidcTrust)
				.where(
					and(
						eq(schema.oidcTrust.id, row.id),
						eq(schema.oidcTrust.issuer, row.issuer),
						eq(schema.oidcTrust.audience, row.audience),
						eq(schema.oidcTrust.claimsJson, row.claimsJson),
						eq(schema.oidcTrust.permittedGrantsJson, row.permittedGrantsJson),
						displayMatches,
						eq(schema.oidcTrust.createdAt, row.createdAt),
						isNull(schema.oidcTrust.disabledAt)
					)
				)
				.get() !== undefined
		);
	}

	seedOwnerRule(database: SchemaWriter = this.context.db): void {
		const owner = this.ownerConfig(database);

		if (owner === undefined) {
			// A deployment that clears its owner config revokes the owner's admin
			// rule, so no standing owner identity outlives the config that named it.
			database
				.delete(schema.oidcTrust)
				.where(eq(schema.oidcTrust.id, ownerRuleId))
				.run();
			return;
		}

		// Update the fixed rule in place and clear `disabledAt` so current deploy
		// configuration remains authoritative after an earlier disablement.
		const fields = {
			issuer: owner.issuer,
			audience: owner.audience,
			claimsJson: JSON.stringify({ sub: owner.subject }),
			permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }])
		};
		const createdAt = isoTimestamp(new Date());

		database
			.insert(schema.oidcTrust)
			.values({
				id: ownerRuleId,
				createdAt,
				...fields
			})
			.onConflictDoUpdate({
				target: schema.oidcTrust.id,
				set: { ...fields, disabledAt: sql`null` }
			})
			.run();
	}
}
