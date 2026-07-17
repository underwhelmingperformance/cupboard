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

import { isGrantPermittedByRule } from './bindings.ts';

/**
 * Parse the `authorization_details` form field a client sent. It is carried as
 * an opaque JSON string so that a non-JSON or malformed value is the token
 * endpoint's `invalid_authorization_details`, not the body validator's
 * `invalid_request`. Absent, returns undefined.
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
 * The grants an attenuation earns: a requested subset of what the presented
 * self-issued token already carries, never a superset. Omitting
 * `authorization_details` reissues the presented grants unchanged; a request is
 * verified against them detail by detail, all-or-nothing, so a narrowed token
 * can never reach a resource the presenter could not.
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
