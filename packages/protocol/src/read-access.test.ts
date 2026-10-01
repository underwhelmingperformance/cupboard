import {
	cacheNameSchema,
	cachePrioritySchema
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	trustRuleIdSchema
} from './oidc.ts';
import { type OidcClaims, type OidcTrustRule } from './oidc-trust-match.ts';
import {
	readAccessFactsSchema,
	readResourcesSchema,
	type ReadResourceState,
	resolveReadAuthority,
	selectReadTrust
} from './read-access.ts';
import { reuseViewNameSchema } from './reuse-views.ts';

const cache = { kind: 'named' as const, name: cacheNameSchema.parse('builds') };
const claims: OidcClaims = {
	iss: 'https://idp.example',
	aud: 'ci',
	sub: 'job'
};
const rule: OidcTrustRule = {
	id: trustRuleIdSchema.parse('ci'),
	issuer: oidcIssuerSchema.parse('https://idp.example'),
	audience: oidcAudienceSchema.parse('ci'),
	claims: { sub: 'job' },
	permittedGrants: [
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate'],
			resources: {
				cache: { kind: 'named', exact: 'builds', validate: 'cacheName' }
			}
		}
	]
};

describe('read authority', () => {
	it.each(['pr-123', 'pr-456', 'default'] as const)(
		'confines implied metadata to the templated cache scope: %s',
		(scope) => {
			const templated: OidcTrustRule = {
				...rule,
				permittedGrants: [
					{
						type: 'cupboard_cache',
						actions: ['root:set'],
						resources: {
							cache: {
								kind: 'named',
								equalsTemplate: 'pr-{ref}',
								substitutions: {
									ref: {
										claim: 'ref',
										capture: {
											pattern: '^refs/pull/(?<ref>[0-9]+)/merge$',
											group: 'ref'
										}
									}
								},
								validate: 'cacheName'
							},
							root: { exact: 'github:acme/app/', validate: 'rootName' }
						}
					}
				]
			};
			const selectedCache =
				scope === 'default'
					? { kind: 'default' as const }
					: { kind: 'named' as const, name: cacheNameSchema.parse(scope) };
			const resource: ReadResourceState = {
				type: 'cupboard_cache',
				cache: selectedCache,
				mode: 'content',
				state: { kind: 'absent' }
			};

			expect(
				resolveReadAuthority(
					templated,
					{ ...claims, ref: 'refs/pull/123/merge' },
					[resource]
				)
			).toStrictEqual(
				scope === 'pr-123'
					? [
							{
								type: 'cupboard_cache',
								cache: selectedCache,
								actions: ['cache:read']
							}
						]
					: undefined
			);
		}
	);

	it.each(['public', 'private', 'absent'] as const)(
		'includes permitted content authority for a %s cache',
		(access) => {
			const readable: OidcTrustRule = {
				...rule,
				permittedGrants: [
					{
						type: 'cupboard_cache',
						actions: ['cache:content-read'],
						resources: {
							cache: { kind: 'named', exact: 'builds', validate: 'cacheName' }
						}
					}
				]
			};
			const resource: ReadResourceState = {
				type: 'cupboard_cache',
				cache,
				mode: 'content',
				state:
					access === 'absent'
						? { kind: 'absent' }
						: {
								kind: 'existing',
								access,
								priority: cachePrioritySchema.parse(40)
							}
			};

			expect(resolveReadAuthority(readable, claims, [resource])).toStrictEqual([
				{ type: 'cupboard_cache', cache, actions: ['cache:content-read'] }
			]);
		}
	);

	it('issues only metadata when a static credential supplies private content access', () => {
		const resource: ReadResourceState = {
			type: 'cupboard_cache',
			cache,
			mode: 'metadata',
			state: {
				kind: 'existing',
				access: 'private',
				priority: cachePrioritySchema.parse(40)
			}
		};

		expect(resolveReadAuthority(rule, claims, [resource])).toStrictEqual([
			{ type: 'cupboard_cache', cache, actions: ['cache:read'] }
		]);
	});

	it('refuses metadata and content outside the exact cache binding', () => {
		const resource: ReadResourceState = {
			type: 'cupboard_cache',
			cache: { kind: 'named', name: cacheNameSchema.parse('other') },
			mode: 'content',
			state: { kind: 'absent' }
		};

		expect(resolveReadAuthority(rule, claims, [resource])).toBeUndefined();
	});

	it('rejects ambiguous public rules even when only one permits optional content access', () => {
		const publicCache: ReadResourceState = {
			type: 'cupboard_cache',
			cache,
			mode: 'content',
			state: {
				kind: 'existing',
				access: 'public',
				priority: cachePrioritySchema.parse(40)
			}
		};
		const other: OidcTrustRule = {
			...rule,
			id: trustRuleIdSchema.parse('other'),
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					resources: {
						cache: { kind: 'named', exact: 'builds', validate: 'cacheName' }
					}
				}
			]
		};

		expect(selectReadTrust([rule, other], claims, [publicCache])).toStrictEqual(
			{ outcome: 'ambiguous', rules: [rule, other] }
		);
	});

	it('does not combine cache and view authority from different rules', () => {
		const view = reuseViewNameSchema.parse('prior');
		const viewRule: OidcTrustRule = {
			...rule,
			id: trustRuleIdSchema.parse('view'),
			permittedGrants: [
				{
					type: 'cupboard_view',
					actions: ['view:content-read'],
					resources: { view: { exact: view, validate: 'reuseViewName' } }
				}
			]
		};
		const resources: ReadResourceState[] = [
			{
				type: 'cupboard_cache',
				cache,
				mode: 'content',
				state: { kind: 'absent' }
			},
			{
				type: 'cupboard_view',
				view,
				state: {
					kind: 'existing',
					access: 'private',
					priority: cachePrioritySchema.parse(80)
				}
			}
		];

		expect(selectReadTrust([rule, viewRule], claims, resources)).toStrictEqual({
			outcome: 'authority-unmatched',
			rules: [rule, viewRule],
			uncovered: []
		});
	});

	it('preserves identity precedence when a narrower rule lacks private read authority', () => {
		const broader: OidcTrustRule = {
			...rule,
			claims: {},
			permittedGrants: [
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					resources: {
						cache: { kind: 'named', exact: 'builds', validate: 'cacheName' }
					}
				}
			]
		};
		const resource: ReadResourceState = {
			type: 'cupboard_cache',
			cache,
			mode: 'content',
			state: {
				kind: 'existing',
				access: 'private',
				priority: cachePrioritySchema.parse(40)
			}
		};

		expect(selectReadTrust([rule, broader], claims, [resource])).toStrictEqual({
			outcome: 'authority-unmatched',
			rules: [rule],
			uncovered: [
				{ type: 'cupboard_cache', cache, actions: ['cache:content-read'] }
			]
		});
	});

	it.each([
		{ state: 'public', expected: [] },
		{ state: 'private', expected: undefined },
		{
			state: 'absent',
			expected: [{ type: 'cupboard_cache', cache, actions: ['cache:read'] }]
		}
	] as const)(
		'resolves $state access without granting private content',
		({ state, expected }) => {
			const resource: ReadResourceState = {
				type: 'cupboard_cache',
				cache,
				mode: 'content',
				state:
					state === 'absent'
						? { kind: 'absent' }
						: {
								kind: 'existing',
								access: state,
								priority: cachePrioritySchema.parse(40)
							}
			};
			expect(resolveReadAuthority(rule, claims, [resource])).toStrictEqual(
				expected
			);
		}
	);
});

