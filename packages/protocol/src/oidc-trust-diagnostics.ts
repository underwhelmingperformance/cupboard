import { type AuthorizationDetails } from './grants.ts';
import { type OidcClaims, type OidcTrustRule } from './oidc-trust-match.ts';
import { type OidcTrustSelection } from './oidc-trust-selection.ts';
import { evaluateOidcTrust } from './oidc-trust-selection-internal.ts';

/**
 * Models trust selection without issuing authority.
 */
export function selectModelledOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	requested: AuthorizationDetails | undefined
): OidcTrustSelection {
	return evaluateOidcTrust(rules, claims, requested);
}
