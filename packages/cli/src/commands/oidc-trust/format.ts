import {
	type PermittedGrant,
	type Substitution
} from '@cupboard/protocol/grants';
import {
	type ClaimMatch,
	isUnpinnedGithubRule,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { type ResultRow } from '@cupboard/reporter';

import { humanOperation } from '../../human-permissions.ts';

interface Binding {
	readonly exact?: string;
	readonly equalsTemplate?: string;
	readonly substitutions?: Readonly<Record<string, Substitution>>;
}

function claimRows(claims: Readonly<Record<string, ClaimMatch>>): ResultRow[] {
	const entries = Object.entries(claims);

	if (entries.length === 0) {
		return [{ label: 'Claims', value: 'No claim restrictions' }];
	}

	return entries.map(([key, match], index) => ({
		label: index === 0 ? 'Claims' : '',
		value:
			typeof match === 'string'
				? `${key}=${match}`
				: `${key} matches ${match.pattern}`
	}));
}

function bindingDescription(binding: Binding): string {
	return (
		binding.exact ??
		`from template ${binding.equalsTemplate ?? '(unspecified)'}`
	);
}

function substitutionRows(binding: Binding, resource: string): ResultRow[] {
	return Object.entries(binding.substitutions ?? {}).map(
		([variable, substitution]) => ({
			label: `${resource} variable {${variable}}`,
			value: substitutionDescription(substitution)
		})
	);
}

function substitutionDescription(substitution: Substitution): string {
	if (substitution.capture !== undefined) {
		return `group ${substitution.capture.group} from claim ${substitution.claim} matching ${substitution.capture.pattern}`;
	}

	if (substitution.slug === true) {
		return `claim ${substitution.claim}, lowercased; each run of characters outside a-z, 0-9, dot, underscore and hyphen becomes one hyphen`;
	}

	return `claim ${substitution.claim}`;
}

function rootDescription(root: Binding): string {
	if (root.equalsTemplate !== undefined) {
		return `From template ${root.equalsTemplate}${root.equalsTemplate.endsWith('/') ? ' (resolved root and descendants)' : ' (exact resolved root)'}`;
	}
	return `${root.exact ?? '(unspecified)'}${root.exact?.endsWith('/') === true ? ' (root and descendants)' : ' (exact root)'}`;
}

function resourceRows(
	grant: Exclude<PermittedGrant, { type: 'cupboard_wildcard' }>
): ResultRow[] {
	if (grant.type === 'cupboard_cache') {
		const root = grant.resources.root;
		return [
			...(root === undefined
				? []
				: [{ label: 'Root restriction', value: rootDescription(root) }]),
			...(grant.resources.cache.kind === 'named'
				? substitutionRows(grant.resources.cache, 'Cache')
				: []),
			...(root === undefined ? [] : substitutionRows(root, 'Root'))
		];
	}

	if (grant.type === 'cupboard_view') {
		return substitutionRows(grant.resources.view, 'View');
	}

	if (grant.type === 'cupboard_tenant') {
		return substitutionRows(grant.resources.tenant, 'Tenant');
	}

	return [];
}

function resourceDescription(
	grant: Exclude<PermittedGrant, { type: 'cupboard_wildcard' }>
): string {
	if (grant.type === 'cupboard_cache') {
		const cache = grant.resources.cache;
		if (cache.kind === 'default') {
			return "Tenant's default cache";
		}

		return cache.pattern === undefined
			? `Cache ${bindingDescription(cache)}`
			: `Caches matching ${cache.pattern}`;
	}

	if (grant.type === 'cupboard_view') {
		return `View ${bindingDescription(grant.resources.view)}`;
	}

	if (grant.type === 'cupboard_tenant') {
		return `Tenant ${bindingDescription(grant.resources.tenant)}`;
	}

	return grant.type === 'cupboard_control' ? 'Deployment' : 'Tenant';
}

export function trustGrantRows(
	grant: PermittedGrant,
	label: string
): ResultRow[] {
	if (grant.type === 'cupboard_wildcard') {
		return [{ label, value: 'Every operation on every resource' }];
	}

	return [
		{
			label,
			value: `${resourceDescription(grant)}: ${grant.actions.map((operation) => humanOperation(operation)).join(', ')}`
		},
		...resourceRows(grant)
	];
}

/**
Describes `grant` on one line, with the text of {@link trustGrantRows}: its
resource and operations, followed by its resource restrictions in
parentheses.
*/
export function trustGrantDescription(grant: PermittedGrant): string {
	const [summary, ...restrictions] = trustGrantRows(grant, '');
	const details = restrictions
		.map((row) => `${row.label.toLowerCase()}: ${row.value}`)
		.join('; ');

	return details === ''
		? (summary?.value ?? '')
		: `${summary?.value ?? ''} (${details})`;
}

/**
The warning for an enabled GitHub Actions rule that requires neither an exact
`repository_id` nor an exact `repository_owner_id`. `subject` introduces the
rule, for example "Trust rule <id>", and `removal` is the command that
removes it.
*/
export function unpinnedGithubRuleWarning(
	subject: string,
	removal: string
): string {
	return `${subject} accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Any repository whose tokens satisfy its other claims can use it. Add a rule that pins the repository, then remove this rule with \`${removal}\`.`;
}

/**
The ID of the control trust rule that a deployment claim creates for the
deployment's admin.
*/
export const adminControlRuleId = 'signup';

/**
The warning for the admin's control trust rule when it is an unpinned GitHub
Actions rule. `cupboard init` needs a wildcard token for the admin's identity,
so the replacement has to exist before the rule is removed.
*/
export function unpinnedGithubAdminRuleWarning(
	subject: string,
	removal: string
): string {
	return `${subject} is the rule for the deployment's admin, and it accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Its subject binds at most the repository's name. Before you remove it, add a control trust rule with the same issuer, audience and sub claim, the repository's exact repository_id and repository_owner_id, and the wildcard grant. Without such a rule, the admin can no longer sign in and cupboard init stops. Then remove this rule with \`${removal}\`.`;
}

/**
The warning for a tenant's owner rule when it is an unpinned GitHub Actions
rule. The owner rule cannot be removed, and a tenant's owner cannot be changed.
*/
export const unpinnedGithubOwnerRuleWarning =
	"Trust rule owner is the tenant's owner rule, and it accepts GitHub Actions tokens without an exact repository_id or repository_owner_id claim. Its subject binds at most the repository's name. The owner rule cannot be removed, and a tenant's owner cannot be changed. Do not rename or delete the repository in its subject, or the account that owns the repository. Either change frees the name, and a new repository with the same name would match the rule. To stop trusting it, ask the operator to remove the tenant and create a new one whose owner is a person.";

export function trustRuleSummaryRows(
	rule: OidcTrustSummary,
	label = 'Rule'
): ResultRow[] {
	return [
		{ label, value: rule.id },
		{ label: 'Issuer', value: rule.issuer },
		{ label: 'Audience', value: rule.audience },
		...claimRows(rule.claims),
		...(isUnpinnedGithubRule(rule)
			? [
					{
						label: 'Repository pin',
						value:
							'None. The rule requires no exact repository_id or repository_owner_id claim.'
					}
				]
			: []),
		...(rule.permittedGrants.length === 0
			? [{ label: 'Access', value: 'No permissions' }]
			: rule.permittedGrants.flatMap((grant, index) =>
					trustGrantRows(grant, index === 0 ? 'Access' : '')
				)),
		{ label: 'State', value: rule.disabled ? 'disabled' : 'enabled' },
		...(rule.display?.repository === undefined
			? []
			: [{ label: 'Repository', value: rule.display.repository }])
	];
}

export function trustRuleRows(
	rule: OidcTrustSummary,
	label = 'Rule'
): ResultRow[] {
	return trustRuleSummaryRows(rule, label);
}
