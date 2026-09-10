import { describe, expect, it } from 'vitest';

import { isGrantPermittedByRule } from './grant-match.ts';
import {
	type AuthorizationDetail,
	authorizationDetailSchema,
	type PermittedGrant,
	permittedGrantSchema
} from './grants.ts';
import { type OidcClaims } from './oidc-trust-match.ts';

function grant(value: unknown): PermittedGrant {
	return permittedGrantSchema.parse(value);
}

function request(value: unknown): AuthorizationDetail {
	return authorizationDetailSchema.parse(value);
}

const wildcard = grant({ type: 'cupboard_wildcard' });

const prCacheGrant = grant({
	type: 'cupboard_cache',
	actions: ['upload:commit', 'root:set'],
	resources: {
		cache: {
			equalsTemplate: 'pr-{ref}',
			substitutions: {
				ref: {
					claim: 'ref',
					capture: { pattern: '^refs/pull/(?<ref>[0-9]+)/merge$', group: 'ref' }
				}
			},
			kind: 'named',
			validate: 'cacheName'
		},
		root: {
			equalsTemplate: 'pr-{ref}',
			substitutions: {
				ref: {
					claim: 'ref',
					capture: { pattern: '^refs/pull/(?<ref>[0-9]+)/merge$', group: 'ref' }
				}
			},
			validate: 'rootName'
		}
	}
});

const domainGrant = grant({
	type: 'cupboard_domain',
	actions: ['stats:read']
});

const tenantGrant = grant({
	type: 'cupboard_tenant',
	actions: ['tenant:create'],
	resources: { tenant: { exact: 'acme', validate: 'tenant' } }
});

const prClaims: OidcClaims = {
	iss: 'https://token.actions.githubusercontent.com',
	ref: 'refs/pull/123/merge'
};

describe('isGrantPermittedByRule', () => {
	it.each([
		{
			name: 'a wildcard permits any cache request',
			permitted: [wildcard],
			requested: {
				type: 'cupboard_cache',
				actions: ['gc:run'],
				cache: { kind: 'named', name: 'anything' }
			},
			claims: {},
			expected: true
		},
		{
			name: 'a PR 123 ref permits cache pr-123',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: prClaims,
			expected: true
		},
		{
			name: 'a PR 123 ref refuses cache pr-456',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-456' }
			},
			claims: prClaims,
			expected: false
		},
		{
			name: 'a missing ref claim refuses the PR cache',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: { iss: 'x' },
			expected: false
		},
		{
			name: 'a branch ref refuses the PR cache',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: { ref: 'refs/heads/main' },
			expected: false
		},
		{
			name: 'a PR-cache rule refuses gc:run',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['gc:run'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: prClaims,
			expected: false
		},
		{
			name: 'a rule permitting upload:negotiate issues a requested upload:preview detail',
			permitted: [
				grant({
					type: 'cupboard_cache',
					actions: ['upload:negotiate'],
					resources: {
						cache: { exact: 'pr-123', kind: 'named', validate: 'cacheName' }
					}
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:preview'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: {},
			expected: true
		},
		{
			name: 'a rule permitting only upload:preview does not issue a requested upload:negotiate detail',
			permitted: [
				grant({
					type: 'cupboard_cache',
					actions: ['upload:preview'],
					resources: {
						cache: { exact: 'pr-123', kind: 'named', validate: 'cacheName' }
					}
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:negotiate'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: {},
			expected: false
		},
		{
			name: 'a rule permitting only upload:commit does not issue a requested upload:confirm detail',
			permitted: [
				grant({
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: {
						cache: { exact: 'pr-123', kind: 'named', validate: 'cacheName' }
					}
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:confirm'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: {},
			expected: false
		},
		{
			name: 'a rule permitting only upload:confirm does not issue a requested upload:commit detail',
			permitted: [
				grant({
					type: 'cupboard_cache',
					actions: ['upload:confirm'],
					resources: {
						cache: { exact: 'pr-123', kind: 'named', validate: 'cacheName' }
					}
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'named', name: 'pr-123' }
			},
			claims: {},
			expected: false
		},
		{
			name: 'a root bound to the cache permits root pr-123',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: { kind: 'named', name: 'pr-123' },
				root: 'pr-123'
			},
			claims: prClaims,
			expected: true
		},
		{
			name: 'a root bound to the cache refuses root main',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: { kind: 'named', name: 'pr-123' },
				root: 'main'
			},
			claims: prClaims,
			expected: false
		},
		{
			name: 'a default-scope binding permits the default cache',
			permitted: [
				grant({
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: { cache: { kind: 'default' } }
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: { kind: 'default' }
			},
			claims: {},
			expected: true
		},
		{
			name: 'a domain grant permits stats:read',
			permitted: [domainGrant],
			requested: { type: 'cupboard_domain', actions: ['stats:read'] },
			claims: {},
			expected: true
		},
		{
			name: 'a tenant grant permits its exact tenant',
			permitted: [tenantGrant],
			requested: {
				type: 'cupboard_tenant',
				actions: ['tenant:create'],
				tenant: 'acme'
			},
			claims: {},
			expected: true
		},
		{
			name: 'a tenant grant refuses a different tenant',
			permitted: [tenantGrant],
			requested: {
				type: 'cupboard_tenant',
				actions: ['tenant:create'],
				tenant: 'other'
			},
			claims: {},
			expected: false
		}
	])('$name', ({ permitted, requested, claims, expected }) => {
		expect(isGrantPermittedByRule(permitted, request(requested), claims)).toBe(
			expected
		);
	});

	it('refuses a binding that renders an invalid cache name', () => {
		const verbatimGrant = grant({
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: {
					equalsTemplate: '{name}',
					substitutions: { name: { claim: 'repository' } },
					kind: 'named',
					validate: 'cacheName'
				}
			}
		});

		expect(
			isGrantPermittedByRule(
				[verbatimGrant],
				request({
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					cache: { kind: 'named', name: 'bad-name' }
				}),
				{ repository: 'Bad Name' }
			)
		).toBe(false);
	});
});
