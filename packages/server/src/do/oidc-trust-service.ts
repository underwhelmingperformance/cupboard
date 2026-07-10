import {
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary,
	type ParsedOidcTrustAddBody
} from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { JWTPayload } from 'jose';

import * as schema from '../db/schema.ts';
import {
	IssuerUnavailableError,
	OidcTrustRuleNotFoundError,
	OwnerConfigurationInvalidError,
	OwnerRuleImmutableError,
	SubjectTokenNotJwtError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';
import {
	decodeInboundClaims,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';
import { type OidcClaims, type OidcTrustRule } from '../oidc/oidc-trust.ts';

import {
	oidcTrustRuleFromRow,
	oidcTrustSummaryFromRow,
	type OwnerConfig,
	ownerRuleId,
	type ServerContext
} from './context.ts';
import { type TenantIdentityService } from './tenant-identity-service.ts';

// How long an inbound verify waits before its one retry of an issuer that
// could not be reached.
const issuerRetryDelayMs = 100;

export class OidcTrustService {
	constructor(
		private readonly context: ServerContext,
		private readonly tenantIdentity: TenantIdentityService
	) {}

	private ownerConfig(): OwnerConfig | undefined {
		// The assigned identity is the sole owner source: an unconfigured Durable
		// Object has no owner rule to seed (and 500s before it serves anyway).
		const identity = this.tenantIdentity.current();

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
		issuer: string,
		subject: string,
		audience: string
	): OwnerConfig | undefined {
		// A binding may be absent or empty when no owner is configured (e.g. in
		// local development); either way there is no rule to seed.
		if (!issuer || !subject || !audience) {
			return undefined;
		}

		// A configured-but-malformed issuer is a deploy error: surface it now
		// to prevent seeding a rule that can never match.
		const issuerUrl = IssuerUrl.parse(issuer);

		if (issuerUrl === undefined) {
			throw new OwnerConfigurationInvalidError(issuer);
		}

		return { issuer: issuerUrl.value, subject, audience };
	}

	private async verifyInboundOnce(
		rule: OidcTrustRule,
		token: string
	): Promise<JWTPayload> {
		// Discovery resolves the issuer's JWKS and its accepted algorithms. Failing
		// to reach the issuer is an upstream condition, not a bad token, so it yields
		// a retryable 503.
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
					algorithms: issuer.algorithms
				},
				new Date()
			);
		} catch (error) {
			// A JWKS fetch failure is the same transient upstream condition as a discovery failure.
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
			.map((row) => oidcTrustSummaryFromRow(row));

		return { rules };
	}

	getRule(id: string): OidcTrustSummary {
		const row = this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(eq(schema.oidcTrust.id, id))
			.get();

		if (row === undefined) {
			throw new OidcTrustRuleNotFoundError(id);
		}

		return oidcTrustSummaryFromRow(row);
	}

	addRule(body: ParsedOidcTrustAddBody): OidcTrustSummary {
		const id = crypto.randomUUID();
		const now = new Date();
		const createdAt = now.toISOString();

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

	removeRule(id: string): OidcTrustRemoveResponse {
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
			const now = new Date();
			const disabledAt = now.toISOString();

			this.context.db
				.update(schema.oidcTrust)
				.set({ disabledAt })
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
		return this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(isNull(schema.oidcTrust.disabledAt))
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all()
			.map((row) => oidcTrustRuleFromRow(row));
	}

	seedOwnerRule(): void {
		const owner = this.ownerConfig();

		if (owner === undefined) {
			// A deployment that clears its owner config revokes the owner's admin
			// rule, so no standing owner identity outlives the config that named it.
			this.context.db
				.delete(schema.oidcTrust)
				.where(eq(schema.oidcTrust.id, ownerRuleId))
				.run();
			return;
		}

		// Redeploying with new owner config updates the rule in place, so the owner
		// identity always tracks deploy config. Clearing `disabledAt` on conflict
		// re-enables it, so the owner is restored even if the rule was ever
		// disabled out of band. `ownerConfig` has already normalised the issuer.
		const fields = {
			issuer: owner.issuer,
			audience: owner.audience,
			claimsJson: JSON.stringify({ sub: owner.subject }),
			// The owner is the interactive trust class: a single wildcard grant
			// covers every operation in its domain.
			permittedGrantsJson: JSON.stringify([{ type: 'cupboard_wildcard' }])
		};
		const now = new Date();
		const createdAt = now.toISOString();

		this.context.db
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
