import { canonicalHref, withoutTrailingSlashes } from '@cupboard/nix-store/url';
import {
	isClaimSatisfied,
	type OidcTrustRule
} from '@cupboard/protocol/oidc-trust-match';
import { type Reporter } from '@cupboard/reporter';

import { type RepositoryIdentity } from '../oidc-trust/github.ts';

import { githubActionsIssuer } from './claims.ts';

/**
 * A tenant accepts a job token only when its audience is the tenant URL. A job
 * cannot request a token with a target-bound nonce.
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
				'The tenant refuses the tokens of jobs that request this audience, because a job token cannot have a target-bound nonce. ' +
				"To keep these jobs working, set the rule's audience and the audience input or --audience option of each job that uses the rule " +
				`to ${tenantUrl}.`
		);
	}
}
