import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import { readUserInputSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import { privateCacheCredentialsSchema } from './private-cache-credentials.ts';

// A read password is 32 random bytes rendered as 43 base64url characters.
const readPassword = 'A'.repeat(43);
const otherReadPassword = 'B'.repeat(43);
const ci = readUserInputSchema.parse('ci');
const bob = readUserInputSchema.parse('bob');

describe('privateCacheCredentialsSchema', () => {
	it('reads an empty document as no credential', () => {
		expect(privateCacheCredentialsSchema.parse({})).toStrictEqual(new Map());
	});

	it("keys each credential by its cache's local name", () => {
		expect(
			privateCacheCredentialsSchema.parse({
				release: { user: 'ci', password: readPassword },
				'team.eu': { user: 'bob', password: otherReadPassword }
			})
		).toStrictEqual(
			new Map([
				[
					cacheNameSchema.parse('release'),
					{ user: ci, password: readPassword }
				],
				[
					cacheNameSchema.parse('team.eu'),
					{ user: bob, password: otherReadPassword }
				]
			])
		);
	});

	// `constructor` is the only string property name on `Object.prototype` that
	// matches `cacheNamePattern`; the others contain uppercase letters or start
	// with an underscore.
	it('returns no credential for an unlisted cache named constructor', () => {
		const credentials = privateCacheCredentialsSchema.parse({
			release: { user: 'ci', password: readPassword }
		});

		expect(
			credentials.get(cacheNameSchema.parse('constructor'))
		).toBeUndefined();
	});

	it('accepts a cache named after a property of Object.prototype', () => {
		expect(
			privateCacheCredentialsSchema.parse({
				constructor: { user: 'ci', password: readPassword }
			})
		).toStrictEqual(
			new Map([
				[
					cacheNameSchema.parse('constructor'),
					{ user: ci, password: readPassword }
				]
			])
		);
	});

	it.each([
		{ name: 'is not an object', document: 'release' },
		{ name: 'names a cache the name schema refuses', document: { 'A!': {} } },
		{
			name: 'omits the password',
			document: { release: { user: 'ci' } }
		},
		{
			name: 'carries a password of the wrong shape',
			document: { release: { user: 'ci', password: 'short' } }
		},
		{
			name: 'carries an unknown credential field',
			document: {
				release: { user: 'ci', password: readPassword, token: 'extra' }
			}
		}
	])('refuses a document that $name', ({ document }) => {
		expect(privateCacheCredentialsSchema.safeParse(document).success).toBe(
			false
		);
	});
});
