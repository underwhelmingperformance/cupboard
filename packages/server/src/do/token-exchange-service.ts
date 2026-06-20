import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	type ParsedTokenRequest,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import { and, eq } from 'drizzle-orm';

import {
	type AccessClaims,
	adminJwtTtlSeconds,
	issueAccessJwt,
	refreshTokenTtlSeconds,
	verifyAccessJwt,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
import {
	attenuatedGrants,
	parseRequestedGrants,
	resolveRequestedGrants
} from '../authz/issuance.ts';
import { isConstantTimeEqual } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import {
	RefreshTokenRequiredError,
	StaleRefreshTokenError,
	SubjectTokenRequiredError,
	TenantSubjectTokenUntrustedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import { parseFormBody } from '../http/parse.ts';
import {
	isRuleInteractive,
	matchOidcTrust,
	type OidcClaims,
	type OidcTrustRule
} from '../oidc/oidc-trust.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type ServerContext } from './context.ts';
import { type OidcTrustService } from './oidc-trust-service.ts';

export class TokenExchangeService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly oidcTrust: OidcTrustService
	) {}

	private async exchange(body: ParsedTokenRequest): Promise<Response> {
		if (body.subject_token === undefined) {
			throw new SubjectTokenRequiredError();
		}

		// Attenuation is detected by signature, not the declared token type: a
		// subject token this tenant itself issued is narrowed to a requested subset
		// of its own grants rather than routed to a trust rule.
		const presented = await this.verifySelfIssued(body.subject_token);

		if (presented !== undefined) {
			return this.attenuatedResponse(
				presented,
				parseRequestedGrants(body.authorization_details)
			);
		}

		if (
			body.subject_token_type !== subjectTokenTypeIdToken &&
			body.subject_token_type !== subjectTokenTypeJwt
		) {
			throw new UnsupportedSubjectTokenTypeError(
				String(body.subject_token_type)
			);
		}

		// Matching routes the token to a rule on its unverified claims; the
		// signature is then checked against that rule's issuer JWKS before any
		// cupboard token is issued, so a forged claim cannot earn a scope.
		const claims = this.oidcTrust.decodeInbound(body.subject_token);
		const rule = matchOidcTrust(this.oidcTrust.enabledOidcTrustRules(), claims);

		if (rule === undefined) {
			throw new TenantSubjectTokenUntrustedError();
		}

		const verified = await this.oidcTrust.verifyInbound(
			rule,
			body.subject_token
		);
		const subject =
			typeof verified.sub === 'string' && verified.sub !== ''
				? verified.sub
				: rule.id;

		// Bindings are evaluated against the verified payload, never the unverified
		// claims used only to route the token to a rule.
		return this.issuedResponse(
			rule,
			subject,
			verified,
			parseRequestedGrants(body.authorization_details),
			{ issued_token_type: issuedAccessTokenType }
		);
	}

	// Verifies a subject token against this tenant's own auth keys. A token that
	// verifies is one cupboard issued; anything else (an external OIDC token, a
	// forgery) returns undefined and falls through to the trust-rule path, so the
	// branch cannot be chosen by a client-declared type.
	private async verifySelfIssued(
		token: string
	): Promise<AccessClaims | undefined> {
		const keys = await this.authKeys.authVerificationKeys();

		try {
			return await verifyAccessJwt(
				keys,
				token,
				{
					issuer: this.authKeys.authIssuer(),
					audience: this.authKeys.authAudience()
				},
				new Date()
			);
		} catch {
			return undefined;
		}
	}

	// Reissues a presented self-token narrowed to a requested subset of its
	// grants, with no refresh token: attenuation is storage-free and the
	// presenter already holds a session.
	private async attenuatedResponse(
		presented: AccessClaims,
		requested: AuthorizationDetails | undefined
	): Promise<Response> {
		const granted = attenuatedGrants(presented.grants, requested);
		const key = await this.authKeys.activeAuthKey();
		const accessToken = await issueAccessJwt(
			key.privateJwk,
			{
				issuer: this.authKeys.authIssuer(),
				audience: this.authKeys.authAudience(),
				subject: presented.subject,
				grants: granted,
				kid: key.kid,
				ttlSeconds: writeJwtTtlSeconds
			},
			new Date()
		);

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: writeJwtTtlSeconds,
				issued_token_type: issuedAccessTokenType,
				authorization_details: granted
			} satisfies TokenResponse,
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	private async refresh(body: ParsedTokenRequest): Promise<Response> {
		if (body.refresh_token === undefined) {
			throw new RefreshTokenRequiredError();
		}

		const presented = parseRefreshToken(body.refresh_token);

		if (presented === undefined) {
			throw new StaleRefreshTokenError();
		}

		// Hash the presented secret before touching the row. The hash is the only
		// await in the verify-and-consume path; doing it first leaves the lookup and
		// the compare-and-delete with no await between them, so a second presentation
		// of the same token cannot interleave the input gate and issue a second
		// session. The durable-SQLite reads and writes are synchronous, so the block
		// below runs to completion before any concurrent request resumes.
		const presentedHash = await sha256Hex(presented.secret);

		const row = this.context.db
			.select()
			.from(schema.refreshTokens)
			.where(eq(schema.refreshTokens.id, presented.id))
			.get();

		if (
			row === undefined ||
			!isConstantTimeEqual(row.secretHash, presentedHash)
		) {
			throw new StaleRefreshTokenError();
		}

		// Compare-and-delete: consume the row only while it still carries the
		// presented secret, returning what was removed. Of two concurrent
		// presentations only the one that removes the row proceeds; the loser removes
		// nothing and is refused.
		const consumed = this.context.db
			.delete(schema.refreshTokens)
			.where(
				and(
					eq(schema.refreshTokens.id, presented.id),
					eq(schema.refreshTokens.secretHash, presentedHash)
				)
			)
			.returning()
			.all();
		const claimed = consumed.at(0);

		// Lost the consume race, or the row was expired (reclaimed on touch): refused.
		const now = new Date();
		const nowIso = now.toISOString();

		if (claimed === undefined || claimed.expiresAt <= nowIso) {
			throw new StaleRefreshTokenError();
		}

		const rule = this.oidcTrust
			.enabledOidcTrustRules()
			.find((candidate) => candidate.id === claimed.ruleId);

		// The row is already consumed, so a retired rule simply refuses the grant.
		if (rule === undefined) {
			throw new StaleRefreshTokenError();
		}

		// A refresh only happens for an interactive session, so the rule still
		// permits a wildcard and the claims it would bind against go unused. A
		// refreshed session may narrow itself by naming `authorization_details`,
		// verified against the rule the same way an exchange is.
		return this.issuedResponse(
			rule,
			claimed.subject,
			{},
			parseRequestedGrants(body.authorization_details),
			{}
		);
	}

	// Issues the access token (and, for an interactive session, a successor
	// refresh token) for a rule, reading the rule's current grants so a refreshed
	// session never outlives an edit to its rule.
	private async issuedResponse(
		rule: OidcTrustRule,
		subject: string,
		claims: OidcClaims,
		requested: AuthorizationDetails | undefined,
		extra: Pick<TokenResponse, 'issued_token_type'>
	): Promise<Response> {
		const isInteractive = isRuleInteractive(rule);
		const granted = resolveRequestedGrants(rule, claims, requested);
		const ttlSeconds = isInteractive ? adminJwtTtlSeconds : writeJwtTtlSeconds;
		const accessToken = await this.issueRuleToken(
			rule,
			subject,
			granted,
			ttlSeconds
		);

		// Only an interactive session gets a refresh token: a CI exchange
		// federates a fresh subject token per run, so a stored grant would only
		// accumulate rows.
		const refreshToken = isInteractive
			? await this.issueRefreshToken(rule.id, subject)
			: undefined;

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: ttlSeconds,
				...extra,
				...(refreshToken !== undefined && { refresh_token: refreshToken }),
				authorization_details: granted
			} satisfies TokenResponse,
			{ headers: { 'cache-control': 'no-store' } }
		);
	}

	private async issueRefreshToken(
		ruleId: string,
		subject: string
	): Promise<string> {
		const id = crypto.randomUUID();
		const secret = randomSecretHex();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + refreshTokenTtlSeconds * 1000);

		this.context.db
			.insert(schema.refreshTokens)
			.values({
				id,
				secretHash: await sha256Hex(secret),
				ruleId,
				subject,
				createdAt: now.toISOString(),
				expiresAt: expiresAt.toISOString()
			})
			.run();

		return `${id}.${secret}`;
	}

	private async issueRuleToken(
		rule: OidcTrustRule,
		subject: string,
		grants: AuthorizationDetails,
		ttlSeconds: number
	): Promise<string> {
		const key = await this.authKeys.activeAuthKey();

		return issueAccessJwt(
			key.privateJwk,
			{
				issuer: this.authKeys.authIssuer(),
				audience: this.authKeys.authAudience(),
				subject,
				grants,
				kid: key.kid,
				ttlSeconds,
				auditClaims: { cb_rule: rule.id }
			},
			new Date()
		);
	}

	async handleToken(request: Request): Promise<Response> {
		const body = await parseFormBody(tokenRequestSchema, request);

		if (body.grant_type === tokenExchangeGrantType) {
			return this.exchange(body);
		}

		if (body.grant_type === refreshTokenGrantType) {
			return this.refresh(body);
		}

		throw new UnsupportedGrantTypeError(body.grant_type);
	}
}

// The wire form is `<id>.<secret>`: the id addresses the row, the secret
// proves possession against the stored hash.
function parseRefreshToken(
	token: string
): undefined | { id: string; secret: string } {
	const separator = token.indexOf('.');

	if (separator <= 0 || separator === token.length - 1) {
		return undefined;
	}

	return {
		id: token.slice(0, separator),
		secret: token.slice(separator + 1)
	};
}

function randomSecretHex(): string {
	return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256Hex(value: string): Promise<string> {
	const encoder = new TextEncoder();
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));

	return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
