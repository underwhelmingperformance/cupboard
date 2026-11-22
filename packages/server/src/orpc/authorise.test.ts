import { rootNameSchema } from '@cupboard/nix-store/scalars';
import { accessKeyIdSchema } from '@cupboard/protocol/access-keys';
import { type AuthzMeta } from '@cupboard/protocol/contract';
import {
	type AuthorizationDetail,
	authorizationDetailSchema,
	type Operation
} from '@cupboard/protocol/grants';
import { oidcSubjectSchema } from '@cupboard/protocol/oidc';
import { type VerifiedOidcClaims } from '@cupboard/protocol/oidc-trust-match';
import { describe, expect, it } from 'vitest';

import { type AccessTokenClaims } from '../auth/auth.ts';
import { recordedOidcIdentity } from '../auth/oidc-identity.ts';
import { type Principal, tokenPrincipal } from '../auth/principal.ts';
import { AccessKeyRefusedError, InsufficientScopeError } from '../errors.ts';

import {
	type AccessKeyGrantsResolver,
	authoriseRequest,
	MissingPathCacheError,
	noPendingCache
} from './authorise.ts';

describe('authoriseRequest', () => {
	const wildcardClaims: AccessTokenClaims = {
		subject: oidcSubjectSchema.parse('ci'),
		grants: [{ type: 'cupboard_wildcard' }],
		expiresAt: new Date('2030-01-01T00:00:00Z')
	};

	it('refuses a procedure that reads its cache from the path when the router supplies none', async () => {
		await expect(
			authoriseRequest(
				tokenPrincipal(wildcardClaims),
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
	const rootGrants: AccessTokenClaims['grants'] = [
		{
			type: 'cupboard_cache',
			actions: ['root:set'],
			cache: { kind: 'default' },
			root: rootNameSchema.parse('main/')
		}
	];
	const cacheGrants: AccessTokenClaims['grants'] = [
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
			const claims = tokenPrincipal({ ...wildcardClaims, grants });
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

function cacheGrant(
	name: string,
	actions: readonly Operation[]
): AuthorizationDetail {
	return authorizationDetailSchema.parse({
		type: 'cupboard_cache',
		cache: { kind: 'named', name },
		actions
	});
}

// Runs the authoriser and reports which decision it made.
async function decision(authorising: Promise<unknown>): Promise<string> {
	try {
		await authorising;

		return 'authorised';
	} catch (error) {
		if (error instanceof AccessKeyRefusedError) {
			return error.problem;
		}

		if (error instanceof InsufficientScopeError) {
			return 'insufficient-scope';
		}

		throw error;
	}
}

function ciIdentity(): VerifiedOidcClaims {
	const identity = recordedOidcIdentity({
		iss: 'https://idp.test',
		sub: 'ci',
		aud: 'cupboard-aud'
	});

	if (identity === undefined) {
		throw new Error('The fixture identity is not a policy identity');
	}

	return identity;
}

describe('authoriseRequest for access keys', () => {
	const expiresAt = new Date('2030-01-01T00:15:00.000Z');
	const withinToken = '2030-01-01T00:10:00.000Z';
	const beyondToken = '2030-01-01T01:00:00.000Z';
	const readBuilds = cacheGrant('builds', ['cache:content-read']);
	const readRelease = cacheGrant('release', ['cache:content-read']);
	const keyCreationInBuilds = cacheGrant('builds', [
		'cache:content-read',
		'access-key:create'
	]);
	const derivation: AuthzMeta = {
		derives: { grantsIn: 'grants', expiresAtIn: 'expiresAt' }
	};

	function claimsWith(
		grants: AuthorizationDetail[]
	): Principal<AccessTokenClaims> {
		return tokenPrincipal({
			subject: oidcSubjectSchema.parse('ci'),
			grants,
			expiresAt
		});
	}

	function keyWith(
		grants: AuthorizationDetail[],
		keyExpiresAt?: Date
	): Principal<AccessTokenClaims> {
		return {
			kind: 'access-key',
			key: {
				id: accessKeyIdSchema.parse('00000000-0000-4000-8000-000000000009'),
				grants,
				...(keyExpiresAt !== undefined && { expiresAt: keyExpiresAt }),
				creatorSubject: oidcSubjectSchema.parse('ci'),
				rootIdentity: ciIdentity()
			}
		};
	}

	it.each<{
		readonly name: string;
		readonly principal: Principal<AccessTokenClaims>;
		readonly input: unknown;
		readonly outcome: string;
	}>([
		{
			name: 'no expiry from a key without one and without access-key:create',
			principal: keyWith([readBuilds]),
			input: { grants: [readBuilds] },
			outcome: 'authorised'
		},
		{
			name: 'any expiry from a key without one and without access-key:create',
			principal: keyWith([readBuilds]),
			input: { grants: [readBuilds], expiresAt: beyondToken },
			outcome: 'authorised'
		},
		{
			name: 'no expiry from an expiring key without access-key:create',
			principal: keyWith([readBuilds], expiresAt),
			input: { grants: [readBuilds] },
			outcome: 'expiry-required'
		},
		{
			name: 'an expiry beyond an expiring key without access-key:create',
			principal: keyWith([readBuilds], expiresAt),
			input: { grants: [readBuilds], expiresAt: beyondToken },
			outcome: 'expiry-beyond-creator'
		},
		{
			name: 'a grant that the key does not have',
			principal: keyWith([readBuilds]),
			input: { grants: [readRelease] },
			outcome: 'grants-not-covered'
		}
	])(
		'decides a key derived by a key with $name',
		async ({ principal, input, outcome }) => {
			const authorised = authoriseRequest(
				principal,
				derivation,
				input,
				undefined,
				noPendingCache
			);

			expect(await decision(authorised)).toBe(outcome);
		}
	);

	it.each<{
		readonly name: string;
		readonly grants: AuthorizationDetail[];
		readonly input: unknown;
		readonly outcome: string;
	}>([
		{
			name: 'an expiry within the token without access-key:create',
			grants: [readBuilds],
			input: { grants: [readBuilds], expiresAt: withinToken },
			outcome: 'authorised'
		},
		{
			name: 'an expiry beyond the token without access-key:create',
			grants: [readBuilds],
			input: { grants: [readBuilds], expiresAt: beyondToken },
			outcome: 'expiry-beyond-creator'
		},
		{
			name: 'no expiry without access-key:create',
			grants: [readBuilds],
			input: { grants: [readBuilds] },
			outcome: 'expiry-required'
		},
		{
			name: 'an expiry beyond the token with access-key:create',
			grants: [keyCreationInBuilds],
			input: { grants: [readBuilds], expiresAt: beyondToken },
			outcome: 'authorised'
		},
		{
			name: 'no expiry with access-key:create',
			grants: [keyCreationInBuilds],
			input: { grants: [readBuilds] },
			outcome: 'authorised'
		},
		{
			name: 'no expiry with access-key:create for only some grants',
			grants: [keyCreationInBuilds, readRelease],
			input: { grants: [readBuilds, readRelease] },
			outcome: 'expiry-required'
		},
		{
			name: 'a grant that the token does not have',
			grants: [keyCreationInBuilds],
			input: { grants: [readBuilds, readRelease] },
			outcome: 'grants-not-covered'
		},
		{
			name: 'an action that the token does not have',
			grants: [keyCreationInBuilds],
			input: {
				grants: [cacheGrant('builds', ['upload:commit'])],
				expiresAt: withinToken
			},
			outcome: 'grants-not-covered'
		},
		{
			name: 'malformed grants and a scoped token',
			grants: [keyCreationInBuilds],
			input: { grants: [{ type: 'unknown' }] },
			outcome: 'insufficient-scope'
		}
	])('decides a key with $name', async ({ grants, input, outcome }) => {
		const authorised = authoriseRequest(
			claimsWith(grants),
			derivation,
			input,
			undefined,
			noPendingCache
		);

		expect(await decision(authorised)).toBe(outcome);
	});

	const keyGrants = [readBuilds, readRelease];
	const resolver: AccessKeyGrantsResolver = (id) =>
		Promise.resolve(id === 'known' ? keyGrants : undefined);

	it.each<{
		readonly name: string;
		readonly grants: AuthorizationDetail[];
		readonly id: string;
		readonly outcome: string;
	}>([
		{
			name: 'a caller who can delete every grant of the key',
			grants: [
				cacheGrant('builds', ['access-key:delete']),
				cacheGrant('release', ['access-key:delete'])
			],
			id: 'known',
			outcome: 'authorised'
		},
		{
			name: 'a caller who can delete only some grants of the key',
			grants: [cacheGrant('builds', ['access-key:delete'])],
			id: 'known',
			outcome: 'insufficient-scope'
		},
		{
			name: 'an unknown key and a caller with access-key:delete',
			grants: [cacheGrant('builds', ['access-key:delete'])],
			id: 'unknown',
			outcome: 'authorised'
		},
		{
			name: 'an unknown key and a caller without access-key:delete',
			grants: [readBuilds],
			id: 'unknown',
			outcome: 'insufficient-scope'
		}
	])('decides a deletion for $name', async ({ grants, id, outcome }) => {
		const authorised = authoriseRequest(
			claimsWith(grants),
			{
				requires: 'access-key:delete',
				resource: { accessKey: { field: 'id' } }
			},
			{ id },
			undefined,
			noPendingCache,
			resolver
		);

		expect(await decision(authorised)).toBe(outcome);
	});

	it.each([
		{
			name: 'its own id',
			id: '00000000-0000-4000-8000-000000000009',
			outcome: 'authorised'
		},
		{ name: 'another key', id: 'known', outcome: 'insufficient-scope' }
	])(
		'decides a key without access-key:delete deleting $name',
		async ({ id, outcome }) => {
			const authorised = authoriseRequest(
				keyWith([readBuilds]),
				{
					requires: 'access-key:delete',
					resource: { accessKey: { field: 'id', self: true } }
				},
				{ id },
				undefined,
				noPendingCache,
				resolver
			);

			expect(await decision(authorised)).toBe(outcome);
		}
	);

	it.each([
		{
			name: 'a caller with access-key:list for one cache',
			grants: [cacheGrant('builds', ['access-key:list'])],
			outcome: 'authorised'
		},
		{
			name: 'a caller without access-key:list',
			grants: [readBuilds],
			outcome: 'insufficient-scope'
		}
	])('decides a listing for $name', async ({ grants, outcome }) => {
		const authorised = authoriseRequest(
			claimsWith(grants),
			{
				requires: 'access-key:list',
				resource: { accessKey: { listed: true } }
			},
			{},
			undefined,
			noPendingCache
		);

		expect(await decision(authorised)).toBe(outcome);
	});
});
