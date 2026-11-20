import type {
	OidcTrustAddBodyInput,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';

import { isDeepEqual } from '../github/deep-equal.ts';

type PermittedGrantInput = OidcTrustAddBodyInput['permittedGrants'][number];

// Operations that a release added to the branch and tag presets after earlier
// releases had written rules from them. Setup adds these operations to such a
// rule, which is otherwise the preset's rule.
const operationsAddedToPresets: ReadonlySet<string> = new Set([
	'build-inputs:record'
]);

type CacheGrantInput = Extract<PermittedGrantInput, { type: 'cupboard_cache' }>;

function isCacheGrant(grant: PermittedGrantInput): grant is CacheGrantInput {
	return grant.type === 'cupboard_cache';
}

function withoutAddedOperations(
	grants: readonly PermittedGrantInput[]
): PermittedGrantInput[] {
	return grants
		.map((grant) =>
			isCacheGrant(grant)
				? {
						...grant,
						actions: grant.actions.filter(
							(action) => !operationsAddedToPresets.has(action)
						)
					}
				: grant
		)
		.filter((grant) => !isCacheGrant(grant) || grant.actions.length > 0);
}

function addedOperationGrants(
	grants: readonly PermittedGrantInput[]
): CacheGrantInput[] {
	return grants
		.filter((grant) => isCacheGrant(grant))
		.map((grant) => ({
			...grant,
			actions: grant.actions.filter((action) =>
				operationsAddedToPresets.has(action)
			)
		}))
		.filter((grant) => grant.actions.length > 0);
}

/**
The grants that bring `rule` up to `body` when an earlier release wrote `rule`
from the same preset: `rule` has the claims of `body` and exactly its grants
without the operations added to presets since. Each returned grant has the
resources of the preset grant that it completes and only the missing
operations, the form in which `oidcTrust.extend` appends them. Returns
undefined for any other rule.
*/
export function presetUpgradeGrants(
	rule: OidcTrustSummary,
	body: OidcTrustAddBodyInput
): CacheGrantInput[] | undefined {
	const added = addedOperationGrants(body.permittedGrants);

	if (
		added.length === 0 ||
		rule.issuer !== body.issuer ||
		rule.audience !== body.audience ||
		!isDeepEqual(rule.claims, body.claims) ||
		!isDeepEqual(
			rule.permittedGrants,
			withoutAddedOperations(body.permittedGrants)
		)
	) {
		return undefined;
	}

	return added;
}

/**
Whether `rule` is a rule that an earlier release wrote from `body`'s preset
after `presetUpgradeGrants` has extended it, so it grants what `body` grants.
*/
export function isUpgradedPresetRule(
	rule: OidcTrustSummary,
	body: OidcTrustAddBodyInput
): boolean {
	const added = addedOperationGrants(body.permittedGrants);

	return (
		added.length > 0 &&
		rule.issuer === body.issuer &&
		rule.audience === body.audience &&
		isDeepEqual(rule.claims, body.claims) &&
		isDeepEqual(rule.permittedGrants, [
			...withoutAddedOperations(body.permittedGrants),
			...added
		])
	);
}
