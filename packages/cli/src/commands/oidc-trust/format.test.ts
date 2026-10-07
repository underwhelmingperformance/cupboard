import { isGrantPermittedByRule } from '@cupboard/protocol/grant-match';
import {
	authorizationDetailSchema,
	permittedGrantSchema
} from '@cupboard/protocol/grants';
import { oidcTrustSummarySchema } from '@cupboard/protocol/oidc';
import { expect, it } from 'vitest';

import {
	trustGrantRows,
	trustRuleRows,
	trustRuleSummaryRows
} from './format.ts';

it('keeps a long claim pattern on one line', () => {
	const pattern =
		'^repo:iainlane/dotfiles:ref:refs/heads/release with several words and a suffix that exceeds eighty columns$';
	const rule = oidcTrustSummarySchema.parse({
		id: 'long-pattern',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://cupboard.supply/t/laney',
		claims: { sub: { pattern } },
		permittedGrants: [{ type: 'cupboard_wildcard' }],
		disabled: false
	});

	expect(trustRuleRows(rule)).toStrictEqual([
		{ label: 'Rule', value: 'long-pattern' },
		{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
		{ label: 'Audience', value: 'https://cupboard.supply/t/laney' },
		{ label: 'Claims', value: `sub matches ${pattern}` },
		{ label: 'Access', value: 'Every operation on every resource' },
		{ label: 'State', value: 'enabled' }
	]);
	expect(trustRuleSummaryRows(rule)).toStrictEqual([
		{ label: 'Rule', value: 'long-pattern' },
		{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
		{ label: 'Audience', value: 'https://cupboard.supply/t/laney' },
		{ label: 'Claims', value: `sub matches ${pattern}` },
		{ label: 'Access', value: 'Every operation on every resource' },
		{ label: 'State', value: 'enabled' }
	]);
});

it('shows the exact view selector in a read grant', () => {
	const rule = oidcTrustSummarySchema.parse({
		id: 'view-reader',
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://cupboard.example.test/t/acme',
		claims: { repository_id: '1234' },
		permittedGrants: [
			{
				type: 'cupboard_view',
				actions: ['view:content-read'],
				resources: { view: { exact: 'reuse', validate: 'reuseViewName' } }
			}
		],
		disabled: false
	});

	expect(trustRuleSummaryRows(rule)).toStrictEqual([
		{ label: 'Rule', value: 'view-reader' },
		{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
		{ label: 'Audience', value: 'https://cupboard.example.test/t/acme' },
		{ label: 'Claims', value: 'repository_id=1234' },
		{ label: 'Access', value: 'View reuse: read cached content' },
		{ label: 'State', value: 'enabled' }
	]);
});

it('shows a claim-bound cache grant as structured fields', () => {
	const capture = {
		pattern: '^refs/pull/(?<pr>[0-9]+)/merge$',
		group: 'pr'
	};
	const grant = permittedGrantSchema.parse({
		type: 'cupboard_cache',
		actions: ['upload:commit', 'root:set'],
		resources: {
			cache: {
				kind: 'named',
				equalsTemplate: 'gh-{repository_id}-pr-{pr}',
				substitutions: {
					repository_id: { claim: 'repository_id' },
					pr: { claim: 'ref', capture }
				},
				validate: 'cacheName'
			},
			root: {
				equalsTemplate: 'github:iainlane/dotfiles/pr-{pr}/',
				substitutions: { pr: { claim: 'ref', capture } },
				validate: 'rootName'
			}
		}
	});
	expect(trustGrantRows(grant, 'Grant 1')).toStrictEqual([
		{
			label: 'Grant 1',
			value:
				'Cache from template gh-{repository_id}-pr-{pr}: complete publication of uploaded paths, set retention roots'
		},
		{
			label: 'Root restriction',
			value:
				'From template github:iainlane/dotfiles/pr-{pr}/ (resolved root and descendants)'
		},
		{ label: 'Cache variable {repository_id}', value: 'claim repository_id' },
		{
			label: 'Cache variable {pr}',
			value: 'group pr from claim ref matching ^refs/pull/(?<pr>[0-9]+)/merge$'
		},
		{
			label: 'Root variable {pr}',
			value: 'group pr from claim ref matching ^refs/pull/(?<pr>[0-9]+)/merge$'
		}
	]);
});

it('shows the same complete restrictions in inspection and consent', () => {
	const grant = permittedGrantSchema.parse({
		type: 'cupboard_cache',
		actions: ['root:remove'],
		resources: {
			cache: { kind: 'named', exact: 'builds', validate: 'cacheName' },
			root: { exact: 'release/', validate: 'rootName' }
		}
	});
	const rule = oidcTrustSummarySchema.parse({
		id: 'limited',
		issuer: 'https://idp.example.com',
		audience: 'cupboard',
		claims: { sub: 'operator' },
		permittedGrants: [grant],
		disabled: false
	});

	expect(trustRuleSummaryRows(rule)).toStrictEqual([
		{ label: 'Rule', value: 'limited' },
		{ label: 'Issuer', value: 'https://idp.example.com' },
		{ label: 'Audience', value: 'cupboard' },
		{ label: 'Claims', value: 'sub=operator' },
		{ label: 'Access', value: 'Cache builds: remove retention roots' },
		{ label: 'Root restriction', value: 'release/ (root and descendants)' },
		{ label: 'State', value: 'enabled' }
	]);
});

it('describes a root template by its own trailing slash', () => {
	const grant = permittedGrantSchema.parse({
		type: 'cupboard_cache',
		actions: ['root:remove'],
		resources: {
			cache: { kind: 'default' },
			root: {
				equalsTemplate: '{scope}',
				substitutions: { scope: { claim: 'root_scope' } },
				validate: 'rootName'
			}
		}
	});
	const requested = authorizationDetailSchema.parse({
		type: 'cupboard_cache',
		actions: ['root:remove'],
		cache: { kind: 'default' },
		root: 'release/production'
	});
	const claims = { root_scope: 'release/' };
	expect({
		permitted: isGrantPermittedByRule([grant], requested, claims),
		rows: trustGrantRows(grant, 'Access')
	}).toStrictEqual({
		permitted: false,
		rows: [
			{
				label: 'Access',
				value: "Tenant's default cache: remove retention roots"
			},
			{
				label: 'Root restriction',
				value: 'From template {scope} (exact resolved root)'
			},
			{ label: 'Root variable {scope}', value: 'claim root_scope' }
		]
	});
});
