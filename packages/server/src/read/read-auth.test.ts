import { describe, expect, it } from 'vitest';

import {
	authoriseRead,
	hashReadPassword,
	type ReadCredential,
	readCredential
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

describe('readCredential', () => {
	it.each([
		{
			name: 'both set enables private mode',
			env: { CUPBOARD_READ_USER: 'alice', CUPBOARD_READ_PASSWORD: 'secret' },
			expected: { user: 'alice', password: 'secret' }
		},
		{
			name: 'only the user set stays public',
			env: { CUPBOARD_READ_USER: 'alice', CUPBOARD_READ_PASSWORD: '' },
			expected: undefined
		},
		{
			name: 'only the password set stays public',
			env: { CUPBOARD_READ_USER: '', CUPBOARD_READ_PASSWORD: 'secret' },
			expected: undefined
		},
		{
			name: 'neither set stays public',
			env: { CUPBOARD_READ_USER: '', CUPBOARD_READ_PASSWORD: '' },
			expected: undefined
		}
	])('$name', ({ env, expected }) => {
		expect(readCredential(env)).toStrictEqual(expected);
	});
});

describe('hashReadPassword', () => {
	it('frames the salt and password before hashing', async () => {
		expect(await hashReadPassword('secret', 'salt')).toBe(
			'a4dc7bedcab51fbe861f6d08e6e609c57138a98980ec526b3b8d9b571b6dbe19'
		);
	});
});

describe('authoriseRead', () => {
	const credential: ReadCredential = { user: 'alice', password: 'p:a:ss' };

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
	])('rejects/accepts $name', ({ authorization, expected }) => {
		expect(authoriseRead(request(authorization), credential)).toBe(expected);
	});

	it('rejects a request with no Authorization header', () => {
		expect(authoriseRead(request(), credential)).toBe(false);
	});
});
