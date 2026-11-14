import { type Logger } from '@cupboard/logger';
import { type TenantId } from '@cupboard/nix-store/scalars';
import { isUnpinnedGithubRule } from '@cupboard/protocol/oidc';
import {
	hasMatchingOidcTrustIdentity,
	type OidcTrustRule,
	type VerifiedOidcClaims
} from '@cupboard/protocol/oidc-trust-match';

/**
The message of the warning that {@link warnUnpinnedGithubMatches} logs.
Operators search Workers Logs for it.
*/
export const unpinnedGithubRuleMatchedMessage =
	'OIDC trust rule without a repository pin matched';

/**
Where an exchange took place: the control plane, or one tenant.
*/
export type TrustPlane =
	| { readonly plane: 'control' }
	| { readonly plane: 'tenant'; readonly tenant: TenantId | undefined };

function stringClaim(
	claims: VerifiedOidcClaims,
	name: string
): string | undefined {
	const value = claims[name];

	return typeof value === 'string' ? value : undefined;
}

/**
Logs a warning for each rule whose issuer, audience and claims match
`verified` and which accepts GitHub Actions tokens without an exact
`repository_id` or `repository_owner_id`. The deployment refuses to add such
a rule, but it still matches stored ones, so the warning shows an operator
which rules match tokens and from which repository. The record contains the
token's repository claims and never the token itself.
*/
export function warnUnpinnedGithubMatches(
	logger: Logger,
	rules: readonly OidcTrustRule[],
	verified: VerifiedOidcClaims,
	where: TrustPlane
): void {
	for (const rule of rules) {
		if (
			!isUnpinnedGithubRule(rule) ||
			!hasMatchingOidcTrustIdentity([rule], verified)
		) {
			continue;
		}

		logger.warn(unpinnedGithubRuleMatchedMessage, {
			...where,
			rule: rule.id,
			issuer: rule.issuer,
			repositoryId: stringClaim(verified, 'repository_id'),
			repositoryOwnerId: stringClaim(verified, 'repository_owner_id')
		});
	}
}