describe('read resource batches', () => {
	const cacheResource = {
		type: 'cupboard_cache' as const,
		cache,
		mode: 'content' as const
	};
	const extraResource = {
		...cacheResource,
		cache: { kind: 'named' as const, name: cacheNameSchema.parse('falcon') }
	};
	const viewResource = {
		type: 'cupboard_view' as const,
		view: reuseViewNameSchema.parse('prior')
	};

	it('accepts several caches and one view in a single bounded read session', () => {
		const resources = [cacheResource, extraResource, viewResource];
		const facts = resources.map((resource) => ({
			...resource,
			state: { kind: 'absent' as const }
		}));
		expect({
			resources: readResourcesSchema.parse(resources),
			facts: readAccessFactsSchema.parse(facts)
		}).toStrictEqual({ resources, facts });
	});

	it.each([
		{
			description: 'duplicate caches with conflicting modes',
			resources: [cacheResource, { ...cacheResource, mode: 'metadata' }]
		},
		{
			description: 'multiple views',
			resources: [viewResource, { ...viewResource, view: 'other' }]
		},
		{
			description: 'more than sixteen resources',
			resources: Array.from({ length: 17 }, (_, index) => ({
				...cacheResource,
				cache: { kind: 'named', name: `cache-${String(index)}` }
			}))
		}
	])('rejects $description', ({ resources }) => {
		expect(() => readResourcesSchema.parse(resources)).toThrow();
	});
});
