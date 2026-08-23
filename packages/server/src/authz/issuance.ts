import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema,
	isAuthorizationDetailCovered
} from '@cupboard/protocol/grants';
import {
	isRuleInteractive,
	type OidcClaims,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';

import {
	AuthorizationDetailsRequiredError,
	InvalidAuthorizationDetailsError
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
	claims: OidcClaims,
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

	for (const detail of requested) {
		if (!isGrantPermittedByRule(rule.permittedGrants, detail, claims)) {
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}
	}

	return requested;
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
