import { type PermittedGrant } from '@cupboard/protocol/grants';
import {
	type ClaimMatch,
	type OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { type ResultRow } from '@cupboard/reporter';
import { stringify } from 'yaml';

function detailRows(details: object): ResultRow[] {
	if (Object.keys(details).length === 0) {
		return [];
	}

	return stringify(details, { lineWidth: 0 })
		.trimEnd()
		.split('\n')
		.map((value) => ({ label: '', value }));
}

export function trustRuleRows(
	rule: OidcTrustSummary,
	label = 'Rule'
): ResultRow[] {
	const { id, issuer, audience, claims, permittedGrants, display } = rule;
	const details = { issuer, audience, claims, permittedGrants, display };

	return [{ label, value: id }, ...detailRows(details)];
}

function claimRows(claims: Readonly<Record<string, ClaimMatch>>): ResultRow[] {
	const entries = Object.entries(claims);

	if (entries.length === 0) {
		return [{ label: 'Claims', value: '(none)' }];
	}

	return entries.map(([key, match], index) => ({
		label: index === 0 ? 'Claims' : '',
		value:
			typeof match === 'string' ? `${key}=${match}` : `${key}=~${match.pattern}`
	}));
}

function cacheBinding(
	binding: Extract<
		PermittedGrant,
		{ type: 'cupboard_cache' }
	>['resources']['cache']
): string {
	if (binding.kind === 'default') {
		return '(default)';
	}

	return binding.exact ?? binding.equalsTemplate ?? '?';
}

function grantSummary(grant: PermittedGrant): string {
	if (grant.type === 'cupboard_wildcard') {
		return 'wildcard (every operation)';
	}

	if (grant.type === 'cupboard_cache') {
		return `cache ${cacheBinding(grant.resources.cache)}: ${grant.actions.join(', ')}`;
	}

	if (grant.type === 'cupboard_tenant') {
		const tenant =
			grant.resources.tenant.exact ?? grant.resources.tenant.equalsTemplate;

		return `tenant ${tenant ?? '?'}: ${grant.actions.join(', ')}`;
	}

	return `${grant.type}: ${grant.actions.join(', ')}`;
}

export function trustRuleSummaryRows(rule: OidcTrustSummary): ResultRow[] {
	return [
		{ label: 'Rule', value: rule.id },
		{ label: 'Issuer', value: rule.issuer },
		{ label: 'Audience', value: rule.audience },
		...claimRows(rule.claims),
		...(rule.permittedGrants.length === 0
			? [{ label: 'Grants', value: '(none)' }]
			: rule.permittedGrants.map((grant, index) => ({
					label: index === 0 ? 'Grants' : '',
					value: grantSummary(grant)
				}))),
		...(rule.display?.repository === undefined
			? []
			: [{ label: 'Repository', value: rule.display.repository }])
	];
}

export function trustGrantRows(
	grant: PermittedGrant,
	label: string
): ResultRow[] {
	const { type, ...details } = grant;

	return [{ label, value: type }, ...detailRows(details)];
}
