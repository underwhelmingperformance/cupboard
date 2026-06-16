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
	adminJwtTtlSeconds,
	issueAccessJwt,
	refreshTokenTtlSeconds,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
import { resolveRequestedGrants } from '../authz/issuance.ts';
import { constantTimeEqual } from '../crypto/crypto.ts';
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
	matchOidcTrust,
	type OidcClaims,
	type OidcTrustRule,
	ruleIsInteractive
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

	private async exchange(body: ParsedTokenRequest): Promise<Response> {
		if (body.subject_token === undefined) {
			throw new SubjectTokenRequiredError();
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
			body.authorization_details,
			{
				issued_token_type: issuedAccessTokenType
			}
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
			!constantTimeEqual(row.secretHash, presentedHash)
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
		if (
			claimed === undefined ||
			claimed.expiresAt <= new Date().toISOString()
		) {
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
		// permits a wildcard and no requested details narrow it; the claims are
		// unused and an empty set suffices.
		return this.issuedResponse(rule, claimed.subject, {}, undefined, {});
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
		const interactive = ruleIsInteractive(rule);
		const granted = resolveRequestedGrants(rule, claims, requested);
		const ttlSeconds = interactive ? adminJwtTtlSeconds : writeJwtTtlSeconds;
		const accessToken = await this.issueRuleToken(
			rule,
			subject,
			granted,
			ttlSeconds
		);

		// Only an interactive session gets a refresh token: a CI exchange
		// federates a fresh subject token per run, so a stored grant would only
		// accumulate rows.
		const refreshToken = interactive
			? await this.issueRefreshToken(rule.id, subject)
			: undefined;

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: ttlSeconds,
				...extra,
				...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
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

		this.context.db
			.insert(schema.refreshTokens)
			.values({
				id,
				secretHash: await sha256Hex(secret),
				ruleId,
				subject,
				createdAt: now.toISOString(),
				expiresAt: new Date(
					now.getTime() + refreshTokenTtlSeconds * 1000
				).toISOString()
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
}

// The wire form is `<id>.<secret>`: the id addresses the row, the secret
// proves possession against the stored hash.
function parseRefreshToken(
	token: string
): { id: string; secret: string } | undefined {
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
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value)
	);

	return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
