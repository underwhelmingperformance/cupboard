import {
	cacheNameSchema,
	type CacheScope,
	firstCacheGeneration
} from '@cupboard/nix-store/scalars';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import { readUserSchema } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import {
	type TenantEntry,
	type TenantReadVerifier
} from '../control/tenant-membership.ts';

import { guardScopedRead, type ReadScope } from './read.ts';
import { hashReadPassword, readPasswordSaltSchema } from './read-auth.ts';

const tenantPassword = 'tenant-password';
const cachePassword = 'cache-password';

const defaultCache: CacheScope = { kind: 'default' };
const namedCache: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('builds')
};
const publicScope: ReadScope = {
	scope: defaultCache,
	access: 'public',
	generation: firstCacheGeneration
};
const privateScope: ReadScope = {
	scope: namedCache,
	access: 'private',
	generation: firstCacheGeneration
};

async function verifier(
	user: string,
	password: string
): Promise<TenantReadVerifier> {
	const passwordSalt = readPasswordSaltSchema.parse(`${user}-salt`);

	return {
		user: readUserSchema.parse(user),
		passwordHash: await hashReadPassword(password, passwordSalt),
		passwordSalt
	};
}

function request(credential?: readonly [string, string]): Request {
	if (credential === undefined) {
		return new Request('https://cupboard.test/nix-cache-info');
	}

	const [user, password] = credential;

	return new Request('https://cupboard.test/nix-cache-info', {
		headers: { authorization: `Basic ${btoa(`${user}:${password}`)}` }
	});
}

// Which credential the reader presents. `wrong` presents the tenant user with a
// password that matches neither verifier.
type Offered = 'none' | 'tenant' | 'cache' | 'wrong';

const credentials: Record<Offered, undefined | readonly [string, string]> = {
	none: undefined,
	tenant: ['tenant-user', tenantPassword],
	cache: ['cache-user', cachePassword],
	wrong: ['tenant-user', 'not-the-password']
};

interface Row {
	readonly name: string;
	readonly hasTenantCredential: boolean;
	readonly hasCacheCredential: boolean;
	readonly scope: ReadScope;
	readonly offered: Offered;
	readonly expected: 'served' | 'refused';
}

async function guard(row: Row): Promise<'served' | 'refused'> {
	const entry: TenantEntry = row.hasTenantCredential
		? {
				status: 'active',
				readVerifier: await verifier('tenant-user', tenantPassword)
			}
		: { status: 'active' };
	const cacheVerifier = row.hasCacheCredential
		? await verifier('cache-user', cachePassword)
		: undefined;
	const denied = await guardScopedRead(
		request(credentials[row.offered]),
		entry,
		row.scope,
		{ cacheVerifier, isTokenAuthorised: () => Promise.resolve(false) }
	);

	return denied === undefined ? 'served' : 'refused';
}

const rows: readonly Row[] = [
	{
		name: 'serves an unauthenticated public cache',
		hasTenantCredential: false,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'none',
		expected: 'served'
	},
	{
		name: 'serves a public cache even when the credential is wrong',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'wrong',
		expected: 'served'
	},
	{
		name: 'refuses an unauthenticated private cache',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'none',
		expected: 'refused'
	},
	{
		name: 'serves a private cache to the tenant credential',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'tenant',
		expected: 'served'
	},
	{
		name: 'refuses a private cache when no verifier exists',
		hasTenantCredential: false,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'tenant',
		expected: 'refused'
	},
	{
		name: 'serves a private cache to its cache credential',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: privateScope,
		offered: 'cache',
		expected: 'served'
	},
	{
		name: 'refuses the tenant credential when the cache has its own verifier',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: privateScope,
		offered: 'tenant',
		expected: 'refused'
	},
	{
		name: 'refuses an unauthenticated private cache with its own verifier',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: privateScope,
		offered: 'none',
		expected: 'refused'
	}
];

describe('guardScopedRead', () => {
	it.each(rows)('$name', async (row) => {
		expect({ name: row.name, outcome: await guard(row) }).toStrictEqual({
			name: row.name,
			outcome: row.expected
		});
	});

	it('refuses with a Basic challenge marked as private', async () => {
		const denied = await guardScopedRead(
			request(),
			{ status: 'active' },
			privateScope,
			{ isTokenAuthorised: () => Promise.resolve(false) }
		);

		expect({
			status: denied?.status,
			challenge: denied?.headers.get('www-authenticate'),
			cacheControl: denied?.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.UNAUTHORIZED,
			challenge: 'Basic realm="cupboard"',
			cacheControl: 'no-store'
		});
	});

	it('routes a token password to the scoped verifier without changing static Basic', async () => {
		const calls: { token: string; cache: CacheScope }[] = [];
		const authentication = {
			cacheVerifier: await verifier(readTokenBasicUser, 'static-password'),
			isTokenAuthorised: (token: string, cache: CacheScope) => {
				calls.push({ token, cache });
				return Promise.resolve(token === 'signed-token');
			}
		};

		const staticRead = await guardScopedRead(
			request([readTokenBasicUser, 'static-password']),
			{ status: 'active' },
			privateScope,
			authentication
		);
		const tokenRead = await guardScopedRead(
			request([readTokenBasicUser, `${readTokenPasswordPrefix}signed-token`]),
			{ status: 'active' },
			privateScope,
			authentication
		);
		const bearerRead = await guardScopedRead(
			new Request('https://cupboard.test/nix-cache-info', {
				headers: { authorization: 'Bearer signed-token' }
			}),
			{ status: 'active' },
			privateScope,
			authentication
		);
		const refused = await guardScopedRead(
			request([readTokenBasicUser, `${readTokenPasswordPrefix}wrong`]),
			{ status: 'active' },
			privateScope,
			authentication
		);

		expect({
			staticRead: staticRead?.status ?? 'served',
			tokenRead: tokenRead?.status ?? 'served',
			bearerRead: bearerRead?.status ?? 'served',
			refused: refused?.status,
			calls
		}).toStrictEqual({
			staticRead: 'served',
			tokenRead: 'served',
			bearerRead: 'served',
			refused: StatusCodes.UNAUTHORIZED,
			calls: [
				{ token: 'signed-token', cache: namedCache },
				{ token: 'signed-token', cache: namedCache },
				{ token: 'wrong', cache: namedCache }
			]
		});
	});
});
