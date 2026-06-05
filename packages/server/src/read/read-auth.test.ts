import { describe, expect, it } from 'vitest';

import {
	authoriseRead,
	hashReadPassword,
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
	const passwordSalt = 'test-salt';

	return {
		user: 'alice',
		passwordHash: await hashReadPassword(password, passwordSalt),
		passwordSalt
	};
}

describe('authoriseRead', () => {
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
		}
	])('rejects/accepts $name', async ({ authorization, expected }) => {
		const verifier = await verifierFor('p:a:ss');

		expect(await authoriseRead(request(authorization), verifier)).toBe(
			expected
		);
	});

	it('rejects a request with no Authorization header', async () => {
		const verifier = await verifierFor('p:a:ss');

		expect(await authoriseRead(request(), verifier)).toBe(false);
	});
});
