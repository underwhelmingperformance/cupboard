import { describe, expect, it } from 'vitest';

import { matchOidcTrust, type OidcTrustRule } from './oidc-trust.ts';

const github = 'https://token.actions.githubusercontent.com';
const audience = 'https://cache.example.workers.dev';

const wildcard: OidcTrustRule['permittedGrants'] = [
	{ type: 'cupboard_wildcard' }
];

function ciGrant(cache: string): OidcTrustRule['permittedGrants'] {
	return [
		{
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: { cache: { exact: cache, validate: 'cacheName' } }
		}
	];
}

const ownerRule: OidcTrustRule = {
	id: 'owner',
	issuer: 'https://accounts.google.com',
	audience: 'client-id.apps.googleusercontent.com',
	claims: { sub: 'owner-subject' },
	permittedGrants: wildcard
};
const repoRule: OidcTrustRule = {
	id: 'repo',
	issuer: github,
	audience,
	claims: { repository_owner_id: '5678' },
	permittedGrants: ciGrant('owner-ci')
};
const exactRepoRule: OidcTrustRule = {
	id: 'exact-repo',
	issuer: github,
	audience,
	claims: { repository_owner_id: '5678', repository_id: '1234' },
	permittedGrants: ciGrant('owner-repo-ci')
};

const rules = [ownerRule, repoRule, exactRepoRule];

describe('matchOidcTrust', () => {
	it.each([
		{
			name: 'the owner rule for a matching id_token',
			claims: {
				iss: 'https://accounts.google.com',
				aud: 'client-id.apps.googleusercontent.com',
				sub: 'owner-subject'
			},
			id: 'owner'
		},
		{
			name: 'the most specific repo rule when both claim sets match',
			claims: {
				iss: github,
				aud: audience,
				repository_owner_id: '5678',
				repository_id: '1234'
			},
			id: 'exact-repo'
		},
		{
			name: 'the owner-prefix rule when only the owner claim matches',
			claims: {
				iss: github,
				aud: audience,
				repository_owner_id: '5678',
				repository_id: '9999'
			},
			id: 'repo'
		},
		{
			name: 'an audience supplied as an array',
			claims: { iss: github, aud: [audience], repository_owner_id: '5678' },
			id: 'repo'
		},
		{
			name: 'nothing when the issuer differs',
			claims: {
				iss: 'https://evil',
				aud: audience,
				repository_owner_id: '5678'
			},
			id: undefined
		},
		{
			name: 'nothing when the audience differs',
			claims: {
				iss: github,
				aud: 'https://other',
				repository_owner_id: '5678'
			},
			id: undefined
		},
		{
			name: 'nothing when a required claim is absent',
			claims: { iss: github, aud: audience },
			id: undefined
		},
		{
			name: 'nothing when a required claim has the wrong value',
			claims: { iss: github, aud: audience, repository_owner_id: '0000' },
			id: undefined
		}
	])('matches $name', ({ claims, id }) => {
		expect(matchOidcTrust(rules, claims)?.id).toBe(id);
	});

	it('does not match a numeric claim against a string-configured value', () => {
		expect(
			matchOidcTrust(rules, {
				iss: github,
				aud: audience,
				repository_owner_id: 5678
			})?.id
		).toBeUndefined();
	});

	it('matches when only the token iss carries a trailing slash', () => {
		expect(
			matchOidcTrust(rules, {
				iss: `${github}/`,
				aud: audience,
				repository_owner_id: '5678'
			})?.id
		).toBe('repo');
	});

	it('breaks an equal-specificity tie by id, regardless of row order', () => {
		const ownerClaimRule: OidcTrustRule = {
			id: 'rule-b',
			issuer: github,
			audience,
			claims: { repository_owner_id: '5678' },
			permittedGrants: ciGrant('ci-b')
		};
		const actorClaimRule: OidcTrustRule = {
			id: 'rule-a',
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
			forward: matchOidcTrust([ownerClaimRule, actorClaimRule], claims)?.id,
			reversed: matchOidcTrust([actorClaimRule, ownerClaimRule], claims)?.id
		}).toStrictEqual({ forward: 'rule-a', reversed: 'rule-a' });
	});

	it('prefers an interactive rule over a same-specificity CI rule on a tie', () => {
		const interactiveRule: OidcTrustRule = {
			id: 'zzz-owner',
			issuer: github,
			audience,
			claims: { sub: 'shared' },
			permittedGrants: wildcard
		};
		const ciRule: OidcTrustRule = {
			id: 'aaa-ci',
			issuer: github,
			audience,
			claims: { actor: 'ci' },
			permittedGrants: ciGrant('ci')
		};
		const claims = { iss: github, aud: audience, sub: 'shared', actor: 'ci' };

		// `aaa-ci` sorts before `zzz-owner` by id, so only the interactive
		// tie-break keeps the owner token on the wildcard rule.
		expect({
			forward: matchOidcTrust([interactiveRule, ciRule], claims)?.id,
			reversed: matchOidcTrust([ciRule, interactiveRule], claims)?.id
		}).toStrictEqual({ forward: 'zzz-owner', reversed: 'zzz-owner' });
	});

	it('prefers the interactive rule even over a more specific CI rule', () => {
		const interactiveRule: OidcTrustRule = {
			id: 'owner',
			issuer: github,
			audience,
			claims: { sub: 'owner-subject' },
			permittedGrants: wildcard
		};
		const specificCiRule: OidcTrustRule = {
			id: 'ci',
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

		// The CI rule pins two claims to the owner rule's one, so without the
		// interactive preference it would win on specificity and downgrade the owner.
		expect(matchOidcTrust([interactiveRule, specificCiRule], claims)?.id).toBe(
			'owner'
		);
	});
});
