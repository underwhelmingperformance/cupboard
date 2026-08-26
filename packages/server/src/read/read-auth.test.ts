import { readUserSchema } from '@cupboard/shared/http';
import { describe, expect, it } from 'vitest';

import {
	hashReadPassword,
	isReadAuthorised,
	isReadPasswordMatching,
	readPasswordHashSchema,
	readPasswordSaltSchema,
	type ReadVerifier
} from './read-auth.ts';

function basic(user: string, password: string): string {
	return `Basic ${btoa(`${user}:${password}`)}`;
}

function request(authorization?: string): Request {
	return new Request(
		'https://cupboard.test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.narinfo',
		authorization === undefined ? {} : { headers: { authorization } }
	);
}

async function verifierFor(password: string): Promise<ReadVerifier> {
	const passwordSalt = readPasswordSaltSchema.parse('test-salt');

	return {
		user: readUserSchema.parse('alice'),
		passwordHash: await hashReadPassword(password, passwordSalt),
		passwordSalt
	};
}

describe('isReadAuthorised', () => {
	it('stores the salted SHA-256 digest of the password', async () => {
		const salt = readPasswordSaltSchema.parse('test-salt');
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode('cupboard-read-password-v1\0test-salt\0password')
		);
		const digestHex = Array.from(new Uint8Array(digest), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('');

		expect({
			hash: await hashReadPassword('password', salt),
			matches: await isReadPasswordMatching(
				'password',
				readPasswordHashSchema.parse(digestHex),
				salt
			)
		}).toStrictEqual({ hash: digestHex, matches: true });
	});

	// An upper-case digest is the same 32 bytes and looks correct, but the stored
	// and computed verifiers are compared as strings, so it would never match.
	it('refuses an upper-case digest as a stored verifier', () => {
		expect(readPasswordHashSchema.safeParse('A'.repeat(64)).success).toBe(
			false
		);
	});

	it.each([
		{
			name: 'matching credentials, password split on the first colon',
			authorization: basic('alice', 'p:a:ss'),
			expected: true
		},
		{
			name: 'a wrong password',
			authorization: basic('alice', 'nope'),
			expected: false
		},
		{
			name: 'a wrong user',
			authorization: basic('bob', 'p:a:ss'),
			expected: false
		},
		{
			name: 'a non-Basic scheme',
			authorization: `Bearer ${btoa('alice:p:a:ss')}`,
			expected: false
		},
		{
			name: 'malformed base64',
			authorization: 'Basic !!!not-base64',
			expected: false
		},
		{
			name: 'a payload with no separator',
			authorization: `Basic ${btoa('alice')}`,
			expected: false
		}
	])('returns $expected for $name', async ({ authorization, expected }) => {
		const verifier = await verifierFor('p:a:ss');

		expect(await isReadAuthorised(request(authorization), verifier)).toBe(
			expected
		);
	});

	it('rejects a request with no Authorization header', async () => {
		const verifier = await verifierFor('p:a:ss');

		expect(await isReadAuthorised(request(), verifier)).toBe(false);
	});
});
