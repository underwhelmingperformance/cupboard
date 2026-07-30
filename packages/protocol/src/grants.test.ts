import {
	cacheSelectorSchema,
	rootNameSchema,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	type AuthorizationDetail,
	authorizationDetailSchema,
	isAuthorizationDetailCovered,
	isCoveredByToken,
	isOperationPermittedAtIssuance,
	isOperationSatisfiedByPresentedActions,
	type Operation,
	operationSchema,
	permittedGrantSchema,
	type ResourceRequest,
	storedPermittedGrantsSchema
} from './grants.ts';

interface ResourceFields {
	cache?: string;
	root?: string;
	tenant?: string;
}

// The concrete resource a route resolves, with each field parsed through its
// scalar schema so it carries the brand the resolver produces.
function resource(fields: ResourceFields): ResourceRequest {
	return {
		...(fields.cache !== undefined && {
			cache: cacheSelectorSchema.parse(fields.cache)
		}),
		...(fields.root !== undefined && {
			root: rootNameSchema.parse(fields.root)
		}),
		...(fields.tenant !== undefined && {
			tenant: tenantIdSchema.parse(fields.tenant)
		})
	};
}

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

const attachRootGrant = authorizationDetailSchema.parse({
	type: 'cupboard_cache',
	actions: ['root:attach'],
	cache: 'main',
	root: 'ci'
});

const prefixAttachRootGrant = authorizationDetailSchema.parse({
	type: 'cupboard_cache',
	actions: ['root:attach'],
	cache: 'main',
	root: 'github:owner/repo/'
});

const domainGrant = authorizationDetailSchema.parse({
	type: 'cupboard_domain',
	actions: ['signing-key:rotate', 'gc:run']
});

