import {
	authorizationDetailSchema,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { oidcTrustSummarySchema } from '@cupboard/protocol/oidc';
import { type OidcTrustSelection } from '@cupboard/protocol/oidc-trust-selection';
import { describe, expect, it } from 'vitest';

import {
	AmbiguousTrustRulesFinding,
	InteractiveTrustRuleFinding,
	SplitTrustAuthorityFinding,
	TrustRuleGrantMissingFinding,
	trustSelectionFinding
} from './trust-selection.ts';

const rule = oidcTrustSummarySchema.parse({
	id: 'branch',
	issuer: 'https://token.actions.githubusercontent.com',
	audience: 'https://cupboard.example.test/t/acme',
	claims: { repository_id: '1234' },
	permittedGrants: [
		{
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: { exact: '_default', validate: 'cacheName' },
				root: {
					exact: 'github:acme/app/main/target',
					validate: 'rootName'
				}
			}
		}
	],
	disabled: false
});
const permitted = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		cache: '_default',
		root: 'github:acme/app/main/target'
	}
]);
const refused = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		cache: 'private'
	}
]);
const refusedDetail = authorizationDetailSchema.parse({
	type: 'cupboard_cache',
	actions: ['upload:commit'],
	cache: 'private'
});
const otherRule = oidcTrustSummarySchema.parse({ ...rule, id: 'other' });
const interactiveRule = oidcTrustSummarySchema.parse({
	...rule,
	id: 'owner',
	permittedGrants: [{ type: 'cupboard_wildcard' }]
});

type SelectionWithIdentity = Exclude<
	OidcTrustSelection,
	{ readonly outcome: 'identity-unmatched' }
>;

interface FindingCase {
	readonly name: string;
	readonly request: typeof permitted;
	readonly selection: SelectionWithIdentity;
	readonly expected: unknown;
	readonly rendered: string | undefined;
}

describe('trustSelectionFinding', () => {
	it.each<FindingCase>([
		{
			name: 'ambiguous rules',
			request: refused,
			selection: {
				outcome: 'ambiguous',
				rules: [rule, otherRule]
			},
			expected: new AmbiguousTrustRulesFinding(
				'main trust rule',
				[rule, otherRule],
				refused
			),
			rendered:
				'failed: rules branch, other match the modelled claims and permit ' +
				'upload:commit on cache private; make their grants disjoint or disable one rule'
		},
		{
			name: 'authority split across rules',
			request: refused,
			selection: {
				outcome: 'authority-unmatched',
				rules: [rule, otherRule],
				uncovered: []
			},
			expected: new SplitTrustAuthorityFinding('main trust rule', [
				rule,
				otherRule
			]),
			rendered:
				'failed: rules branch, other match the modelled claims, but no single rule ' +
				'permits the complete request; grant the request to one rule instead of ' +
				'splitting it across rules'
		},
		{
			name: 'missing grant on the sole matching rule',
			request: refused,
			selection: {
				outcome: 'authority-unmatched',
				rules: [rule],
				uncovered: refused
			},
			expected: new TrustRuleGrantMissingFinding(
				'main trust rule',
				[rule],
				refusedDetail
			),
			rendered:
				'failed: rule branch matches the modelled claims but does not permit ' +
				'upload:commit on cache private; remove it and re-run setup'
		},
		{
			name: 'grant no tied rule permits',
			request: refused,
			selection: {
				outcome: 'authority-unmatched',
				rules: [rule, otherRule],
				uncovered: refused
			},
			expected: new TrustRuleGrantMissingFinding(
				'main trust rule',
				[rule, otherRule],
				refusedDetail
			),
			rendered:
				'failed: rules branch, other match the modelled claims but none permits ' +
				'upload:commit on cache private; add the grant to one rule'
		},
		{
			name: 'interactive rule',
			request: permitted,
			selection: { outcome: 'selected', rule: interactiveRule },
			expected: new InteractiveTrustRuleFinding(
				'main trust rule',
				interactiveRule
			),
			rendered:
				'failed: interactive rule owner matches the modelled claims; workflows must ' +
				'use a scoped CI rule'
		},
		{
			name: 'permitted selection',
			request: permitted,
			selection: { outcome: 'selected', rule },
			expected: undefined,
			rendered: undefined
		}
	])(
		'returns the typed finding for $name',
		({ request, selection, expected, rendered }) => {
			const finding = trustSelectionFinding(
				'main trust rule',
				request,
				selection
			);

			expect({ finding, rendered: finding?.render() }).toStrictEqual({
				finding: expected,
				rendered
			});
		}
	);
});
