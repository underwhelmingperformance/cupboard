import {
	cacheNameSchema,
	DEFAULT_CACHE,
	privateStoredCache
} from '@cupboard/nix-store/scalars';
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

const publicScope: ReadScope = { visibility: 'public', cache: DEFAULT_CACHE };
const privateScope: ReadScope = {
	visibility: 'private',
	cache: privateStoredCache(cacheNameSchema.parse('builds'))
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
	readonly readMode: 'public' | 'private';
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
				readMode: row.readMode,
				readVerifier: await verifier('tenant-user', tenantPassword)
			}
		: { status: 'active', readMode: row.readMode };
	const cacheVerifier = row.hasCacheCredential
		? await verifier('cache-user', cachePassword)
		: undefined;
	const denied = await guardScopedRead(
		request(credentials[row.offered]),
		entry,
		row.scope,
		cacheVerifier
	);

	return denied === undefined ? 'served' : 'refused';
}

const rows: readonly Row[] = [
	{
		name: 'serves an unauthenticated public-scope read when the tenant is public',
		readMode: 'public',
		hasTenantCredential: false,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'none',
		expected: 'served'
	},
	{
		name: 'serves a public-scope read from a public tenant even when the credential is wrong',
		readMode: 'public',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'wrong',
		expected: 'served'
	},
	{
		name: 'refuses an unauthenticated public-scope read when the tenant is private',
		readMode: 'private',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'none',
		expected: 'refused'
	},
	{
		name: 'serves a public-scope read from a private tenant to the tenant credential',
		readMode: 'private',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'tenant',
		expected: 'served'
	},
	{
		name: 'refuses a wrong password on a public-scope read from a private tenant',
		readMode: 'private',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'wrong',
		expected: 'refused'
	},
	{
		name: 'refuses a public-scope read when a private tenant has no verifier',
		readMode: 'private',
		hasTenantCredential: false,
		hasCacheCredential: false,
		scope: publicScope,
		offered: 'tenant',
		expected: 'refused'
	},
	{
		name: 'refuses a cache credential on a public-scope read',
		readMode: 'private',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: publicScope,
		offered: 'cache',
		expected: 'refused'
	},
	{
		name: 'refuses an unauthenticated private-scope read from a public tenant',
		readMode: 'public',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'none',
		expected: 'refused'
	},
	{
		name: 'serves a private-scope read from a public tenant to the tenant credential',
		readMode: 'public',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'tenant',
		expected: 'served'
	},
	{
		name: 'serves a private-scope read from a private tenant to the tenant credential',
		readMode: 'private',
		hasTenantCredential: true,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'tenant',
		expected: 'served'
	},
	{
		name: 'refuses a private-scope read when no verifier exists',
		readMode: 'public',
		hasTenantCredential: false,
		hasCacheCredential: false,
		scope: privateScope,
		offered: 'tenant',
		expected: 'refused'
	},
	{
		name: 'serves a private-scope read to the cache credential when the private cache has its own verifier',
		readMode: 'public',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: privateScope,
		offered: 'cache',
		expected: 'served'
	},
	{
		name: 'refuses the tenant credential when the private cache has its own verifier',
		readMode: 'public',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: privateScope,
		offered: 'tenant',
		expected: 'refused'
	},
	{
		name: 'refuses the tenant credential of a private tenant when the private cache has its own verifier',
		readMode: 'private',
		hasTenantCredential: true,
		hasCacheCredential: true,
		scope: privateScope,
		offered: 'tenant',
		expected: 'refused'
	},
	{
		name: 'refuses an unauthenticated private-scope read when the private cache has its own verifier',
		readMode: 'public',
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
			{ status: 'active', readMode: 'public' },
			privateScope
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
});
