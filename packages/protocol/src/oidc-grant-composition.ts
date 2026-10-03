import { isGrantPermittedByRule } from './grant-match.ts';
import {
	type AuthorizationDetail,
	type AuthorizationDetails,
	authorizationDetailSchema,
	isAuthorizationDetailCovered
} from './grants.ts';
import {
	type OidcClaims,
	type OidcTrustRule,
	preferredModelledOidcTrustRules
} from './oidc-trust-match.ts';
import { type OidcTrustSelection } from './oidc-trust-selection.ts';

export interface GrantRequirement {
	readonly alternatives: readonly [
		AuthorizationDetail,
		...AuthorizationDetail[]
	];
	readonly optional?: boolean;
}

export type GrantComposition =
	| Exclude<OidcTrustSelection, { readonly outcome: 'selected' }>
	| {
			readonly outcome: 'selected';
			readonly rule?: OidcTrustRule;
			readonly grants: AuthorizationDetails;
	  };

function actionDetails(detail: AuthorizationDetail): AuthorizationDetails {
	if (detail.type === 'cupboard_wildcard') {
		return [detail];
	}

	return detail.actions.map((action) =>
		authorizationDetailSchema.parse({ ...detail, actions: [action] })
	);
}

function selectAlternative(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	alternatives: readonly AuthorizationDetail[]
): AuthorizationDetail | undefined {
	return alternatives.find((grant) =>
		actionDetails(grant).every((detail) =>
			rules.some((rule) =>
				isGrantPermittedByRule(rule.permittedGrants, detail, claims)
			)
		)
	);
}

/**
 * Resolves ordered grant alternatives within the preferred identity tier.
 * Every action must be permitted; a refused request returns no partial grants.
 */
export function composeOidcGrants(
	rules: readonly OidcTrustRule[],
	claims: OidcClaims,
	requirements: readonly GrantRequirement[],
	maximum?: AuthorizationDetails
): GrantComposition {
	const preferred = preferredModelledOidcTrustRules(rules, claims);
	const first = preferred[0];

	if (first === undefined) {
		return { outcome: 'identity-unmatched' };
	}

	const grants: AuthorizationDetails = [];
	const uncovered: AuthorizationDetails = [];

	for (const requirement of requirements) {
		const selected = selectAlternative(
			preferred,
			claims,
			requirement.alternatives.filter(
				(detail) =>
					maximum === undefined || isAuthorizationDetailCovered(maximum, detail)
			)
		);
		if (selected !== undefined) {
			grants.push(selected);
			continue;
		}

		if (requirement.optional === true) {
			continue;
		}

		uncovered.push(
			...actionDetails(requirement.alternatives[0]).filter((detail) =>
				preferred.every(
					(rule) =>
						!isGrantPermittedByRule(rule.permittedGrants, detail, claims) ||
						(maximum !== undefined &&
							!isAuthorizationDetailCovered(maximum, detail))
				)
			)
		);
	}

	const [firstUncovered, ...remainingUncovered] = uncovered;
	if (firstUncovered !== undefined) {
		return {
			outcome: 'authority-unmatched',
			rules: [first, ...preferred.slice(1)],
			uncovered: [firstUncovered, ...remainingUncovered]
		};
	}

	const actions = grants.flatMap((detail) => actionDetails(detail));
	const complete = preferred.find((rule) =>
		actions.every((action) =>
			isGrantPermittedByRule(rule.permittedGrants, action, claims)
		)
	);
	return {
		outcome: 'selected',
		...(complete !== undefined && { rule: complete }),
		grants
	};
}
