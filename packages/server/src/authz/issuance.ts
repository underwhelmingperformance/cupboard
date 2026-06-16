import { type AuthorizationDetails } from '@cupboard/protocol/grants';

import {
	AuthorizationDetailsRequiredError,
	InvalidAuthorizationDetailsError
} from '../errors.ts';
import {
	type OidcClaims,
	type OidcTrustRule,
	ruleIsInteractive
} from '../oidc/oidc-trust.ts';

import { rulePermitsGrant } from './bindings.ts';

/**
 * The grants a token request earns from its matched rule and verified claims.
 *
 * The interactive owner/admin class (a rule that permits a wildcard) may omit
 * `authorization_details` and receive its wildcard. A claim-bound rule must name
 * the grants it wants, so the token endpoint never reconstructs authority from
 * claims; an omitted request is `invalid_request`. Every requested detail is
 * verified against the rule's bindings before any is issued: an empty array or
 * an unpermitted detail rejects the whole request with
 * `invalid_authorization_details`, never a silent narrowing.
 */
export function resolveRequestedGrants(
	rule: OidcTrustRule,
	claims: OidcClaims,
	requested: AuthorizationDetails | undefined
): AuthorizationDetails {
	if (requested === undefined) {
		if (ruleIsInteractive(rule)) {
			return [{ type: 'cupboard_wildcard' }];
		}

		throw new AuthorizationDetailsRequiredError();
	}

	if (requested.length === 0) {
		throw new InvalidAuthorizationDetailsError('empty');
	}

	for (const detail of requested) {
		if (!rulePermitsGrant(rule.permittedGrants, detail, claims)) {
			throw new InvalidAuthorizationDetailsError('not-permitted');
		}
	}

	return requested;
}
