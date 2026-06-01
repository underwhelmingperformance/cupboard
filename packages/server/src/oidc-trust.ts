import { IssuerUrl, type OidcTrustScope } from '@cupboard/shared';

// A trust rule reduced to what matching needs. The DO reads enabled rows from
// `oidc_trust`, parses `claims_json`/`allowed_roots_json`, and passes them here;
// disabled rows are filtered out before matching.
export interface OidcTrustRule {
	readonly id: string;
	readonly issuer: string;
	readonly jwksUrl: string;
	readonly audience: string;
	readonly scope: OidcTrustScope;
	readonly claims: Readonly<Record<string, string>>;
	readonly allowedRoots: readonly string[];
}

// The verified claims of an inbound OIDC token, as far as matching reads them.
// Structurally a superset of `jose`'s `JWTPayload`, so a verified payload is
// passed straight in.
export interface OidcClaims {
	readonly iss?: string;
	readonly aud?: string | readonly string[];
	readonly [claim: string]: unknown;
}

// The rule's issuer is normalised at ingress; the token's `iss` is normalised
// the same way before comparison, so a trailing slash on either side does not
// stop a genuine match. A non-URL `iss` normalises to nothing and never matches.
function issuerMatches(rule: OidcTrustRule, claims: OidcClaims): boolean {
	return (
		typeof claims.iss === 'string' &&
		IssuerUrl.parse(claims.iss)?.value === rule.issuer
	);
}

function audienceMatches(rule: OidcTrustRule, claims: OidcClaims): boolean {
	const { aud } = claims;

	return typeof aud === 'string'
		? aud === rule.audience
		: Array.isArray(aud) && aud.includes(rule.audience);
}

// Every configured claim must be present and exactly equal — strings only, so a
// numeric or structured claim never satisfies a configured value by coincidence.
function claimsMatch(rule: OidcTrustRule, claims: OidcClaims): boolean {
	return Object.entries(rule.claims).every(
		([name, expected]) => claims[name] === expected
	);
}

// More pinned claims is a tighter rule, so it wins over a looser one for the
// same issuer.
function specificity(rule: OidcTrustRule): number {
	return Object.keys(rule.claims).length;
}

// The owner's `admin` rule outranks any matching `write` rule. The single admin
// rule pins the owner's identity, so only the owner's token can match it; a write
// rule that also matches that token (even a more specific one) must never
// downgrade the owner to `write`. A CI token cannot match the admin rule, so this
// never grants a write identity more than it asked for.
function scopeRank(rule: OidcTrustRule): number {
	return rule.scope === 'admin' ? 1 : 0;
}

/**
 * The trust rule whose issuer, audience and configured claims all match the
 * verified token, or `undefined` when none does. Selection prefers `admin` over
 * `write` (so the owner is never downgraded), then the most specific rule, then
 * the lowest id, so the choice is deterministic regardless of the order the rows
 * arrive in. Matching never substitutes for verification: the caller must already
 * have checked the token's signature, issuer, audience and expiry with `jose`.
 */
export function matchOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims
): OidcTrustRule | undefined {
	return rules
		.filter(
			(rule) =>
				issuerMatches(rule, claims) &&
				audienceMatches(rule, claims) &&
				claimsMatch(rule, claims)
		)
		.toSorted(
			(left, right) =>
				scopeRank(right) - scopeRank(left) ||
				specificity(right) - specificity(left) ||
				left.id.localeCompare(right.id)
		)
		.at(0);
}
