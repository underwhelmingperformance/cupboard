import {
	issuedAccessTokenType,
	subjectTokenTypeIdToken,
	subjectTokenTypeJwt,
	tokenExchangeGrantType,
	tokenExchangeRequestSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';

import {
	adminJwtTtlSeconds,
	mintAccessJwt,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
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

export class TokenExchangeService {
	constructor(
		private readonly context: ServerContext,
		private readonly authKeys: AuthKeysService,
		private readonly oidcTrust: OidcTrustService
	) {}

	async handleToken(request: Request): Promise<Response> {
		const body = await parseFormBody(tokenExchangeRequestSchema, request);

		if (body.grant_type !== tokenExchangeGrantType) {
			throw new UnsupportedGrantTypeError(body.grant_type);
		}

		if (
			body.subject_token_type !== subjectTokenTypeIdToken &&
			body.subject_token_type !== subjectTokenTypeJwt
		) {
			throw new InvalidRequestError(
				`Unsupported subject_token_type: ${body.subject_token_type}`
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
		const ttlSeconds =
			rule.scope === 'admin' ? adminJwtTtlSeconds : writeJwtTtlSeconds;
		const accessToken = await this.mintRuleToken(rule, subject, ttlSeconds);

		return Response.json(
			{
				access_token: accessToken,
				token_type: 'Bearer',
				expires_in: ttlSeconds,
				scope: rule.scope,
				issued_token_type: issuedAccessTokenType
			} satisfies TokenResponse,
			{ headers: { 'cache-control': 'no-store' } }
		);
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
