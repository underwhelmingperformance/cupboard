import { type AuthKeyId, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import { resolveGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema,
	isAuthorizationDetailCovered
} from '@cupboard/protocol/grants';
import {
	issuedAccessTokenType,
	type OidcAudience,
	type OidcIssuer,
	type TokenResponseInput
} from '@cupboard/protocol/oidc';
import {
	isRuleInteractive,
	type OidcTrustRule,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';

import {
	type AccessClaims,
	issueAccessJwt,
	writeJwtTtlSeconds
} from '../auth/auth.ts';
import {
	AuthorizationDetailsRequiredError,
	InvalidAuthorizationDetailsError,
	SubjectTokenVerificationFailedError
} from '../errors.ts';

/**
 * Parses a non-empty `authorization_details` form value. The request schema
 * leaves it JSON-encoded so invalid JSON or an invalid grant array is reported
 * as `invalid_authorization_details`. An omitted value remains undefined; an
 * empty form value is rejected earlier as `invalid_request`.
 */
export function parseRequestedGrants(
	raw: string | undefined
): AuthorizationDetails | undefined {
	if (raw === undefined) {
		return undefined;
	}

	let value: unknown;

	try {
		value = JSON.parse(raw);
	} catch {
		throw new InvalidAuthorizationDetailsError('malformed');
	}

	const result = authorizationDetailsSchema.safeParse(value);

	if (!result.success) {
		throw new InvalidAuthorizationDetailsError('malformed');
	}

	if (result.data.length === 0) {
		throw new InvalidAuthorizationDetailsError('empty');
	}

	return result.data;
}

/**
 * Resolves grants against the matched rule and verified claims. A rule that
 * permits wildcard authority may omit `authorization_details` and receive that
 * wildcard. Every other rule must request explicit grants; omission is
 * `invalid_request`. An empty request or any unpermitted grant rejects the whole
 * request as `invalid_authorization_details`; no partial subset is returned.
 */
export function resolveRequestedGrants(
	rule: OidcTrustRule,
	claims: VerifiedOidcClaims,
	requested: AuthorizationDetails | undefined
): AuthorizationDetails {
	if (requested === undefined) {
		if (isRuleInteractive(rule)) {
			return [{ type: 'cupboard_wildcard' }];
		}

		throw new AuthorizationDetailsRequiredError();
	}

	if (requested.length === 0) {
		throw new InvalidAuthorizationDetailsError('empty');
	}

	const resolved: AuthorizationDetails = [];

	for (const detail of requested) {
		const permitted = resolveGrantPermittedByRule(
			rule.permittedGrants,
			detail,
			claims
		);

		if (permitted === undefined) {
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}

		resolved.push(permitted);
	}

	return resolved;
}

/**
 * Omitting `authorization_details` preserves the presented grants. An empty
 * request or any grant outside the presented authority rejects the whole
 * exchange. A successful result cannot authorise an operation or resource that
 * the presented token did not authorise.
 */
export function attenuatedGrants(
	presented: AuthorizationDetails,
	requested: AuthorizationDetails | undefined
): AuthorizationDetails {
	if (requested === undefined) {
		return presented;
	}

	if (requested.length === 0) {
		throw new InvalidAuthorizationDetailsError('empty');
	}

	for (const detail of requested) {
		if (!isAuthorizationDetailCovered(presented, detail)) {
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}
	}

	return requested;
}

interface AttenuatedAccessTokenOptions {
	readonly privateJwk: JsonWebKey;
	readonly kid: AuthKeyId;
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
	readonly presented: AccessClaims;
	readonly requested: AuthorizationDetails | undefined;
}

/**
 * Issues a self-attenuated access token without extending the lifetime of the
 * presented token. The issuer refuses a token whose remaining lifetime is not
 * positive, including one accepted only because of verification tolerance.
 */
export async function issueAttenuatedAccessToken(
	options: AttenuatedAccessTokenOptions,
	now: Date
): Promise<TokenResponseInput> {
	const granted = attenuatedGrants(options.presented.grants, options.requested);
	const issuedAtSeconds = Math.floor(now.getTime() / 1000);
	const presentedExpirySeconds = Math.floor(
		options.presented.expiresAt.getTime() / 1000
	);
	const ttlResult = ttlSecondsSchema.safeParse(
		Math.min(writeJwtTtlSeconds, presentedExpirySeconds - issuedAtSeconds)
	);

	if (!ttlResult.success) {
		throw new SubjectTokenVerificationFailedError();
	}

	const accessToken = await issueAccessJwt(
		options.privateJwk,
		{
			issuer: options.issuer,
			audience: options.audience,
			subject: options.presented.subject,
			grants: granted,
			principal: options.presented.principal,
			kid: options.kid,
			ttlSeconds: ttlResult.data
		},
		now
	);

	return {
		access_token: accessToken,
		token_type: 'Bearer',
		expires_in: ttlResult.data,
		issued_token_type: issuedAccessTokenType,
		authorization_details: granted
	};
}
