import {
	type AuthorizationDetail,
	authorizationDetailSchema,
	type PermittedGrant,
	permittedGrantSchema
} from '@cupboard/protocol/grants';
import { describe, expect, it } from 'vitest';

import { type OidcClaims } from '../oidc/oidc-trust.ts';

import { isGrantPermittedByRule } from './bindings.ts';

function grant(value: unknown): PermittedGrant {
	return permittedGrantSchema.parse(value);
}

function request(value: unknown): AuthorizationDetail {
	return authorizationDetailSchema.parse(value);
}

const wildcard = grant({ type: 'cupboard_wildcard' });

// A cache bound to the PR number captured from a GitHub `ref` claim, with the
// root tied to the same cache.
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
			validate: 'cacheName'
		},
		root: { equalsResource: 'cache', validate: 'rootName' }
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
				cache: 'anything'
			},
			claims: {},
			expected: true
		},
		{
			name: 'a template binding permits the rendered cache',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'pr-123'
			},
			claims: prClaims,
			expected: true
		},
		{
			name: 'a template binding refuses a different cache',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'pr-456'
			},
			claims: prClaims,
			expected: false
		},
		{
			name: 'a binding refuses when the claim is absent',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'pr-123'
			},
			claims: { iss: 'x' },
			expected: false
		},
		{
			name: 'a binding refuses when the capture does not match',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'pr-123'
			},
			claims: { ref: 'refs/heads/main' },
			expected: false
		},
		{
			name: 'an action outside the permitted set is refused',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['gc:run'],
				cache: 'pr-123'
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
					resources: { cache: { exact: 'pr-123', validate: 'cacheName' } }
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:preview'],
				cache: 'pr-123'
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
					resources: { cache: { exact: 'pr-123', validate: 'cacheName' } }
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:negotiate'],
				cache: 'pr-123'
			},
			claims: {},
			expected: false
		},
		{
			name: 'a same-as-cache root permits the cache as the root',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: 'pr-123',
				root: 'pr-123'
			},
			claims: prClaims,
			expected: true
		},
		{
			name: 'a same-as-cache root refuses a different root',
			permitted: [prCacheGrant],
			requested: {
				type: 'cupboard_cache',
				actions: ['root:set'],
				cache: 'pr-123',
				root: 'main'
			},
			claims: prClaims,
			expected: false
		},
		{
			name: 'an exact default-cache binding permits the default cache',
			permitted: [
				grant({
					type: 'cupboard_cache',
					actions: ['upload:commit'],
					resources: { cache: { exact: '_default', validate: 'cacheName' } }
				})
			],
			requested: {
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: '_default'
			},
			claims: {},
			expected: true
		},
		{
			name: 'a domain grant covers its domain operation',
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

	it('refuses a rendered cache that escapes the cache grammar', () => {
		// The template renders a claim verbatim; a value with a space or capital
		// fails `cacheNamePattern`, so the binding yields nothing and refuses every
		// request, issuing nothing against an invalid cache name.
		const verbatimGrant = grant({
			type: 'cupboard_cache',
			actions: ['upload:commit'],
			resources: {
				cache: {
					equalsTemplate: '{name}',
					substitutions: { name: { claim: 'repository' } },
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
					cache: 'bad-name'
				}),
				{ repository: 'Bad Name' }
			)
		).toBe(false);
	});
});
