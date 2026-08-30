import { isGrantPermittedByRule } from './grant-match.ts';
import { type AuthorizationDetails } from './grants.ts';
import {
	type OidcClaims,
	type OidcTrustRule,
	preferredModelledOidcTrustRules
} from './oidc-trust-match.ts';
import { type OidcTrustSelection } from './oidc-trust-selection.ts';

function isEveryRequestedGrantPermittedByRule(
	rule: OidcTrustRule,
	claims: OidcClaims,
	requested: AuthorizationDetails
): boolean {
	return requested.every((detail) =>
		isGrantPermittedByRule(rule.permittedGrants, detail, claims)
	);
}

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

	const permitted = preferred.filter((rule) =>
		isEveryRequestedGrantPermittedByRule(rule, claims, requested)
	);

	if (!isNonEmpty(permitted)) {
		const uncovered = requested.filter((detail) =>
			preferred.every(
				(rule) => !isGrantPermittedByRule(rule.permittedGrants, detail, claims)
			)
		);

		return { outcome: 'authority-unmatched', rules: preferred, uncovered };
	}

	if (hasExactlyOne(permitted)) {
		return { outcome: 'selected', rule: permitted[0] };
	}

	return { outcome: 'ambiguous', rules: permitted };
}
