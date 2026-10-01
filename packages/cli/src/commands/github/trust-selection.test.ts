import {
	authorizationDetailSchema,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { oidcTrustSummarySchema } from '@cupboard/protocol/oidc';
import { type OidcTrustSelection } from '@cupboard/protocol/oidc-trust-selection';
import { describe, expect, it } from 'vitest';

import {
	AmbiguousTrustRulesFinding,
	describeAuthorizationDetail,
	InteractiveTrustRuleFinding,
	TrustRuleGrantMissingFinding,
	trustSelectionFinding
} from './trust-selection.ts';

it('describes an exact view read grant', () => {
	const detail = authorizationDetailSchema.parse({
		type: 'cupboard_view',
		actions: ['view:content-read'],
		view: 'reuse'
	});

	expect(describeAuthorizationDetail(detail)).toBe(
		'view:content-read on view reuse'
	);
});

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
				cache: { kind: 'default' },
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
		cache: { kind: 'default' },
		root: 'github:acme/app/main/target'
	}
]);
const refused = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		actions: ['upload:commit'],
		cache: { kind: 'named', name: 'private' }
	}
]);
const refusedDetail = authorizationDetailSchema.parse({
	type: 'cupboard_cache',
	actions: ['upload:commit'],
	cache: { kind: 'named', name: 'private' }
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
				'failed: rules branch, other match the modelled claims but implicit authority requires one rule; request explicit grants or distinguish their claims'
		},
		{
			name: 'missing grant on the sole matching rule',
			request: refused,
			selection: {
				outcome: 'authority-unmatched',
				rules: [rule],
				uncovered: [refusedDetail]
			},
			expected: new TrustRuleGrantMissingFinding(
				'main trust rule',
				[rule],
				refusedDetail
			),
			rendered:
				'failed: rule branch matches the modelled claims but does not permit ' +
				'upload:commit on cache private; add a rule with the required grant, or add a corrected rule and remove this one'
		},
		{
			name: 'grant no tied rule permits',
			request: refused,
			selection: {
				outcome: 'authority-unmatched',
				rules: [rule, otherRule],
				uncovered: [refusedDetail]
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
			selection: { outcome: 'selected', rule: rule },
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
