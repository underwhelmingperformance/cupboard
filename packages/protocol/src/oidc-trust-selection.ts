import {
	type AuthorizationDetail,
	type AuthorizationDetails
} from './grants.ts';
import {
	type OidcTrustRule,
	type VerifiedOidcClaims
} from './oidc-trust-match.ts';
import { evaluateOidcTrust } from './oidc-trust-selection-internal.ts';

export type OidcTrustSelection =
	| {
			readonly outcome: 'selected';
			readonly rule?: OidcTrustRule;
			readonly grants?: AuthorizationDetails;
	  }
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
 * Composes exact requested authority within the preferred verified identity
 * tier. An omitted request retains single-rule selection for implicit authority.
 * The issuer must re-evaluate current policy after asynchronous work.
 */
export function selectOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: VerifiedOidcClaims,
	requested: AuthorizationDetails | undefined
): OidcTrustSelection {
	return evaluateOidcTrust(rules, claims, requested);
}
