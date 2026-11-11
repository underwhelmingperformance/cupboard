import { rootNameSchema } from '@cupboard/nix-store/scalars';
import { type AuthzMeta } from '@cupboard/protocol/contract';
import { oidcSubjectSchema } from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import { type AccessClaims } from '../auth/auth.ts';
import { InsufficientScopeError } from '../errors.ts';

import {
	authoriseRequest,
	MissingPathCacheError,
	noPendingCache
} from './authorise.ts';

describe('authoriseRequest', () => {
	const wildcardClaims: AccessClaims = {
		subject: oidcSubjectSchema.parse('ci'),
		grants: [{ type: 'cupboard_wildcard' }],
		expiresAt: new Date('2030-01-01T00:00:00Z')
	};

	it('refuses a procedure that reads its cache from the path when the router supplies none', async () => {
		await expect(
			authoriseRequest(
				wildcardClaims,
				{ requires: 'stats:read', resource: { cache: { fromPath: true } } },
				{},
				undefined,
				noPendingCache
			)
		).rejects.toThrow(MissingPathCacheError);
	});

	const everyRootMeta: AuthzMeta = {
		requires: 'root:set',
		resource: {
			cache: { fromPath: true },
			root: { eachIn: 'roots', field: 'name' }
		}
	};
	const rootGrants: AccessClaims['grants'] = [
		{
			type: 'cupboard_cache',
			actions: ['root:set'],
			cache: { kind: 'default' },
			root: rootNameSchema.parse('main/')
		}
	];
	const cacheGrants: AccessClaims['grants'] = [
		{
			type: 'cupboard_cache',
			actions: ['root:set'],
			cache: { kind: 'default' }
		}
	];

	it.each([
		{
			name: 'every root within a root grant',
			grants: rootGrants,
			roots: ['main/a', 'main/b'],
			outcome: 'authorised'
		},
		{
			name: 'one root outside a root grant',
			grants: rootGrants,
			roots: ['main/a', 'other'],
			outcome: 'refused'
		},
		{
			name: 'an invalid root name and a root grant',
			grants: rootGrants,
			roots: ['main/a', ''],
			outcome: 'refused'
		},
		{
			name: 'an invalid root name and a wildcard',
			grants: wildcardClaims.grants,
			roots: ['main/a', ''],
			outcome: 'authorised'
		},
		{
			name: 'no roots and a root grant',
			grants: rootGrants,
			roots: [],
			outcome: 'refused'
		},
		{
			name: 'no roots and a cache-wide grant',
			grants: cacheGrants,
			roots: [],
			outcome: 'authorised'
		}
	])(
		'authorises each root of an input array: $name',
		async ({ grants, roots, outcome }) => {
			const claims: AccessClaims = { ...wildcardClaims, grants };
			let result: unknown = 'authorised';

			try {
				await authoriseRequest(
					claims,
					everyRootMeta,
					{ roots: roots.map((name) => ({ name, targets: [] })) },
					{ kind: 'default' },
					noPendingCache
				);
			} catch (error) {
				result = error instanceof InsufficientScopeError ? 'refused' : error;
			}

			expect(result).toBe(outcome);
		}
	);
});
