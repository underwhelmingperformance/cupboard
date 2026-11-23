import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { accessKeySecretSchema } from './access-keys.ts';
import { cacheAccessKeysSchema } from './cache-access-keys.ts';

const releaseKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-000000000001_${'a'.repeat(64)}`
);
const teamKey = accessKeySecretSchema.parse(
	`cupboard_ak_00000000-0000-4000-8000-000000000002_${'b'.repeat(64)}`
);

describe('cacheAccessKeysSchema', () => {
	it('reads an empty document as no access key', () => {
		expect(cacheAccessKeysSchema.parse([])).toStrictEqual([]);
	});

	it('keeps default and named cache scopes explicit', () => {
		expect(
			cacheAccessKeysSchema.parse([
				{ cache: { kind: 'default' }, accessKey: releaseKey },
				{ cache: { kind: 'named', name: 'team.eu' }, accessKey: teamKey }
			])
		).toStrictEqual([
			{ cache: { kind: 'default' }, accessKey: releaseKey },
			{
				cache: { kind: 'named', name: cacheNameSchema.parse('team.eu') },
				accessKey: teamKey
			}
		]);
	});

	it.each<{ readonly name: string; readonly cache: CacheScope }>([
		{ name: 'default cache', cache: { kind: 'default' } },
		{
			name: 'named cache',
			cache: { kind: 'named', name: cacheNameSchema.parse('team.eu') }
		}
	])('refuses two access keys for the $name', ({ cache }) => {
		const result = cacheAccessKeysSchema.safeParse([
			{ cache, accessKey: releaseKey },
			{ cache, accessKey: teamKey }
		]);

		expect(result.error?.issues).toStrictEqual([
			{
				code: 'custom',
				message: 'Each cache can have only one access key',
				path: [1, 'cache']
			}
		]);
	});

	it.each([
		{ name: 'is not an array', document: 'release' },
		{
			name: 'names a cache that the name schema refuses',
			document: [
				{ cache: { kind: 'named', name: 'A!' }, accessKey: releaseKey }
			]
		},
		{
			name: 'gives an access token in place of a key',
			document: [
				{
					cache: { kind: 'default' },
					accessKey: 'eyJhbGciOiJFZERTQSJ9.e30.signature'
				}
			]
		},
		{
			name: 'gives a user and password',
			document: [
				{
					cache: { kind: 'default' },
					credential: { user: 'ci', password: 'A'.repeat(43) }
				}
			]
		}
	])('refuses a document that $name', ({ document }) => {
		expect(cacheAccessKeysSchema.safeParse(document).success).toBe(false);
	});
});
