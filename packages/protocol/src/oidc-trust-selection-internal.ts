import { type AuthorizationDetails } from './grants.ts';
import { composeOidcGrants } from './oidc-grant-composition.ts';
import {
	type OidcClaims,
	type OidcTrustRule,
	preferredModelledOidcTrustRules
} from './oidc-trust-match.ts';
import { type OidcTrustSelection } from './oidc-trust-selection.ts';

function hasExactlyOne<T>(values: readonly T[]): values is readonly [T] {
	return values.length === 1;
}

function isNonEmpty<T>(values: readonly T[]): values is readonly [T, ...T[]] {
	return values.length > 0;
}

export function evaluateOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	requested: AuthorizationDetails | undefined
): OidcTrustSelection {
	const preferred = preferredModelledOidcTrustRules(rules, claims);

	if (!isNonEmpty(preferred)) {
		return { outcome: 'identity-unmatched' };
	}

	if (requested === undefined || requested.length === 0) {
		if (hasExactlyOne(preferred)) {
			return { outcome: 'selected', rule: preferred[0] };
		}

		return { outcome: 'ambiguous', rules: preferred };
	}

	return composeOidcGrants(
		rules,
		claims,
		requested.map((detail) => ({ alternatives: [detail] }))
	);
}
