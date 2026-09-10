import { describe, expect, it } from 'vitest';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	trustRuleIdSchema
} from './oidc.ts';
import {
	firstClaimMismatch,
	hasMatchingOidcTrustIdentity,
	matchModelledOidcTrust,
	type OidcTrustRule,
	oidcTrustVerificationTarget
} from './oidc-trust-match.ts';

const github = oidcIssuerSchema.parse(
	'https://token.actions.githubusercontent.com'
);
const audience = oidcAudienceSchema.parse('https://cache.example.workers.dev');

const wildcard: OidcTrustRule['permittedGrants'] = [
	{ type: 'cupboard_wildcard' }
];

function ciGrant(cache: string): OidcTrustRule['permittedGrants'] {
	return [
		{
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: { exact: cache, kind: 'named', validate: 'cacheName' }
			}
		}
	];
}

const ownerRule: OidcTrustRule = {
	id: trustRuleIdSchema.parse('owner'),
	issuer: oidcIssuerSchema.parse('https://accounts.google.com'),
	audience: oidcAudienceSchema.parse('client-id.apps.googleusercontent.com'),
	claims: { sub: 'owner-subject' },
	permittedGrants: wildcard
};
const repoRule: OidcTrustRule = {
	id: trustRuleIdSchema.parse('repo'),
	issuer: github,
	audience,
	claims: { repository_owner_id: '5678' },
	permittedGrants: ciGrant('owner-ci')
};
const exactRepoRule: OidcTrustRule = {
	id: trustRuleIdSchema.parse('exact-repo'),
	issuer: github,
	audience,
	claims: { repository_owner_id: '5678', repository_id: '1234' },
	permittedGrants: ciGrant('owner-repo-ci')
};

const rules = [ownerRule, repoRule, exactRepoRule];

describe('matchModelledOidcTrust', () => {
	it.each([
		{
			name: 'selects the owner rule for a matching id_token',
			claims: {
				iss: 'https://accounts.google.com',
				aud: 'client-id.apps.googleusercontent.com',
				sub: 'owner-subject'
			},
			id: 'owner'
		},
		{
			name: 'selects the most specific repo rule when both claim sets match',
			claims: {
				iss: github,
				aud: audience,
				repository_owner_id: '5678',
				repository_id: '1234'
			},
			id: 'exact-repo'
		},
		{
			name: 'selects the owner-prefix rule when only the owner claim matches',
			claims: {
				iss: github,
				aud: audience,
				repository_owner_id: '5678',
				repository_id: '9999'
			},
			id: 'repo'
		},
		{
			name: 'accepts an audience supplied as an array',
			claims: { iss: github, aud: [audience], repository_owner_id: '5678' },
			id: 'repo'
		},
		{
			name: 'returns undefined when the issuer differs',
			claims: {
				iss: 'https://evil',
				aud: audience,
				repository_owner_id: '5678'
			},
			id: undefined
		},
		{
			name: 'returns undefined when the audience differs',
			claims: {
				iss: github,
				aud: 'https://other',
				repository_owner_id: '5678'
			},
			id: undefined
		},
		{
			name: 'returns undefined when a required claim is absent',
			claims: { iss: github, aud: audience },
			id: undefined
		},
		{
			name: 'returns undefined when a required claim has the wrong value',
			claims: { iss: github, aud: audience, repository_owner_id: '0000' },
			id: undefined
		}
	])('$name', ({ claims, id }) => {
		expect(matchModelledOidcTrust(rules, claims)?.id).toBe(id);
	});

	it('does not match a numeric claim against a string-configured value', () => {
		expect(
			matchModelledOidcTrust(rules, {
				iss: github,
				aud: audience,
				repository_owner_id: 5678
			})?.id
		).toBeUndefined();
	});

	it('matches a claim against a configured pattern', () => {
		const patternRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('pattern'),
			issuer: github,
			audience,
			claims: {
				job_workflow_ref: { pattern: '^acme/infra/.+@.+$' }
			},
			permittedGrants: ciGrant('acme-ci')
		};
		const base = { iss: github, aud: audience };

		expect({
			match: matchModelledOidcTrust([patternRule], {
				...base,
				job_workflow_ref:
					'acme/infra/.github/workflows/publish.yml@refs/heads/main'
			})?.id,
			noMatch: matchModelledOidcTrust([patternRule], {
				...base,
				job_workflow_ref:
					'other/repo/.github/workflows/publish.yml@refs/heads/main'
			})?.id,
			absent: matchModelledOidcTrust([patternRule], base)?.id
		}).toStrictEqual({
			match: 'pattern',
			noMatch: undefined,
			absent: undefined
		});
	});

	it('rejects when only the token issuer ends with a trailing slash', () => {
		expect(
			matchModelledOidcTrust(rules, {
				iss: `${github}/`,
				aud: audience,
				repository_owner_id: '5678'
			})?.id
		).toBeUndefined();
	});

	it('fails closed on an equal-rank and equal-specificity tie', () => {
		const ownerClaimRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('rule-b'),
			issuer: github,
			audience,
			claims: { repository_owner_id: '5678' },
			permittedGrants: ciGrant('ci-b')
		};
		const actorClaimRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('rule-a'),
			issuer: github,
			audience,
			claims: { actor: 'ci' },
			permittedGrants: ciGrant('ci-a')
		};
		const claims = {
			iss: github,
			aud: audience,
			repository_owner_id: '5678',
			actor: 'ci'
		};

		expect({
			forward: matchModelledOidcTrust([ownerClaimRule, actorClaimRule], claims)
				?.id,
			reversed: matchModelledOidcTrust([actorClaimRule, ownerClaimRule], claims)
				?.id
		}).toStrictEqual({ forward: undefined, reversed: undefined });
	});

	it('prefers a wildcard rule over a claim-bound rule with the same specificity', () => {
		const interactiveRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('zzz-owner'),
			issuer: github,
			audience,
			claims: { sub: 'shared' },
			permittedGrants: wildcard
		};
		const ciRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('aaa-ci'),
			issuer: github,
			audience,
			claims: { actor: 'ci' },
			permittedGrants: ciGrant('ci')
		};
		const claims = { iss: github, aud: audience, sub: 'shared', actor: 'ci' };

		expect({
			forward: matchModelledOidcTrust([interactiveRule, ciRule], claims)?.id,
			reversed: matchModelledOidcTrust([ciRule, interactiveRule], claims)?.id
		}).toStrictEqual({ forward: 'zzz-owner', reversed: 'zzz-owner' });
	});

	it('prefers a wildcard rule over a more specific claim-bound rule', () => {
		const interactiveRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('owner'),
			issuer: github,
			audience,
			claims: { sub: 'owner-subject' },
			permittedGrants: wildcard
		};
		const specificCiRule: OidcTrustRule = {
			id: trustRuleIdSchema.parse('ci'),
			issuer: github,
			audience,
			claims: { sub: 'owner-subject', actor: 'ci' },
			permittedGrants: ciGrant('ci')
		};
		const claims = {
			iss: github,
			aud: audience,
			sub: 'owner-subject',
			actor: 'ci'
		};

		expect(
			matchModelledOidcTrust([interactiveRule, specificCiRule], claims)?.id
		).toBe('owner');
	});
});

