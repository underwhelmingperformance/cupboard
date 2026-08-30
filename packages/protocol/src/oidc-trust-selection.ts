import { type AuthorizationDetails } from './grants.ts';
import {
	type OidcTrustRule,
	type VerifiedOidcClaims
} from './oidc-trust-match.ts';
import { evaluateOidcTrust } from './oidc-trust-selection-internal.ts';

export type OidcTrustSelection =
	| { readonly outcome: 'selected'; readonly rule: OidcTrustRule }
	| { readonly outcome: 'identity-unmatched' }
	| {
			readonly outcome: 'authority-unmatched';
			readonly rules: readonly [OidcTrustRule, ...OidcTrustRule[]];
			/**
			 * The requested details that no rule in the tier permits. Empty when
			 * every detail is permitted by some rule but no single rule permits
			 * the complete request.
			 */
			readonly uncovered: AuthorizationDetails;
	  }
	| {
			readonly outcome: 'ambiguous';
			readonly rules: readonly [OidcTrustRule, ...OidcTrustRule[]];
	  };

/**
 * Selects one trust rule for an external token exchange. Identity precedence is
 * resolved before authority, so a broader identity rule cannot bypass a more
 * specific restriction. Requested grants distinguish tied identity rules only
 * when exactly one rule permits the complete request. Grants are never
 * combined across rules.
 *
 * Only OIDC verification can produce `VerifiedOidcClaims`. Selection chooses a
 * policy rule but does not grant access; the token-exchange service must still
 * resolve the request against that rule before creating a token.
 */
export function selectOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: VerifiedOidcClaims,
	requested: AuthorizationDetails | undefined
): OidcTrustSelection {
	return evaluateOidcTrust(rules, claims, requested);
}
