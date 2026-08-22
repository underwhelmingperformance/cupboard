import { type TtlSeconds } from '@cupboard/nix-store/scalars';
import { type AuthorizationDetails } from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	type OidcSubject,
	oidcSubjectSchema,
	type ParsedTokenRequest,
	refreshTokenGrantType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenRequestSchema,
	type TokenResponse,
	type TrustRuleId
} from '@cupboard/protocol/oidc';
import {
	firstClaimMismatch,
	isRuleInteractive,
	matchOidcTrust,
	type OidcClaims,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { isoTimestamp } from '@cupboard/protocol/scalars';
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
	type SubjectTokenUntrustedError,
	SubjectTokenVerificationFailedError,
	TenantSubjectTokenClaimMismatchError,
	TenantSubjectTokenUntrustedError,
	UnsupportedGrantTypeError,
	UnsupportedSubjectTokenTypeError
} from '../errors.ts';
import { oauthJsonResponse } from '../http/oauth-response.ts';
import { parseFormBody } from '../http/parse.ts';

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

		// Verification with this tenant's keys selects attenuation. The declared
		// token type cannot force a self-issued token through external trust matching
		// or make an external token eligible for attenuation.
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

		// Decode the claims only to select a trust rule. Verify the token against that
		// rule's issuer, audience, and JWKS before resolving grants. Unverified claims
		// cannot authorise the exchange.
		const claims = this.oidcTrust.decodeInbound(body.subject_token);
		const rule = matchOidcTrust(this.oidcTrust.enabledOidcTrustRules(), claims);

		if (rule === undefined) {
			throw await this.untrustedRefusal(
				claims,
				body.subject_token,
				body.subject_token_type === subjectTokenTypeIdToken
			);
		}

		const requiresIdTokenClaims =
			body.subject_token_type === subjectTokenTypeIdToken;
		const verified = await this.oidcTrust.verifyInbound(
			rule,
			body.subject_token,
			requiresIdTokenClaims
		);
		const verifiedSubject =
			typeof verified.sub === 'string' && verified.sub !== ''
				? verified.sub
				: undefined;

		if (requiresIdTokenClaims && verifiedSubject === undefined) {
			throw new SubjectTokenVerificationFailedError();
		}

		const subject = oidcSubjectSchema.parse(verifiedSubject ?? rule.id);

		return this.issuedResponse(
			rule,
			subject,
			verified,
			parseRequestedGrants(body.authorization_details),
			{ issued_token_type: issuedAccessTokenType }
		);
	}

	// Return a generic refusal unless both claimed repository IDs exactly match an
	// enabled rule and the token passes signature, issuer, and audience verification
	// for that rule. The caller then receives the first binding mismatch. This
	// allows a caller from that repository to diagnose stale branch or workflow
	// claims. Forged tokens and tokens from other repositories receive no details
	// about the rule.
	private async untrustedRefusal(
		claims: OidcClaims,
		subjectToken: string,
		requiresIdTokenClaims: boolean
	): Promise<SubjectTokenUntrustedError> {
		const candidate = this.repositoryPinnedCandidate(claims);

		if (candidate === undefined) {
			return new TenantSubjectTokenUntrustedError();
		}

		let verified: OidcClaims;
		try {
			verified = await this.oidcTrust.verifyInbound(
				candidate,
				subjectToken,
				requiresIdTokenClaims
			);
		} catch {
			// Collapse signature failures and issuer outages to the same generic
			// refusal. Neither failure can expose a claim value. Candidate verification
			// adds latency, so callers can infer whether the claimed repository IDs
			// selected a rule. PLAN.md records this diagnostic timing leak as accepted.
			return new TenantSubjectTokenUntrustedError();
		}

		const mismatch = firstClaimMismatch(candidate, verified);

		if (mismatch === undefined) {
			return new TenantSubjectTokenUntrustedError();
		}

		return new TenantSubjectTokenClaimMismatchError(candidate.id, mismatch);
	}

	// Prefer the rule with more claim bindings so a broad repository rule cannot
	// hide a narrower branch or workflow mismatch. Rule IDs make ties deterministic.
	private repositoryPinnedCandidate(
		claims: OidcClaims
	): OidcTrustRule | undefined {
		const pins = ['repository_id', 'repository_owner_id'];

		return this.oidcTrust
			.enabledOidcTrustRules()
			.filter((rule) =>
				pins.every((name) => {
					const expected = rule.claims[name];

					return typeof expected === 'string' && expected === claims[name];
				})
			)
			.toSorted(
				(left, right) =>
					Object.keys(right.claims).length - Object.keys(left.claims).length ||
					left.id.localeCompare(right.id)
			)
			.at(0);
	}

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

	// Attenuation creates no refresh token because the presented token already
	// authenticates an existing session.
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

		return oauthJsonResponse({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: writeJwtTtlSeconds,
			issued_token_type: issuedAccessTokenType,
			authorization_details: granted
		} satisfies TokenResponse);
	}

	private async refresh(body: ParsedTokenRequest): Promise<Response> {
		if (body.refresh_token === undefined) {
			throw new RefreshTokenRequiredError();
		}

		const presented = parseRefreshToken(body.refresh_token);

		if (presented === undefined) {
			throw new StaleRefreshTokenError();
		}

		// Compute the hash before reading the row. This is the only await in the
		// consume path. The synchronous lookup and conditional delete then run without
		// yielding the Durable Object's input gate, so concurrent presentations cannot
		// both consume the same refresh token.
		const presentedHash = await sha256Hex(presented.secret);

		const row = this.context.db
			.select()
			.from(schema.refreshTokens)
			.where(eq(schema.refreshTokens.id, presented.id))
			.get();

		if (
			row === undefined ||
			!(await isConstantTimeEqual(row.secretHash, presentedHash, 64))
		) {
			throw new StaleRefreshTokenError();
		}

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

		const nowIso = isoTimestamp(new Date());

		if (claimed === undefined || claimed.expiresAt <= nowIso) {
			throw new StaleRefreshTokenError();
		}

		const rule = this.oidcTrust
			.enabledOidcTrustRules()
			.find((candidate) => candidate.id === claimed.ruleId);

		// The refresh token has already been consumed. If its rule is now absent or
		// disabled, end the session without issuing a successor.
		if (rule === undefined) {
			throw new StaleRefreshTokenError();
		}

		// Refresh tokens originate only from interactive rules. Resolve any requested
		// narrowing against the rule again before issuing the next session.
		return this.issuedResponse(
			rule,
			claimed.subject,
			{},
			parseRequestedGrants(body.authorization_details),
			{}
		);
	}

	private async issuedResponse(
		rule: OidcTrustRule,
		subject: OidcSubject,
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

		// Issue refresh tokens only for interactive rules. CI exchanges authenticate
		// each run with a fresh external subject token. A refresh token would turn one
		// federated CI exchange into a persistent session.
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
		ruleId: TrustRuleId,
		subject: OidcSubject
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
				createdAt: isoTimestamp(now),
				expiresAt: isoTimestamp(expiresAt)
			})
			.run();

		return `${id}.${secret}`;
	}

	private async issueRuleToken(
		rule: OidcTrustRule,
		subject: OidcSubject,
		grants: AuthorizationDetails,
		ttlSeconds: TtlSeconds
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
