import { permittedGrantSchema } from '@cupboard/protocol/grants';
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
		{ label: '', value: 'issuer: https://token.actions.githubusercontent.com' },
		{ label: '', value: 'audience: https://cupboard.supply/t/laney' },
		{ label: '', value: 'claims:' },
		{ label: '', value: '  sub:' },
		{ label: '', value: `    pattern: ${pattern}` },
		{ label: '', value: 'permittedGrants:' },
		{ label: '', value: '  - type: cupboard_wildcard' }
	]);
	expect(trustRuleSummaryRows(rule)).toStrictEqual([
		{ label: 'Rule', value: 'long-pattern' },
		{ label: 'Issuer', value: 'https://token.actions.githubusercontent.com' },
		{ label: 'Audience', value: 'https://cupboard.supply/t/laney' },
		{ label: 'Claims', value: `sub=~${pattern}` },
		{ label: 'Grants', value: 'wildcard (every operation)' }
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
	const fields = [
		'actions:',
		'  - upload:commit',
		'  - root:set',
		'resources:',
		'  cache:',
		'    kind: named',
		'    equalsTemplate: gh-{repository_id}-pr-{pr}',
		'    substitutions:',
		'      repository_id:',
		'        claim: repository_id',
		'      pr:',
		'        claim: ref',
		'        capture:',
		'          pattern: ^refs/pull/(?<pr>[0-9]+)/merge$',
		'          group: pr',
		'    validate: cacheName',
		'  root:',
		'    equalsTemplate: github:iainlane/dotfiles/pr-{pr}/',
		'    substitutions:',
		'      pr:',
		'        claim: ref',
		'        capture:',
		'          pattern: ^refs/pull/(?<pr>[0-9]+)/merge$',
		'          group: pr',
		'    validate: rootName'
	];

	expect(trustGrantRows(grant, 'Grant 1')).toStrictEqual([
		{ label: 'Grant 1', value: 'cupboard_cache' },
		...fields.map((value) => ({ label: '', value }))
	]);
});