describe('oidcTrustVerificationTarget', () => {
	it('returns one shared target for several rules in the same trust domain', () => {
		expect(
			oidcTrustVerificationTarget([repoRule, exactRepoRule], {
				iss: github,
				aud: audience
			})
		).toStrictEqual({ issuer: github, audience });
	});

	it('returns undefined when no configured target matches', () => {
		expect(
			oidcTrustVerificationTarget(rules, {
				iss: 'https://untrusted.example.com',
				aud: audience
			})
		).toBeUndefined();
	});

	it('resolves an audience array by authorised party, then sorted order', () => {
		const otherAudience = oidcAudienceSchema.parse(
			'https://other.example.workers.dev'
		);
		const otherRule: OidcTrustRule = {
			...repoRule,
			id: trustRuleIdSchema.parse('other-audience'),
			audience: otherAudience
		};
		const claims = { iss: github, aud: [otherAudience, audience] };

		expect({
			forward: oidcTrustVerificationTarget([repoRule, otherRule], claims),
			reversed: oidcTrustVerificationTarget([otherRule, repoRule], claims),
			authorisedParty: oidcTrustVerificationTarget([repoRule, otherRule], {
				...claims,
				azp: otherAudience
			})
		}).toStrictEqual({
			forward: { issuer: github, audience },
			reversed: { issuer: github, audience },
			authorisedParty: { issuer: github, audience: otherAudience }
		});
	});
});

describe('hasMatchingOidcTrustIdentity', () => {
	it('distinguishes a full identity match from a configured-claim mismatch', () => {
		const base = { iss: github, aud: audience };

		expect({
			matched: hasMatchingOidcTrustIdentity(rules, {
				...base,
				repository_owner_id: '5678'
			}),
			unmatched: hasMatchingOidcTrustIdentity(rules, {
				...base,
				repository_owner_id: '9999'
			})
		}).toStrictEqual({ matched: true, unmatched: false });
	});
});

describe('firstClaimMismatch', () => {
	const rule: OidcTrustRule = {
		id: trustRuleIdSchema.parse('branch'),
		issuer: github,
		audience,
		claims: {
			repository_id: '1234',
			repository_owner_id: '5678',
			ref: 'refs/heads/main',
			job_workflow_ref: { pattern: '^acme/infra/.+@.+$' }
		},
		permittedGrants: ciGrant('ci')
	};
	const matching = {
		iss: github,
		aud: audience,
		repository_id: '1234',
		repository_owner_id: '5678',
		ref: 'refs/heads/main',
		job_workflow_ref: 'acme/infra/.github/workflows/publish.yml@refs/heads/main'
	};

	it.each([
		{
			name: 'returns undefined when every configured claim matches',
			claims: matching,
			expected: undefined
		},
		{
			name: 'returns the wrong exact value and the presented value',
			claims: { ...matching, ref: 'refs/heads/other' },
			expected: {
				claim: 'ref',
				expected: 'refs/heads/main',
				presented: 'refs/heads/other'
			}
		},
		{
			name: 'returns a failed pattern in its pattern form',
			claims: {
				...matching,
				job_workflow_ref:
					'other/repo/.github/workflows/publish.yml@refs/heads/main'
			},
			expected: {
				claim: 'job_workflow_ref',
				expected: 'pattern:^acme/infra/.+@.+$',
				presented: 'other/repo/.github/workflows/publish.yml@refs/heads/main'
			}
		},
		{
			name: 'omits the presented value for an absent claim',
			claims: { ...matching, ref: undefined },
			expected: { claim: 'ref', expected: 'refs/heads/main' }
		},
		{
			name: 'omits the presented value for a non-string claim',
			claims: { ...matching, repository_id: 1234 },
			expected: { claim: 'repository_id', expected: '1234' }
		},
		{
			name: 'returns the first mismatch in claim-name order when several fail',
			claims: { ...matching, ref: 'refs/heads/other', repository_id: '9999' },
			expected: {
				claim: 'ref',
				expected: 'refs/heads/main',
				presented: 'refs/heads/other'
			}
		}
	])('$name', ({ claims, expected }) => {
		expect(firstClaimMismatch(rule, claims)).toStrictEqual(expected);
	});
});
