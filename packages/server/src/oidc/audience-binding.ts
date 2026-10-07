import { withoutTrailingSlashes } from '@cupboard/nix-store/url';
import { type OidcIssuer } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';

/**
 * Whether a verified subject token has `target` as an audience, after trailing
 * slashes are removed from each audience as `canonicalHref` removes them. A
 * GitHub Actions job requests such a token, with the tenant or deployment URL
 * as its audience.
 */
export function isAudienceBound(
	claims: VerifiedOidcClaims,
	target: OidcIssuer
): boolean {
	const audiences = claims.aud === undefined ? [] : [claims.aud].flat();

	return audiences.some(
		(audience) => withoutTrailingSlashes(audience) === target
	);
}
