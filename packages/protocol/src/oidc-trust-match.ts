import { isPatternMatch } from './capture.ts';
import { type OidcTrustDisplay, type PermittedGrant } from './grants.ts';
import {
	type ClaimMatch,
	type OidcAudience,
	type OidcIssuer,
	type TrustRuleId
} from './oidc.ts';
import { IssuerUrl } from './oidc-issuer.ts';

export interface OidcTrustRule {
	readonly id: TrustRuleId;
	readonly issuer: OidcIssuer;
	readonly audience: OidcAudience;
	readonly claims: Readonly<Record<string, ClaimMatch>>;
	readonly permittedGrants: readonly PermittedGrant[];
	readonly display?: OidcTrustDisplay;
}

// A rule that permits a wildcard is interactive. Its exchange may omit
// `authorization_details` and receive the wildcard. Tenant exchanges for these
// rules also receive a refresh token. The rule id does not affect this
// classification.
export function isRuleInteractive(rule: OidcTrustRule): boolean {
	return rule.permittedGrants.some(
		(grant) => grant.type === 'cupboard_wildcard'
	);
}

export interface OidcClaims {
	readonly iss?: string;
	readonly aud?: string | readonly string[];
	readonly [claim: string]: unknown;
}

// Issuer identifiers use the exact, case-sensitive value configured at ingress.
// A malformed `iss` fails validation and never matches.
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
export function isClaimSatisfied(
	expected: ClaimMatch,
	actual: unknown
): boolean {
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

function specificity(rule: OidcTrustRule): number {
	return Object.keys(rule.claims).length;
}

function interactiveRank(rule: OidcTrustRule): number {
	return isRuleInteractive(rule) ? 1 : 0;
}

/**
 * The trust rule whose issuer, audience and configured claims all match the
 * verified token, or `undefined` when none does. Selection prefers the
 * interactive owner rule (so the owner is never downgraded), then the most
 * specific rule. Selection rejects two matches with the same rank and
 * specificity because a generated rule ID cannot decide which authority the
 * token receives. Matching never substitutes for verification: the caller must
 * already have checked the token's signature, issuer, audience and expiry with
 * `jose`.
 */
export function matchOidcTrust(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims
): OidcTrustRule | undefined {
	const matches = rules
		.filter(
			(rule) =>
				hasMatchingIssuer(rule, claims) &&
				hasMatchingAudience(rule, claims) &&
				hasMatchingClaims(rule, claims)
		)
		.toSorted(
			(left, right) =>
				interactiveRank(right) - interactiveRank(left) ||
				specificity(right) - specificity(left)
		);
	const selected = matches[0];
	const competing = matches[1];

	if (
		selected !== undefined &&
		competing !== undefined &&
		interactiveRank(selected) === interactiveRank(competing) &&
		specificity(selected) === specificity(competing)
	) {
		return undefined;
	}

	return selected;
}

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

export function firstClaimMismatch(
	rule: OidcTrustRule,
	claims: OidcClaims
): ClaimMismatch | undefined {
	return claimMismatches(rule, claims).at(0);
}
