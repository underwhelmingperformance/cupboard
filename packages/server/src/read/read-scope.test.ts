import {
	cacheNameSchema,
	type CacheScope,
	firstCacheGeneration
} from '@cupboard/nix-store/scalars';
import {
	readTokenBasicUser,
	readTokenPasswordPrefix
} from '@cupboard/protocol/read-access';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { guardScopedRead, type ReadScope } from './read.ts';

const keySecret = `cupboard_ak_00000000-0000-4000-8000-000000000001_${'a'.repeat(64)}`;

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

function request(credential?: readonly [string, string]): Request {
	if (credential === undefined) {
		return new Request('https://cupboard.test/nix-cache-info');
	}

	const [user, password] = credential;

	return new Request('https://cupboard.test/nix-cache-info', {
		headers: { authorization: `Basic ${btoa(`${user}:${password}`)}` }
	});
}

// Which credential the reader presents. `password` is a Basic password that is
// neither an access token nor an access key.
type Offered = 'none' | 'password' | 'token' | 'key';

const credentials: Record<Offered, undefined | readonly [string, string]> = {
	none: undefined,
	password: ['cupboard', 'a-static-password'],
	token: [readTokenBasicUser, `${readTokenPasswordPrefix}signed-token`],
	key: ['cupboard', keySecret]
};

interface Row {
	readonly name: string;
	readonly scope: ReadScope;
	readonly offered: Offered;
	readonly expected: 'served' | 'refused';
}

async function guard(row: Row): Promise<'served' | 'refused'> {
	const denied = await guardScopedRead(
		request(credentials[row.offered]),
		row.scope,
		{
			isTokenAuthorised: (token) => Promise.resolve(token === 'signed-token'),
			isKeyAuthorised: (secret) => Promise.resolve(secret === keySecret)
		}
	);

	return denied === undefined ? 'served' : 'refused';
}

const rows: readonly Row[] = [
	{
		name: 'serves an unauthenticated public cache',
		scope: publicScope,
		offered: 'none',
		expected: 'served'
	},
	{
		name: 'serves a public cache whatever the Basic password is',
		scope: publicScope,
		offered: 'password',
		expected: 'served'
	},
	{
		name: 'refuses an unauthenticated private cache',
		scope: privateScope,
		offered: 'none',
		expected: 'refused'
	},
	{
		name: 'refuses a private cache to a password that is neither a token nor a key',
		scope: privateScope,
		offered: 'password',
		expected: 'refused'
	},
	{
		name: 'serves a private cache to an authorised access token',
		scope: privateScope,
		offered: 'token',
		expected: 'served'
	},
	{
		name: 'serves a private cache to an authorised access key',
		scope: privateScope,
		offered: 'key',
		expected: 'served'
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
		const denied = await guardScopedRead(request(), privateScope, {
			isTokenAuthorised: () => Promise.resolve(false),
			isKeyAuthorised: () => Promise.resolve(false)
		});

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

	it('routes a token from Basic or Bearer to the scoped verifier', async () => {
		const calls: { token: string; cache: CacheScope }[] = [];
		const authentication = {
			isTokenAuthorised: (token: string, cache: CacheScope) => {
				calls.push({ token, cache });
				return Promise.resolve(token === 'signed-token');
			},
			isKeyAuthorised: () => Promise.resolve(false)
		};

		const tokenRead = await guardScopedRead(
			request([readTokenBasicUser, `${readTokenPasswordPrefix}signed-token`]),
			privateScope,
			authentication
		);
		const bearerRead = await guardScopedRead(
			new Request('https://cupboard.test/nix-cache-info', {
				headers: { authorization: 'Bearer signed-token' }
			}),
			privateScope,
			authentication
		);
		const refused = await guardScopedRead(
			request([readTokenBasicUser, `${readTokenPasswordPrefix}wrong`]),
			privateScope,
			authentication
		);

		expect({
			tokenRead: tokenRead?.status ?? 'served',
			bearerRead: bearerRead?.status ?? 'served',
			refused: refused?.status,
			calls
		}).toStrictEqual({
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

	it('reads a token or an access key from a Basic password with any username', async () => {
		const calls: { kind: string; credential: string; cache: CacheScope }[] = [];
		const authentication = {
			isTokenAuthorised: (token: string, cache: CacheScope) => {
				calls.push({ kind: 'token', credential: token, cache });
				return Promise.resolve(true);
			},
			isKeyAuthorised: (secret: string, cache: CacheScope) => {
				calls.push({ kind: 'key', credential: secret, cache });
				return Promise.resolve(true);
			}
		};

		const tokenRead = await guardScopedRead(
			request(['anyone', `${readTokenPasswordPrefix}signed-token`]),
			privateScope,
			authentication
		);
		const keyRead = await guardScopedRead(
			request(['machine-7', keySecret]),
			privateScope,
			authentication
		);

		expect({
			tokenRead: tokenRead?.status ?? 'served',
			keyRead: keyRead?.status ?? 'served',
			calls
		}).toStrictEqual({
			tokenRead: 'served',
			keyRead: 'served',
			calls: [
				{ kind: 'token', credential: 'signed-token', cache: namedCache },
				{ kind: 'key', credential: keySecret, cache: namedCache }
			]
		});
	});
});
