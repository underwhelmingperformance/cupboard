import { cacheNameSchema, rootNameSchema } from '@cupboard/nix-store/scalars';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
	type AuthorizationDetails,
	authorizationDetailsSchema,
	cacheOperations
} from './grants.ts';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	trustRuleIdSchema
} from './oidc.ts';
import { selectModelledOidcTrust } from './oidc-trust-diagnostics.ts';
import {
	type OidcClaims,
	type OidcTrustRule,
	type VerifiedOidcClaims
} from './oidc-trust-match.ts';
import {
	type OidcTrustSelection,
	selectOidcTrust
} from './oidc-trust-selection.ts';

const issuer = oidcIssuerSchema.parse(
	'https://token.actions.githubusercontent.com'
);
const audience = oidcAudienceSchema.parse('https://cache.example.workers.dev');
const claims = {
	iss: issuer,
	aud: audience,
	repository_owner_id: '5678',
	repository_id: '1234'
};

type CacheOperation = (typeof cacheOperations)[number];

function rule(options: {
	readonly id: string;
	readonly cache: string;
	readonly actions?: readonly CacheOperation[];
	readonly root?: string;
	readonly claims?: Readonly<Record<string, string>>;
}): OidcTrustRule {
	return {
		id: trustRuleIdSchema.parse(options.id),
		issuer,
		audience,
		claims: options.claims ?? {
			repository_owner_id: '5678',
			repository_id: '1234'
		},
		permittedGrants: [
			{
				type: 'cupboard_cache',
				actions: [...(options.actions ?? ['upload:commit'])],
				resources: {
					cache: {
						kind: 'named',
						exact: cacheNameSchema.parse(options.cache),
						validate: 'cacheName'
					},
					...(options.root !== undefined && {
						root: {
							exact: rootNameSchema.parse(options.root),
							validate: 'rootName' as const
						}
					})
				}
			}
		]
	};
}

function request(
	cache: string,
	actions: readonly CacheOperation[] = ['upload:commit'],
	root?: string
): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions,
			cache: { kind: 'named', name: cache },
			...(root !== undefined && { root })
		}
	]);
}

function result(selection: OidcTrustSelection): {
	readonly outcome: OidcTrustSelection['outcome'];
	readonly rules: readonly string[];
	readonly uncovered?: AuthorizationDetails;
} {
	switch (selection.outcome) {
		case 'selected': {
			return {
				outcome: selection.outcome,
				rules: selection.rule === undefined ? [] : [selection.rule.id]
			};
		}
		case 'identity-unmatched': {
			return { outcome: selection.outcome, rules: [] };
		}
		case 'authority-unmatched': {
			return {
				outcome: selection.outcome,
				rules: selection.rules.map(({ id }) => id),
				uncovered: [...selection.uncovered]
			};
		}
		case 'ambiguous': {
			return {
				outcome: selection.outcome,
				rules: selection.rules.map(({ id }) => id)
			};
		}
	}
}

function modelledResult(
	rules: readonly OidcTrustRule[],
	requested: AuthorizationDetails | undefined,
	modelledClaims: OidcClaims = claims
): ReturnType<typeof result> {
	return result(selectModelledOidcTrust(rules, modelledClaims, requested));
}

