import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import { cacheCredentialsSchema } from './cache-credentials.ts';

// A read password is 32 random bytes rendered as 43 base64url characters.
const readPassword = 'A'.repeat(43);
const otherReadPassword = 'B'.repeat(43);
const ci = readUserInputSchema.parse('ci');
const bob = readUserInputSchema.parse('bob');

describe('cacheCredentialsSchema', () => {
	it('reads an empty document as no credential', () => {
		expect(cacheCredentialsSchema.parse([])).toStrictEqual([]);
	});

	it('keeps default and named cache scopes explicit', () => {
		expect(
			cacheCredentialsSchema.parse([
				{
					cache: { kind: 'default' },
					credential: { user: 'ci', password: readPassword }
				},
				{
					cache: { kind: 'named', name: 'team.eu' },
					credential: { user: 'bob', password: otherReadPassword }
				}
			])
		).toStrictEqual([
			{
				cache: { kind: 'default' },
				credential: { user: ci, password: readPassword }
			},
			{
				cache: { kind: 'named', name: cacheNameSchema.parse('team.eu') },
				credential: { user: bob, password: otherReadPassword }
			}
		]);
	});

	it('accepts a cache named after a property of Object.prototype', () => {
		expect(
			cacheCredentialsSchema.parse([
				{
					cache: { kind: 'named', name: 'constructor' },
					credential: { user: 'ci', password: readPassword }
				}
			])
		).toStrictEqual([
			{
				cache: {
					kind: 'named',
					name: cacheNameSchema.parse('constructor')
				},
				credential: { user: ci, password: readPassword }
			}
		]);
	});

	const duplicateCases: {
		readonly name: string;
		readonly cache: CacheScope;
	}[] = [
		{
			name: 'default cache',
			cache: { kind: 'default' }
		},
		{
			name: 'named cache',
			cache: { kind: 'named', name: cacheNameSchema.parse('team.eu') }
		}
	];

	it.each(duplicateCases)(
		'refuses duplicate credentials for the $name',
		({ cache }) => {
			const result = cacheCredentialsSchema.safeParse([
				{
					cache,
					credential: { user: 'ci', password: readPassword }
				},
				{
					cache,
					credential: { user: 'bob', password: otherReadPassword }
				}
			]);

			if (result.success) {
				throw new Error('duplicate cache credentials were accepted');
			}

			expect(result.error.issues).toStrictEqual([
				{
					code: 'custom',
					message: 'Each cache can have only one read credential',
					path: [1, 'cache']
				}
			]);
		}
	);

	it.each([
		{ name: 'is not an array', document: 'release' },
		{
			name: 'names a cache the name schema refuses',
			document: [
				{
					cache: { kind: 'named', name: 'A!' },
					credential: { user: 'ci', password: readPassword }
				}
			]
		},
		{
			name: 'omits the password',
			document: [
				{
					cache: { kind: 'default' },
					credential: { user: 'ci' }
				}
			]
		},
		{
			name: 'carries a password of the wrong shape',
			document: [
				{
					cache: { kind: 'default' },
					credential: { user: 'ci', password: 'short' }
				}
			]
		},
		{
			name: 'carries an unknown credential field',
			document: [
				{
					cache: { kind: 'default' },
					credential: {
						user: 'ci',
						password: readPassword,
						token: 'extra'
					}
				}
			]
		}
	])('refuses a document that $name', ({ document }) => {
		expect(cacheCredentialsSchema.safeParse(document).success).toBe(false);
	});
});
