import { describe, expect, it } from 'vitest';

import { matchOidcTrust, type OidcTrustRule } from './oidc-trust.ts';

const github = 'https://token.actions.githubusercontent.com';
const audience = 'https://cache.example.workers.dev';

const ownerRule: OidcTrustRule = {
	id: 'owner',
	issuer: 'https://accounts.google.com',
	audience: 'client-id.apps.googleusercontent.com',
	scope: 'admin',
	claims: { sub: 'owner-subject' },
	allowedRoots: []
};
const repoRule: OidcTrustRule = {
	id: 'repo',
	issuer: github,
	audience,
	scope: 'write',
	claims: { repository_owner_id: '5678' },
	allowedRoots: ['github:owner/']
};
const exactRepoRule: OidcTrustRule = {
	id: 'exact-repo',
	issuer: github,
	audience,
	scope: 'write',
	claims: { repository_owner_id: '5678', repository_id: '1234' },
	allowedRoots: ['github:owner/repo/']
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
			scope: 'write',
			claims: { repository_owner_id: '5678' },
			allowedRoots: []
		};
		const actorClaimRule: OidcTrustRule = {
			id: 'rule-a',
			issuer: github,
			audience,
			scope: 'write',
			claims: { actor: 'ci' },
			allowedRoots: []
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

	it('prefers an admin rule over a same-specificity write rule on a tie', () => {
		const adminRule: OidcTrustRule = {
			id: 'zzz-admin',
			issuer: github,
			audience,
			scope: 'admin',
			claims: { sub: 'shared' },
			allowedRoots: []
		};
		const writeRule: OidcTrustRule = {
			id: 'aaa-write',
			issuer: github,
			audience,
			scope: 'write',
			claims: { actor: 'ci' },
			allowedRoots: []
		};
		const claims = { iss: github, aud: audience, sub: 'shared', actor: 'ci' };

		// `aaa-write` sorts before `zzz-admin` by id, so only the scope tie-break
		// keeps the owner token on the admin rule.
		expect({
			forward: matchOidcTrust([adminRule, writeRule], claims)?.scope,
			reversed: matchOidcTrust([writeRule, adminRule], claims)?.scope
		}).toStrictEqual({ forward: 'admin', reversed: 'admin' });
	});

	it('prefers the admin rule even over a more specific write rule', () => {
		const adminRule: OidcTrustRule = {
			id: 'owner',
			issuer: github,
			audience,
			scope: 'admin',
			claims: { sub: 'owner-subject' },
			allowedRoots: []
		};
		const specificWriteRule: OidcTrustRule = {
			id: 'write',
			issuer: github,
			audience,
			scope: 'write',
			claims: { sub: 'owner-subject', actor: 'ci' },
			allowedRoots: []
		};
		const claims = {
			iss: github,
			aud: audience,
			sub: 'owner-subject',
			actor: 'ci'
		};

		// The write rule pins two claims to the admin rule's one, so without the
		// scope preference it would win on specificity and downgrade the owner.
		expect(matchOidcTrust([adminRule, specificWriteRule], claims)?.scope).toBe(
			'admin'
		);
	});
});
