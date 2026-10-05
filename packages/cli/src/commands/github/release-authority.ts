import {
	type AuthorizationDetails,
	isRootOperation,
	type PermittedGrant
} from '@cupboard/protocol/grants';
import { type ClaimMatch } from '@cupboard/protocol/oidc';
import {
	isClaimSatisfied,
	isRuleInteractive,
	type OidcTrustRule,
	preferredModelledOidcTrustRules
} from '@cupboard/protocol/oidc-trust-match';
import { type ReadResourceState } from '@cupboard/protocol/read-access';

import { collectSubstitutions } from '../oidc-trust/rule-builder.ts';

import { checkTrustRule } from './check.ts';
import { isDeepEqual } from './deep-equal.ts';
import { CheckFinding } from './finding.ts';
import { type PublicationCase } from './publication.ts';

export class ReleaseTagCoverageFinding extends CheckFinding {
	readonly status = 'unverified' as const;

	constructor(public readonly rule: string) {
		super('release tag coverage');
	}

	detail(): string {
		return `the check cannot prove that rule ${this.rule} permits every supported release tag; review its identity and resource bindings before repairing`;
	}
}

const universalTagReferences = new Set([
	'^refs/tags/[a-z0-9][a-z0-9._-]*$',
	'^refs/tags/.+$',
	'^refs/tags/.*$'
]);

function isUniversalTagReference(match: ClaimMatch | undefined): boolean {
	return (
		match === undefined ||
		(typeof match !== 'string' && universalTagReferences.has(match.pattern))
	);
}

function canMatchRelease(
	rule: OidcTrustRule,
	publication: PublicationCase
): boolean {
	const repository = publication.claims.repository;
	if (
		repository === undefined ||
		rule.issuer !== publication.claims.iss ||
		!isClaimSatisfied(rule.audience, publication.claims.aud)
	) {
		return false;
	}

	return Object.entries(rule.claims).every(([key, match]) => {
		if (key === 'ref') {
			return typeof match !== 'string' || match.startsWith('refs/tags/');
		}
		if (key === 'sub') {
			return (
				typeof match !== 'string' ||
				match.startsWith(`repo:${repository}:ref:refs/tags/`)
			);
		}
		return (
			publication.claims[key] === undefined ||
			isClaimSatisfied(match, publication.claims[key])
		);
	});
}

function isUniversalIdentity(
	rule: OidcTrustRule,
	publication: PublicationCase
): boolean {
	return Object.entries(rule.claims).every(([key, match]) => {
		if (key === 'ref') {
			return isUniversalTagReference(match);
		}
		if (key === 'sub') {
			return false;
		}
		return (
			publication.claims[key] !== undefined &&
			isClaimSatisfied(match, publication.claims[key])
		);
	});
}

function isUniversalRoot(
	grant: PermittedGrant,
	publication: PublicationCase
): boolean {
	if (grant.type !== 'cupboard_cache' || grant.resources.root === undefined) {
		return true;
	}
	const binding = grant.resources.root;
	const template = publication.releaseRootTemplate;
	const constant =
		binding.exact ??
		(binding.equalsTemplate?.includes('{') === true
			? undefined
			: binding.equalsTemplate);
	if (template === undefined) {
		return constant !== undefined;
	}
	if (constant !== undefined) {
		return constant.endsWith('/') && template.startsWith(constant);
	}
	return (
		binding.equalsTemplate !== undefined &&
		binding.equalsTemplate.endsWith('/') &&
		template.startsWith(binding.equalsTemplate) &&
		isDeepEqual(
			binding.substitutions,
			collectSubstitutions({ templateSource: 'github-tag', captures: [] })
		)
	);
}

function hasConstantResources(grant: PermittedGrant): boolean {
	if (grant.type === 'cupboard_cache') {
		return (
			grant.resources.cache.kind === 'default' ||
			!grant.resources.cache.equalsTemplate?.includes('{')
		);
	}
	if (grant.type === 'cupboard_view') {
		return !grant.resources.view.equalsTemplate?.includes('{');
	}
	return true;
}

function releaseAuthority(
	publication: PublicationCase,
	rules: readonly OidcTrustRule[]
): {
	readonly rules: readonly OidcTrustRule[];
	readonly finding?: ReleaseTagCoverageFinding;
	readonly uncertainRuleIds?: readonly string[];
} {
	if (publication.trigger !== 'release') {
		return { rules };
	}
	const possible = rules.filter((rule) => canMatchRelease(rule, publication));
	const universal = possible.filter((rule) =>
		isUniversalIdentity(rule, publication)
	);
	const selected = preferredModelledOidcTrustRules(
		universal,
		publication.claims
	);
	const first = selected[0];
	const specificity =
		first === undefined ? -1 : Object.keys(first.claims).length;
	const uncertain = possible.find(
		(rule) =>
			!isUniversalIdentity(rule, publication) &&
			(first === undefined ||
				Number(isRuleInteractive(rule)) > Number(isRuleInteractive(first)) ||
				(isRuleInteractive(rule) === isRuleInteractive(first) &&
					Object.keys(rule.claims).length >= specificity))
	);
	if (uncertain !== undefined) {
		return { rules: [], finding: new ReleaseTagCoverageFinding(uncertain.id) };
	}
	const uncertainRuleIds: string[] = [];
	const proven = selected.map((rule) => ({
		...rule,
		permittedGrants: rule.permittedGrants.flatMap((grant) => {
			if (!hasConstantResources(grant)) {
				uncertainRuleIds.push(rule.id);
				return [];
			}
			if (
				grant.type !== 'cupboard_cache' ||
				grant.actions.every((action) => !isRootOperation(action)) ||
				isUniversalRoot(grant, publication)
			) {
				return [grant];
			}
			uncertainRuleIds.push(rule.id);
			return [
				{
					...grant,
					actions: grant.actions.filter((action) => !isRootOperation(action))
				}
			];
		})
	}));
	return { rules: proven, uncertainRuleIds };
}

export function checkPublicationTrust(options: {
	readonly check: string;
	readonly publication: PublicationCase;
	readonly rules: readonly OidcTrustRule[];
	readonly requests: readonly AuthorizationDetails[];
	readonly resources: readonly ReadResourceState[];
}): CheckFinding {
	const authority = releaseAuthority(options.publication, options.rules);
	if (authority.finding !== undefined) {
		return authority.finding;
	}
	const trust = checkTrustRule(
		options.check,
		authority.rules,
		options.publication.claims,
		options.requests,
		options.resources
	);
	const uncertain = authority.uncertainRuleIds?.[0];
	return uncertain !== undefined && trust.status !== 'ok'
		? new ReleaseTagCoverageFinding(uncertain)
		: trust;
}
