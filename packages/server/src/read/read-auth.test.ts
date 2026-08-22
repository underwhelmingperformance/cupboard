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
	it('creates a versioned PBKDF2 verifier and accepts legacy SHA-256 rows', async () => {
		const salt = readPasswordSaltSchema.parse('test-salt');
		const current = await hashReadPassword('password', salt);
		const legacy = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode('cupboard-read-password-v1\0test-salt\0password')
		);
		const legacyHex = Array.from(new Uint8Array(legacy), (byte) =>
			byte.toString(16).padStart(2, '0')
		).join('');

		expect({
			versioned: current.startsWith('pbkdf2-sha256$600000$'),
			legacy: await isReadPasswordMatching(
				'password',
				readPasswordHashSchema.parse(legacyHex),
				salt
			)
		}).toStrictEqual({ versioned: true, legacy: true });
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
