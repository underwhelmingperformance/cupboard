import { describe, expect, it } from 'vitest';

import {
	type AuthorizationDetail,
	authorizationDetailCovered,
	authorizationDetailSchema,
	type Operation,
	permittedGrantSchema,
	type ResourceRequest,
	tokenCovers
} from './grants.ts';

// Fixtures are parsed through the schema so the branded cache/root/tenant
// selectors are well-typed (and the schema itself is exercised).
const cacheGrant = authorizationDetailSchema.parse({
	type: 'cupboard_cache',
	actions: ['upload:commit', 'root:set', 'gc:run'],
	cache: 'pr-123',
	root: 'pr-123'
});

const prefixRootGrant = authorizationDetailSchema.parse({
	type: 'cupboard_cache',
	actions: ['root:set'],
	cache: 'main',
	root: 'github:owner/repo/'
});

const domainGrant = authorizationDetailSchema.parse({
	type: 'cupboard_domain',
	actions: ['signing-key:rotate', 'gc:run']
});

const tenantGrant = authorizationDetailSchema.parse({
	type: 'cupboard_tenant',
	actions: ['tenant:suspend'],
	tenant: 'acme'
});

const controlGrant = authorizationDetailSchema.parse({
	type: 'cupboard_control',
	actions: ['control-key:rotate']
});

const wildcard = authorizationDetailSchema.parse({ type: 'cupboard_wildcard' });

describe('tokenCovers', () => {
	it.each<[string, AuthorizationDetail[], Operation, ResourceRequest, boolean]>(
		[
			[
				'cache op on the named cache',
				[cacheGrant],
				'upload:commit',
				{ cache: 'pr-123' },
				true
			],
			[
				'cache op on a different cache',
				[cacheGrant],
				'upload:commit',
				{ cache: 'pr-999' },
				false
			],
			[
				'cache op not in the grant actions',
				[cacheGrant],
				'cache:delete',
				{ cache: 'pr-123' },
				false
			],
			[
				'root:set with the exact root',
				[cacheGrant],
				'root:set',
				{ cache: 'pr-123', root: 'pr-123' },
				true
			],
			[
				'root:set with a non-matching root',
				[cacheGrant],
				'root:set',
				{ cache: 'pr-123', root: 'main' },
				false
			],
			[
				'root:set within a trailing-slash prefix',
				[prefixRootGrant],
				'root:set',
				{ cache: 'main', root: 'github:owner/repo/pr-1' },
				true
			],
			[
				'root:set outside the prefix',
				[prefixRootGrant],
				'root:set',
				{ cache: 'main', root: 'github:owner/other/pr-1' },
				false
			],
			[
				'domain op, deployment-wide',
				[domainGrant],
				'signing-key:rotate',
				{},
				true
			],
			['domain gc:run, deployment-wide', [domainGrant], 'gc:run', {}, true],
			[
				'domain grant does not cover a per-cache gc:run',
				[domainGrant],
				'gc:run',
				{ cache: 'c' },
				false
			],
			[
				'cache grant covers a per-cache gc:run',
				[cacheGrant],
				'gc:run',
				{ cache: 'pr-123' },
				true
			],
			[
				'cache grant does not cover a deployment-wide gc:run',
				[cacheGrant],
				'gc:run',
				{},
				false
			],
			[
				'tenant op on the named tenant',
				[tenantGrant],
				'tenant:suspend',
				{ tenant: 'acme' },
				true
			],
			[
				'tenant op on a different tenant',
				[tenantGrant],
				'tenant:suspend',
				{ tenant: 'other' },
				false
			],
			[
				'control op, resource-free',
				[controlGrant],
				'control-key:rotate',
				{},
				true
			],
			[
				'wildcard covers a cache op',
				[wildcard],
				'upload:commit',
				{ cache: 'x' },
				true
			],
			[
				'wildcard covers a control op',
				[wildcard],
				'tenant:remove',
				{ tenant: 'x' },
				true
			],
			['no grants covers nothing', [], 'upload:commit', { cache: 'x' }, false]
		]
	)('%s', (_name, grants, operation, resource, expected) => {
		expect(tokenCovers(grants, operation, resource)).toBe(expected);
	});
});

describe('authorizationDetailCovered', () => {
	const wildcardOnly = [wildcard];
	const cacheOnly = [cacheGrant];

	it.each<[string, AuthorizationDetail[], AuthorizationDetail, boolean]>([
		[
			'a subset of the presented cache grant is covered',
			cacheOnly,
			authorizationDetailSchema.parse({
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'pr-123',
				root: 'pr-123'
			}),
			true
		],
		[
			'an operation the presented grant lacks is not covered',
			cacheOnly,
			authorizationDetailSchema.parse({
				type: 'cupboard_cache',
				actions: ['narinfo:delete'],
				cache: 'pr-123'
			}),
			false
		],
		[
			'another cache is not covered',
			cacheOnly,
			authorizationDetailSchema.parse({
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				cache: 'pr-999'
			}),
			false
		],
		[
			'a wildcard request needs a presented wildcard',
			cacheOnly,
			wildcard,
			false
		],
		['a presented wildcard covers any detail', wildcardOnly, cacheGrant, true]
	])('%s', (_name, presented, requested, expected) => {
		expect(authorizationDetailCovered(presented, requested)).toBe(expected);
	});
});

describe('authorizationDetailSchema', () => {
	it('accepts a concrete cache grant', () => {
		expect(authorizationDetailSchema.safeParse(cacheGrant).success).toBe(true);
	});

	it('rejects a cache operation under a domain grant', () => {
		expect(
			authorizationDetailSchema.safeParse({
				type: 'cupboard_domain',
				actions: ['upload:commit']
			}).success
		).toBe(false);
	});

	it('rejects an empty actions array', () => {
		expect(
			authorizationDetailSchema.safeParse({
				type: 'cupboard_cache',
				actions: [],
				cache: 'c'
			}).success
		).toBe(false);
	});

	it('accepts a bare wildcard', () => {
		expect(
			authorizationDetailSchema.safeParse({ type: 'cupboard_wildcard' }).success
		).toBe(true);
	});
});

describe('permittedGrantSchema', () => {
	const captureBinding = {
		equalsTemplate: 'pr-{pull_request_number}',
		substitutions: {
			pull_request_number: {
				claim: 'ref',
				capture: {
					pattern: String.raw`^refs/pull/(?<pull_request_number>\d+)/merge$`,
					group: 'pull_request_number'
				}
			}
		},
		validate: 'cacheName'
	};

	it('accepts a templated cache grant with a relational root', () => {
		expect(
			permittedGrantSchema.safeParse({
				type: 'cupboard_cache',
				actions: ['upload:commit', 'root:set'],
				resources: {
					cache: captureBinding,
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			}).success
		).toBe(true);
	});

	it('rejects a binding that sets both equalsTemplate and exact', () => {
		expect(
			permittedGrantSchema.safeParse({
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: {
						equalsTemplate: 'pr-{n}',
						exact: 'pr-1',
						validate: 'cacheName'
					}
				}
			}).success
		).toBe(false);
	});

	it('rejects a template variable with no substitution', () => {
		expect(
			permittedGrantSchema.safeParse({
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: {
					cache: { equalsTemplate: 'pr-{missing}', validate: 'cacheName' }
				}
			}).success
		).toBe(false);
	});

	it('accepts a domain grant with no resources', () => {
		expect(
			permittedGrantSchema.safeParse({
				type: 'cupboard_domain',
				actions: ['signing-key:rotate']
			}).success
		).toBe(true);
	});
});