const reuseViewGrant = authorizationDetailSchema.parse({
	type: 'cupboard_domain',
	actions: ['reuse-view:set']
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

describe('isOperationPermittedAtIssuance', () => {
	it.each<[string, Operation[], Operation, boolean]>([
		[
			'a negotiate action permits a requested preview',
			['upload:negotiate'],
			'upload:preview',
			true
		],
		[
			'a preview action does not permit a requested negotiate',
			['upload:preview'],
			'upload:negotiate',
			false
		],
		[
			'a preview action permits a requested preview',
			['upload:preview'],
			'upload:preview',
			true
		],
		[
			'a negotiate action permits a requested negotiate',
			['upload:negotiate'],
			'upload:negotiate',
			true
		],
		[
			'an unrelated action set does not permit a requested preview',
			['upload:commit'],
			'upload:preview',
			false
		],
		[
			'a negotiate action does not permit an unrelated requested operation',
			['upload:negotiate'],
			'upload:commit',
			false
		],
		[
			'a commit action does not permit a requested confirm',
			['upload:commit'],
			'upload:confirm',
			false
		],
		[
			'a confirm action does not permit a requested commit',
			['upload:confirm'],
			'upload:commit',
			false
		],
		[
			'a confirm action permits a requested confirm',
			['upload:confirm'],
			'upload:confirm',
			true
		],
		[
			'a negotiate action does not permit a requested confirm',
			['upload:negotiate'],
			'upload:confirm',
			false
		]
	])('%s', (_name, actions, operation, expected) => {
		expect(isOperationPermittedAtIssuance(actions, operation)).toBe(expected);
	});
});

describe('isOperationSatisfiedByPresentedActions', () => {
	it.each<[string, Operation[], Operation, boolean]>([
		[
			'a negotiate action covers a requested preview',
			['upload:negotiate'],
			'upload:preview',
			true
		],
		[
			'a preview action does not cover a requested negotiate',
			['upload:preview'],
			'upload:negotiate',
			false
		],
		[
			'a preview action covers a requested preview',
			['upload:preview'],
			'upload:preview',
			true
		],
		[
			'a negotiate action covers a requested negotiate',
			['upload:negotiate'],
			'upload:negotiate',
			true
		],
		[
			'an unrelated action set does not cover a requested preview',
			['upload:commit'],
			'upload:preview',
			false
		],
		[
			'a negotiate action does not cover an unrelated requested operation',
			['upload:negotiate'],
			'upload:commit',
			false
		],
		[
			'a commit action does not cover a requested confirm at runtime',
			['upload:commit'],
			'upload:confirm',
			false
		],
		[
			'a confirm action does not cover a requested commit',
			['upload:confirm'],
			'upload:commit',
			false
		],
		[
			'a confirm action covers a requested confirm',
			['upload:confirm'],
			'upload:confirm',
			true
		],
		[
			'a negotiate action does not cover a requested confirm',
			['upload:negotiate'],
			'upload:confirm',
			false
		]
	])('%s', (_name, actions, operation, expected) => {
		expect(isOperationSatisfiedByPresentedActions(actions, operation)).toBe(
			expected
		);
	});
});

// `root:attach` retains paths under a name, which no other operation does, so
// neither implication table may map it to a broader operation. The sweep pins
// that structurally: across every operation, the only single-action set that
// reaches a requested `root:attach` is `root:attach` itself.
describe('root:attach implication', () => {
	it.each<
		[string, (actions: readonly Operation[], operation: Operation) => boolean]
	>([
		['at issuance', isOperationPermittedAtIssuance],
		['by presented authority', isOperationSatisfiedByPresentedActions]
	])('is reached only by its own action %s', (_name, isImplied) => {
		const reaching = operationSchema.options.filter((operation) =>
			isImplied([operation], 'root:attach')
		);

		expect(reaching).toStrictEqual(['root:attach']);
	});
});

describe('isCoveredByToken', () => {
	it.each<[string, AuthorizationDetail[], Operation, ResourceFields, boolean]>([
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
			'root:attach with the exact root',
			[attachRootGrant],
			'root:attach',
			{ cache: 'main', root: 'ci' },
			true
		],
		[
			'root:attach with a non-matching root',
			[attachRootGrant],
			'root:attach',
			{ cache: 'main', root: 'other' },
			false
		],
		[
			'root:attach within a trailing-slash prefix',
			[prefixAttachRootGrant],
			'root:attach',
			{ cache: 'main', root: 'github:owner/repo/pr-1' },
			true
		],
		[
			'root:attach outside the prefix',
			[prefixAttachRootGrant],
			'root:attach',
			{ cache: 'main', root: 'github:owner/other/pr-1' },
			false
		],
		[
			'a commit grant does not cover root:attach on its own root',
			[cacheGrant],
			'root:attach',
			{ cache: 'pr-123', root: 'pr-123' },
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
			'domain reuse-view:set, deployment-wide',
			[reuseViewGrant],
			'reuse-view:set',
			{},
			true
		],
		[
			'domain reuse-view:set does not cover a per-cache resource',
			[reuseViewGrant],
			'reuse-view:set',
			{ cache: 'c' },
			false
		],
		[
			'domain reuse-view:set does not cover a different reuse-view op',
			[reuseViewGrant],
			'reuse-view:remove',
			{},
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
			'a negotiate grant covers a requested preview on the same cache',
			[
				authorizationDetailSchema.parse({
					type: 'cupboard_cache',
					actions: ['upload:negotiate'],
					cache: 'pr-123'
				})
			],
			'upload:preview',
			{ cache: 'pr-123' },
			true
		],
		[
			'a preview-only grant does not cover a requested negotiate',
			[
				authorizationDetailSchema.parse({
					type: 'cupboard_cache',
					actions: ['upload:preview'],
					cache: 'pr-123'
				})
			],
			'upload:negotiate',
			{ cache: 'pr-123' },
			false
		],
		[
			'a commit grant does not cover a requested confirm on the same cache',
			[cacheGrant],
			'upload:confirm',
			{ cache: 'pr-123' },
			false
		],
		[
			'a confirm-only grant does not cover a requested commit',
			[
				authorizationDetailSchema.parse({
					type: 'cupboard_cache',
					actions: ['upload:confirm'],
					cache: 'pr-123'
				})
			],
			'upload:commit',
			{ cache: 'pr-123' },
			false
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
	])('%s', (_name, grants, operation, resourceFields, expected) => {
		expect(isCoveredByToken(grants, operation, resource(resourceFields))).toBe(
			expected
		);
	});
});

describe('isAuthorizationDetailCovered', () => {
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
		expect(isAuthorizationDetailCovered(presented, requested)).toBe(expected);
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

describe('storedPermittedGrantsSchema', () => {
	const cacheResources = {
		cache: { exact: 'owner-ci', validate: 'cacheName' }
	};

	it('strips a retired action a rule was persisted with', () => {
		const parsed = storedPermittedGrantsSchema.parse([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:prepare', 'upload:commit'],
				resources: cacheResources
			}
		]);

		expect(parsed).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:negotiate', 'upload:commit'],
				resources: cacheResources
			}
		]);
	});

	it('drops a grant left with no recognised action', () => {
		const parsed = storedPermittedGrantsSchema.parse([
			{
				type: 'cupboard_cache',
				actions: ['attestation:prepare'],
				resources: cacheResources
			},
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: cacheResources
			}
		]);

		expect(parsed).toStrictEqual([
			{
				type: 'cupboard_cache',
				actions: ['upload:commit'],
				resources: cacheResources
			}
		]);
	});

	it('passes a wildcard grant through untouched', () => {
		const grants = [{ type: 'cupboard_wildcard' }];

		expect(storedPermittedGrantsSchema.parse(grants)).toStrictEqual(grants);
	});
});
