import { canonicalHref, withoutTrailingSlashes } from '@cupboard/nix-store/url';
import {
	isClaimSatisfied,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { type Reporter } from '@cupboard/reporter';

import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import { githubActionsIssuer } from './claims.ts';

/**
 * A job token whose audience is not the tenant URL is bound to the tenant only
 * by a nonce. A tenant that refuses unbound subject tokens refuses such a token
 * without one.
 */
function unboundAudienceRules(
	rules: readonly OidcTrustRule[],
	identity: RepositoryIdentity,
	tenant: URL
): OidcTrustRule[] {
	const tenantUrl = canonicalHref(tenant);
	const repositoryId = String(identity.repositoryId);

	return rules.filter(
		(rule) =>
			rule.issuer === githubActionsIssuer &&
			rule.claims.repository_id !== undefined &&
			isClaimSatisfied(rule.claims.repository_id, repositoryId) &&
			withoutTrailingSlashes(rule.audience) !== tenantUrl
	);
}

export function warnUnboundAudienceRules(
	reporter: Reporter,
	rules: readonly OidcTrustRule[],
	identity: RepositoryIdentity,
	tenant: URL
): void {
	const tenantUrl = canonicalHref(tenant);

	for (const rule of unboundAudienceRules(rules, identity, tenant)) {
		reporter.warn(
			`Trust rule ${rule.id} expects the audience ${rule.audience}, which is not the tenant URL. ` +
				'Jobs that request this audience without a target-bound nonce will fail if the tenant refuses unbound subject tokens. ' +
				"To keep these jobs working, set the rule's audience and the audience input or --audience option of each job that uses the rule " +
				`to ${tenantUrl}.`
		);
	}
}
