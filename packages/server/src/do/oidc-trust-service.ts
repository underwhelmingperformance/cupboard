import {
	oidcTrustAddBodySchema,
	type OidcTrustListResponse,
	type OidcTrustRemoveResponse,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { IssuerUrl } from '@cupboard/protocol/oidc-issuer';
import { asc, eq, isNull, sql } from 'drizzle-orm';
import type { JWTPayload } from 'jose';

import * as schema from '../db/schema.ts';
import {
	InvalidGrantError,
	IssuerUnavailableError,
	OwnerConfigurationInvalidError,
	OwnerRuleImmutableError
} from '../errors.ts';
import { parseRequestBody } from '../http/parse.ts';
import {
	decodeInboundClaims,
	OidcKeysUnreachableError,
	verifyInboundOidcToken
} from '../oidc/oidc.ts';
import { type OidcClaims, type OidcTrustRule } from '../oidc/oidc-trust.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import {
	oidcTrustRuleFromRow,
	oidcTrustSummaryFromRow,
	type OwnerConfig,
	ownerRuleId,
	type ServerContext
} from './context.ts';

export class OidcTrustService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService
	) {}

	async handleListOidcTrust(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const rules = this.context.db
			.select()
			.from(schema.oidcTrust)
			.orderBy(asc(schema.oidcTrust.createdAt), asc(schema.oidcTrust.id))
			.all()
			.map((row) => oidcTrustSummaryFromRow(row));

		return Response.json({ rules } satisfies OidcTrustListResponse);
	}

	async handleAddOidcTrust(request: Request): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const body = await parseRequestBody(oidcTrustAddBodySchema, request);
		const id = crypto.randomUUID();

		// Rules added through the API are always `write`; the only `admin` rule is
		// the owner, seeded from deploy config.
		this.context.db
			.insert(schema.oidcTrust)
			.values({
				id,
				issuer: body.issuer,
				audience: body.audience,
				scope: 'write',
				claimsJson: JSON.stringify(body.claims),
				allowedRootsJson: JSON.stringify(body.allowedRoots),
				createdAt: new Date().toISOString()
			})
			.run();

		return Response.json({
			id,
			issuer: body.issuer,
			audience: body.audience,
			scope: 'write',
			claims: body.claims,
			allowedRoots: body.allowedRoots,
			disabled: false
		} satisfies OidcTrustSummary);
	}

	async handleRemoveOidcTrust(request: Request, id: string): Promise<Response> {
		await this.authKeys.requireScope(request, 'admin');

		const existing = this.context.db
			.select()
			.from(schema.oidcTrust)
			.where(eq(schema.oidcTrust.id, id))
			.get();

		if (existing?.scope === 'admin') {
			throw new OwnerRuleImmutableError(id);
		}

		// Soft-disable so the audit row survives; `removed` reports whether this
		// call is what disabled an enabled rule.
		const removed = existing !== undefined && !existing.disabledAt;

		if (removed) {
			this.context.db
				.update(schema.oidcTrust)
				.set({ disabledAt: new Date().toISOString() })
				.where(eq(schema.oidcTrust.id, id))
				.run();
		}

		return Response.json({ id, removed } satisfies OidcTrustRemoveResponse);
	}

	decodeInbound(token: string): OidcClaims {
		try {
			return decodeInboundClaims(token);
		} catch {
			throw new InvalidGrantError('Subject token is not a JWT');
		}
	}

	async verifyInbound(rule: OidcTrustRule, token: string): Promise<JWTPayload> {
		// Discovery resolves the issuer's JWKS and its accepted algorithms. Failing
		// to reach the issuer is an upstream condition, not a bad token, so it is a
		// retryable 503 rather than a permanent `invalid_grant`.
		const issuer = await this.context.discovery
			.resolve(rule.issuer)
			.catch((error: unknown) => {
				throw new IssuerUnavailableError(rule.issuer, { cause: error });
			});

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
			// A JWKS fetch that fails (rather than the token failing verification)
			// is the same transient upstream condition as a discovery failure.
			if (error instanceof OidcKeysUnreachableError) {
				throw new IssuerUnavailableError(rule.issuer, { cause: error });
			}

			throw new InvalidGrantError('Subject token failed verification');
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

	private ownerConfig(): OwnerConfig | undefined {
		const issuer = this.context.env.CUPBOARD_OWNER_ISSUER;
		const subject = this.context.env.CUPBOARD_OWNER_SUBJECT;
		const audience = this.context.env.CUPBOARD_OWNER_AUDIENCE;

		// A binding may be absent or empty when no owner is configured (e.g. in
		// local development); either way there is no rule to seed.
		if (!issuer || !subject || !audience) {
			return undefined;
		}

		// A configured-but-malformed issuer is a deploy error: surface it now
		// rather than seeding a rule that can never match (a silent admin lockout).
		const issuerUrl = IssuerUrl.parse(issuer);

		if (issuerUrl === undefined) {
			throw new OwnerConfigurationInvalidError(issuer);
		}

		return { issuer: issuerUrl.value, subject, audience };
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
			claimsJson: JSON.stringify({ sub: owner.subject })
		};

		this.context.db
			.insert(schema.oidcTrust)
			.values({
				id: ownerRuleId,
				scope: 'admin',
				allowedRootsJson: '[]',
				createdAt: new Date().toISOString(),
				...fields
			})
			.onConflictDoUpdate({
				target: schema.oidcTrust.id,
				set: { ...fields, disabledAt: sql`null` }
			})
			.run();
	}
}