describe('selectModelledOidcTrust', () => {
	it('keeps decoded claims outside the authority-selection type', () => {
		expectTypeOf<OidcClaims>().not.toExtend<VerifiedOidcClaims>();
		expectTypeOf(selectOidcTrust)
			.parameter(1)
			.toEqualTypeOf<VerifiedOidcClaims>();
	});

	it('uses the requested cache to distinguish equally specific rules', () => {
		const cacheA = rule({ id: 'cache-a', cache: 'a' });
		const cacheB = rule({ id: 'cache-b', cache: 'b' });

		expect({
			forward: modelledResult([cacheA, cacheB], request('b')),
			reversed: modelledResult([cacheB, cacheA], request('b'))
		}).toStrictEqual({
			forward: { outcome: 'selected', rules: ['cache-b'] },
			reversed: { outcome: 'selected', rules: ['cache-b'] }
		});
	});

	it('uses the requested operation to distinguish equally specific rules', () => {
		const commit = rule({ id: 'commit', cache: 'ci' });
		const collect = rule({ id: 'collect', cache: 'ci', actions: ['gc:run'] });

		expect(
			modelledResult([commit, collect], request('ci', ['gc:run']))
		).toStrictEqual({ outcome: 'selected', rules: ['collect'] });
	});

	it('uses the requested root to distinguish equally specific rules', () => {
		const main = rule({
			id: 'main',
			cache: 'ci',
			actions: ['upload:commit', 'root:set'],
			root: 'github:acme/main/'
		});
		const release = rule({
			id: 'release',
			cache: 'ci',
			actions: ['upload:commit', 'root:set'],
			root: 'github:acme/release/'
		});

		const requested = request('ci', ['root:set'], 'github:acme/release/x');

		expect(modelledResult([main, release], requested)).toStrictEqual({
			outcome: 'selected',
			rules: ['release']
		});

		expect(
			modelledResult(
				[main, release],
				request('ci', ['upload:commit'], 'github:acme/release/x')
			)
		).toStrictEqual({ outcome: 'selected', rules: ['main'] });
	});

	it('composes one exact request from separate rules', () => {
		const cacheA = rule({ id: 'cache-a', cache: 'a' });
		const cacheB = rule({ id: 'cache-b', cache: 'b' });
		const requested = [...request('a'), ...request('b')];

		expect(modelledResult([cacheB, cacheA], requested)).toStrictEqual({
			outcome: 'selected',
			rules: []
		});
	});

	it('selects a deterministic audit rule for overlapping authority', () => {
		const first = rule({ id: 'first', cache: 'ci' });
		const second = rule({ id: 'second', cache: 'ci' });

		expect(modelledResult([second, first], request('ci'))).toStrictEqual({
			outcome: 'selected',
			rules: ['first']
		});
	});

	it.each(['same-rule', 'different-rules'] as const)(
		'composes actions split across grants in %s',
		(type) => {
			const upload = rule({ id: 'upload', cache: 'ci' });
			const retain = rule({
				id: 'retain',
				cache: 'ci',
				actions: ['root:set'],
				root: 'run/'
			});
			const rules =
				type === 'same-rule'
					? [
							{
								...upload,
								permittedGrants: [
									...upload.permittedGrants,
									...retain.permittedGrants
								]
							}
						]
					: [upload, retain];
			const requested = request('ci', ['upload:commit', 'root:set'], 'run/1');
			expect(modelledResult(rules, requested)).toStrictEqual({
				outcome: 'selected',
				rules: type === 'same-rule' ? ['upload'] : []
			});
		}
	);

	it('reports missing actions without partially granting the request', () => {
		const upload = rule({ id: 'upload', cache: 'ci' });
		const requested = request('ci', ['upload:commit', 'root:set'], 'run/1');
		expect(modelledResult([upload], requested)).toStrictEqual({
			outcome: 'authority-unmatched',
			rules: ['upload'],
			uncovered: request('ci', ['root:set'], 'run/1')
		});
	});

	it('does not combine root authority for different resource bindings', () => {
		const upload = rule({ id: 'upload', cache: 'ci' });
		const retain = rule({
			id: 'retain',
			cache: 'ci',
			actions: ['root:set'],
			root: 'other/'
		});
		expect(
			modelledResult(
				[upload, retain],
				request('ci', ['upload:commit', 'root:set'], 'run/1')
			)
		).toStrictEqual({
			outcome: 'authority-unmatched',
			rules: ['retain', 'upload'],
			uncovered: request('ci', ['root:set'], 'run/1')
		});
	});

	it('keeps one complete audit rule when earlier rules cover only part of an existing request', () => {
		const partial = rule({ id: 'a-partial', cache: 'a' });
		const complete = {
			...rule({ id: 'z-complete', cache: 'a' }),
			permittedGrants: [
				...partial.permittedGrants,
				...rule({ id: 'b', cache: 'b' }).permittedGrants
			]
		};
		expect(
			modelledResult([partial, complete], [...request('a'), ...request('b')])
		).toStrictEqual({ outcome: 'selected', rules: ['z-complete'] });
	});

	it('does not fall back past a more specific identity tier', () => {
		const broad = rule({
			id: 'broad',
			cache: 'b',
			claims: { repository_owner_id: '5678' }
		});
		const specific = rule({ id: 'specific', cache: 'a' });

		expect(modelledResult([broad, specific], request('b'))).toStrictEqual({
			outcome: 'authority-unmatched',
			rules: ['specific'],
			uncovered: request('b')
		});
	});

	it('preserves interactive-rule precedence', () => {
		const interactive: OidcTrustRule = {
			id: trustRuleIdSchema.parse('owner'),
			issuer,
			audience,
			claims: { repository_owner_id: '5678' },
			permittedGrants: [{ type: 'cupboard_wildcard' }]
		};
		const ci = rule({ id: 'ci', cache: 'ci' });

		expect(modelledResult([ci, interactive], request('ci'))).toStrictEqual({
			outcome: 'selected',
			rules: ['owner']
		});
	});

	it('distinguishes an identity mismatch from a tied identity tier', () => {
		const cacheA = rule({ id: 'cache-a', cache: 'a' });
		const cacheB = rule({ id: 'cache-b', cache: 'b' });

		expect({
			unmatched: modelledResult([cacheA], request('a'), {
				...claims,
				repository_id: '9999'
			}),
			noRequest: modelledResult([cacheA, cacheB], undefined),
			emptyRequest: modelledResult([cacheA, cacheB], [])
		}).toStrictEqual({
			unmatched: { outcome: 'identity-unmatched', rules: [] },
			noRequest: {
				outcome: 'ambiguous',
				rules: ['cache-a', 'cache-b']
			},
			emptyRequest: {
				outcome: 'ambiguous',
				rules: ['cache-a', 'cache-b']
			}
		});
	});
});
