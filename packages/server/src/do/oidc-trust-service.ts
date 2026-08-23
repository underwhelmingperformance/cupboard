import {
	type OidcAudience,
	type OidcIssuer,
	oidcIssuerSchema,
	type OidcSubject,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type ParsedOidcTrustAddBody,
	type TrustRuleId,
	trustRuleIdSchema
} from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import {
	type OidcClaims,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { JWTPayload } from 'jose';

import * as schema from '../db/schema.ts';
import {
	IssuerUnavailableError,
	OidcIssuerTransportRequiredError,
	OidcTrustRuleNotFoundError,
	OwnerConfigurationInvalidError,
	OwnerRuleImmutableError,
	SubjectTokenNotJwtError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';
import {
	canUseLoopbackHttp,
	isAllowedIssuerTransport
} from '../oidc/issuer-policy.ts';
import {
	decodeInboundClaims,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';

import {
	oidcTrustRuleFromRow,
	oidcTrustSummaryFromRow,
	type OwnerConfig,
	ownerRuleId,
	type SchemaWriter,
	type ServerContext
} from './context.ts';
import { type TenantIdentityService } from './tenant-identity-service.ts';

const issuerRetryDelayMs = 100;

export interface OidcTrustRuleSnapshot {
	readonly rule: OidcTrustRule;
	readonly row: typeof schema.oidcTrust.$inferSelect;
}

export class OidcTrustService {
	constructor(
		private readonly context: ServerContext,
		private readonly tenantIdentity: TenantIdentityService
	) {}

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

	private async verifyInboundOnce(
		rule: OidcTrustRule,
		token: string
	): Promise<JWTPayload> {
		// Discovery and JWKS fetch failures are retryable issuer outages.
		// Signature and claim failures remain non-retryable token errors.
		let issuer;
		try {
			issuer = await this.context.discovery.resolve(rule.issuer);
		} catch (error: unknown) {
			throw new IssuerUnavailableError(rule.issuer, { cause: error });
		}

		try {
			// The signature is checked against the discovered keys, with issuer and
			// audience pinned.
			return await verifyInboundOidcToken(
				issuer.resolver,
				token,
				{
					issuer: rule.issuer,
					audience: rule.audience,
					algorithms: issuer.algorithms,
					requireIdTokenClaims: true
				},
				new Date()
			);
		} catch (error) {
			if (error instanceof OidcKeysUnreachableError) {
				throw new IssuerUnavailableError(rule.issuer, { cause: error });
			}

			throw new SubjectTokenVerificationFailedError();
		}
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

	addRule(body: ParsedOidcTrustAddBody): OidcTrustSummary {
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

		this.context.db
			.insert(schema.oidcTrust)
			.values({
				id,
				issuer: body.issuer,
				audience: body.audience,
				claimsJson: JSON.stringify(body.claims),
				permittedGrantsJson: JSON.stringify(body.permittedGrants),
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

	async verifyInbound(rule: OidcTrustRule, token: string): Promise<JWTPayload> {
		try {
			return await this.verifyInboundOnce(rule, token);
		} catch (error) {
			// Only the transient upstream refusal is retried; a token that failed
			// verification is refused at once. One short in-place retry absorbs an
			// issuer fetch blip before it costs the client a full round trip.
			if (!(error instanceof IssuerUnavailableError)) {
				throw error;
			}

			await new Promise((resolve) => setTimeout(resolve, issuerRetryDelayMs));

			return this.verifyInboundOnce(rule, token);
		}
	}

	enabledOidcTrustRules(): OidcTrustRule[] {
		return this.enabledOidcTrustRuleSnapshots().map(({ rule }) => rule);
	}

	enabledOidcTrustRuleSnapshots(): OidcTrustRuleSnapshot[] {
		return this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(isNull(schema.oidcTrust.disabledAt))
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all()
			.map((row) => ({
				rule: oidcTrustRuleFromRow(row, canUseLoopbackHttp(this.context.env)),
				row
			}));
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
