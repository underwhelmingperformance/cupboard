import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from './grants.ts';
import { type TrustRuleId } from './oidc.ts';
import {
	type OidcTrustRule,
	type VerifiedOidcClaims
} from './oidc-trust-match.ts';
import { evaluateOidcTrust } from './oidc-trust-selection-internal.ts';

/**
Records one rule that permits the whole request, or the contributing rule IDs
when the requested actions need more than one rule.
*/
export type SelectedOidcAuthority =
	| { readonly rule: OidcTrustRule }
	| { readonly rule?: undefined; readonly ruleIds: readonly TrustRuleId[] };

export type OidcTrustSelection =
	| (SelectedOidcAuthority & {
			readonly outcome: 'selected';
			readonly grants?: AuthorizationDetails;
	  })
	| { readonly outcome: 'identity-unmatched' }
	| {
			readonly outcome: 'authority-unmatched';
			readonly rules: readonly [OidcTrustRule, ...OidcTrustRule[]];
			readonly uncovered: readonly [
				AuthorizationDetail,
				...AuthorizationDetail[]
			];
	  }
	| {
			readonly outcome: 'ambiguous';
			readonly rules: readonly [OidcTrustRule, ...OidcTrustRule[]];
	  };

/**
Composes exact requested authority within the preferred verified identity
tier. An omitted request retains single-rule selection for implicit authority.
The issuer must re-evaluate current policy after asynchronous work.
*/
export function selectOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: VerifiedOidcClaims,
	requested: AuthorizationDetails | undefined
): OidcTrustSelection {
	return evaluateOidcTrust(rules, claims, requested);
}
