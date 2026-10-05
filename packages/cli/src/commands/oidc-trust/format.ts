import {
	type PermittedGrant,
	type Substitution
} from '@cupboard/protocol/grants';
import {
	type ClaimMatch,
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
		return `From template ${root.equalsTemplate} (a resolved value ending in / allows that root and descendants; otherwise only that exact root)`;
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

export function trustRuleSummaryRows(
	rule: OidcTrustSummary,
	label = 'Rule'
): ResultRow[] {
	return [
		{ label, value: rule.id },
		{ label: 'Issuer', value: rule.issuer },
		{ label: 'Audience', value: rule.audience },
		...claimRows(rule.claims),
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
