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
import { eq } from 'drizzle-orm';

import {
	adminJwtTtlSeconds,
	mintAccessJwt,
	refreshTokenTtlSeconds,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
import * as schema from '../db/schema.ts';
import {
	InvalidGrantError,
	InvalidRequestError,
	UnsupportedGrantTypeError
} from '../errors.ts';
import { parseFormBody } from '../http/parse.ts';
import { matchOidcTrust, type OidcTrustRule } from '../oidc/oidc-trust.ts';

import { type AuthKeysService } from './auth-keys-service.ts';
import { type ServerContext } from './context.ts';
import { type OidcTrustService } from './oidc-trust-service.ts';

// One message for every refresh failure mode (unknown id, wrong secret,
// expiry, retired rule), so a probe cannot tell which part was wrong.
const staleRefreshTokenMessage = 'Refresh token is invalid or expired';

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
			throw new InvalidRequestError('subject_token is required');
		}

		if (
			body.subject_token_type !== subjectTokenTypeIdToken &&
			body.subject_token_type !== subjectTokenTypeJwt
		) {
			throw new InvalidRequestError(
				`Unsupported subject_token_type: ${String(body.subject_token_type)}`
			);
		}

		// Matching routes the token to a rule on its unverified claims; the
		// signature is then checked against that rule's issuer JWKS before any
		// cupboard token is minted, so a forged claim cannot earn a scope.
		const claims = this.oidcTrust.decodeInbound(body.subject_token);
		const rule = matchOidcTrust(this.oidcTrust.enabledOidcTrustRules(), claims);

		if (rule === undefined) {
			throw new InvalidGrantError('No trust rule matches the subject token');
		}

		const verified = await this.oidcTrust.verifyInbound(
			rule,
			body.subject_token
		);
		const subject =
			typeof verified.sub === 'string' && verified.sub !== ''
				? verified.sub
				: rule.id;

		return this.mintedResponse(rule, subject, {
			issued_token_type: issuedAccessTokenType
		});
	}

	private async refresh(body: ParsedTokenRequest): Promise<Response> {
		if (body.refresh_token === undefined) {
			throw new InvalidRequestError('refresh_token is required');
		}

		const presented = parseRefreshToken(body.refresh_token);

		if (presented === undefined) {
			throw new InvalidGrantError(staleRefreshTokenMessage);
		}

		const row = this.context.db
			.select()
			.from(schema.refreshTokens)
			.where(eq(schema.refreshTokens.id, presented.id))
			.get();

		if (row === undefined) {
			throw new InvalidGrantError(staleRefreshTokenMessage);
		}

		if (row.secretHash !== (await sha256Hex(presented.secret))) {
			throw new InvalidGrantError(staleRefreshTokenMessage);
		}

		// An expired or orphaned row is reclaimed on touch; the GC sweep catches
		// the ones nobody presents again.
		if (row.expiresAt <= new Date().toISOString()) {
			this.deleteRefreshToken(row.id);
			throw new InvalidGrantError(staleRefreshTokenMessage);
		}

		const rule = this.oidcTrust
			.enabledOidcTrustRules()
			.find((candidate) => candidate.id === row.ruleId);

		if (rule === undefined) {
			this.deleteRefreshToken(row.id);
			throw new InvalidGrantError(staleRefreshTokenMessage);
		}

		this.deleteRefreshToken(row.id);

		return this.mintedResponse(rule, row.subject, {});
	}

	// Mints the access token (and, for an admin session, a successor refresh
	// token) for a rule, reading the rule's current scope and roots so a
	// refreshed session never outlives an edit to its rule.
	private async mintedResponse(
		rule: OidcTrustRule,
		subject: string,
		extra: Pick<TokenResponse, 'issued_token_type'>
	): Promise<Response> {
		const ttlSeconds =
			rule.scope === 'admin' ? adminJwtTtlSeconds : writeJwtTtlSeconds;
		const accessToken = await this.mintRuleToken(rule, subject, ttlSeconds);

		// Only an admin session gets a refresh token: a write exchange (CI)
		// federates a fresh subject token per run, so a stored grant would only
		// accumulate rows.
		const refreshToken =
			rule.scope === 'admin'
				? await this.issueRefreshToken(rule.id, subject)
				: undefined;

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: ttlSeconds,
				scope: rule.scope,
				...extra,
				...(refreshToken === undefined ? {} : { refresh_token: refreshToken })
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

	private deleteRefreshToken(id: string): void {
		this.context.db
			.delete(schema.refreshTokens)
			.where(eq(schema.refreshTokens.id, id))
			.run();
	}

	private async mintRuleToken(
		rule: OidcTrustRule,
		subject: string,
		ttlSeconds: number
	): Promise<string> {
		const key = await this.authKeys.activeAuthKey();

		// A write token is pinned to the rule's roots via `cb_roots`; an admin
		// token is unconstrained. The rule id rides along as an audit breadcrumb.
		return mintAccessJwt(
			key.privateJwk,
			{
				issuer: this.authKeys.authIssuer(),
				audience: this.authKeys.authAudience(),
				subject,
				scope: rule.scope,
				kid: key.kid,
				ttlSeconds,
				cbRoots: rule.scope === 'write' ? rule.allowedRoots : undefined,
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
