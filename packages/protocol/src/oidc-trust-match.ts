import { isPatternMatch } from './capture.ts';
import { type OidcTrustDisplay, type PermittedGrant } from './grants.ts';
import { type ClaimMatch } from './oidc.ts';
import { IssuerUrl } from './oidc-issuer.ts';

// A trust rule reduced to what matching and issuance need. The DO reads enabled
// rows from `oidc_trust`, parses `claims_json`/`permitted_grants_json`, and
// passes them here; disabled rows are filtered out before matching.
export interface OidcTrustRule {
	readonly id: string;
	readonly issuer: string;
	readonly audience: string;
	readonly claims: Readonly<Record<string, ClaimMatch>>;
	readonly permittedGrants: readonly PermittedGrant[];
	readonly display?: OidcTrustDisplay;
}

// A rule that permits a wildcard is the interactive owner/admin trust class: an
// exchange may omit `authorization_details` and receive the wildcard, and the
// session carries a refresh token. Every other rule is claim-bound (CI) and must
// request the concrete grants it wants.
export function isRuleInteractive(rule: OidcTrustRule): boolean {
	return rule.permittedGrants.some(
		(grant) => grant.type === 'cupboard_wildcard'
	);
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
function hasMatchingIssuer(rule: OidcTrustRule, claims: OidcClaims): boolean {
	return (
		typeof claims.iss === 'string' &&
		IssuerUrl.parse(claims.iss)?.value === rule.issuer
	);
}

function hasMatchingAudience(rule: OidcTrustRule, claims: OidcClaims): boolean {
	const { aud } = claims;

	return typeof aud === 'string'
		? aud === rule.audience
		: Array.isArray(aud) && aud.includes(rule.audience);
}

// A configured claim is satisfied only by a string claim matching its exact
// value or pattern, so a numeric or structured claim never satisfies a
// configured value by coincidence.
function isClaimSatisfied(expected: ClaimMatch, actual: unknown): boolean {
	if (typeof actual !== 'string') {
		return false;
	}

	return typeof expected === 'string'
		? actual === expected
		: isPatternMatch(expected.pattern, actual);
}

function hasMatchingClaims(rule: OidcTrustRule, claims: OidcClaims): boolean {
	return Object.entries(rule.claims).every(([name, expected]) =>
		isClaimSatisfied(expected, claims[name])
	);
}

// More pinned claims is a tighter rule, so it wins over a looser one for the
// same issuer.
function specificity(rule: OidcTrustRule): number {
	return Object.keys(rule.claims).length;
}

// The owner's interactive rule outranks any matching CI rule. The owner rule
// pins the owner's identity, so only the owner's token can match it; a CI rule
// that also matches that token (even a more specific one) must never displace it
// and downgrade the owner. A CI token cannot match the owner rule, so this never
// grants a CI identity more than it asked for.
function interactiveRank(rule: OidcTrustRule): number {
	return isRuleInteractive(rule) ? 1 : 0;
}

/**
 * The trust rule whose issuer, audience and configured claims all match the
 * verified token, or `undefined` when none does. Selection prefers the
 * interactive owner rule (so the owner is never downgraded), then the most
 * specific rule, then the lowest id, so the choice is deterministic regardless
 * of the order the rows arrive in. Matching never substitutes for verification:
 * the caller must already have checked the token's signature, issuer, audience
 * and expiry with `jose`.
 */
export function matchOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims
): OidcTrustRule | undefined {
	return rules
		.filter(
			(rule) =>
				hasMatchingIssuer(rule, claims) &&
				hasMatchingAudience(rule, claims) &&
				hasMatchingClaims(rule, claims)
		)
		.toSorted(
			(left, right) =>
				interactiveRank(right) - interactiveRank(left) ||
				specificity(right) - specificity(left) ||
				left.id.localeCompare(right.id)
		)
		.at(0);
}

// One configured claim a token failed to satisfy: the claim's name, the
// configured expectation (a pattern in its `pattern:` form), and the token's
// value when it carried a string one.
export interface ClaimMismatch {
	readonly claim: string;
	readonly expected: string;
	readonly presented?: string;
}

/**
 * Every configured claim of `rule` that `claims` does not satisfy, in
 * claim-name order so the report is deterministic; empty when every
 * configured claim matches. Issuer and audience are compared during matching
 * and verification, not here, so a mismatch always names a configured claim.
 */
export function claimMismatches(
	rule: OidcTrustRule,
	claims: OidcClaims
): ClaimMismatch[] {
	return Object.entries(rule.claims)
		.toSorted(([left], [right]) => left.localeCompare(right))
		.filter(([name, expected]) => !isClaimSatisfied(expected, claims[name]))
		.map(([name, expected]) => {
			const presented = claims[name];

			return {
				claim: name,
				expected:
					typeof expected === 'string'
						? expected
						: `pattern:${expected.pattern}`,
				...(typeof presented === 'string' && { presented })
			};
		});
}

/** The first entry of {@link claimMismatches}, for a single-claim report. */
export function firstClaimMismatch(
	rule: OidcTrustRule,
	claims: OidcClaims
): ClaimMismatch | undefined {
	return claimMismatches(rule, claims).at(0);
}
