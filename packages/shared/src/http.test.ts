import { describe, expect, it } from 'vitest';

import {
	basicAuthHeader,
	type BasicCredential,
	parseAuthenticationHeader,
	parseBasicAuthHeader,
	readUserInputSchema
} from './http.ts';

function credential(user: string, password: string): BasicCredential {
	return { user: readUserInputSchema.parse(user), password };
}

describe('basicAuthHeader', () => {
	it('encodes the credentials as a Basic authorization header', () => {
		expect(basicAuthHeader(credential('alice', 'secret'))).toStrictEqual({
			authorization: `Basic ${Buffer.from('alice:secret').toString('base64')}`
		});
	});

	it('encodes a password with a colon and non-ASCII characters', () => {
		expect(basicAuthHeader(credential('user', 'p:ss wörd'))).toStrictEqual({
			authorization: `Basic ${Buffer.from('user:p:ss wörd').toString('base64')}`
		});
	});
});

describe('readUserInputSchema', () => {
	it.each([
		{ name: 'a colon', value: 'a:b' },
		{ name: 'a leading colon', value: ':alice' },
		{ name: 'nothing', value: '' }
	])('refuses a username carrying $name', ({ value }) => {
		expect(readUserInputSchema.safeParse(value).success).toBe(false);
	});
});

describe('parseBasicAuthHeader', () => {
	it.each([
		{ name: 'a plain credential', user: 'alice', password: 'secret' },
		{ name: 'a password carrying colons', user: 'alice', password: 'p:a:ss' },
		{ name: 'non-ASCII bytes', user: 'älice', password: 'p:ss wörd' },
		{ name: 'an empty password', user: 'alice', password: '' }
	])('renders and parses back $name', ({ user, password }) => {
		const original = credential(user, password);
		const header = basicAuthHeader(original).authorization;

		expect(parseBasicAuthHeader(header)).toStrictEqual({
			ok: true,
			credential: original
		});
	});

	it.each([
		{ name: 'lower-case', header: `basic ${btoa('alice:secret')}` },
		{ name: 'mixed-case', header: `bAsIc ${btoa('alice:secret')}` },
		{ name: 'multiple spaces', header: `Basic   ${btoa('alice:secret')}` }
	])('accepts a $name scheme spelling', ({ header }) => {
		expect(parseBasicAuthHeader(header)).toStrictEqual({
			ok: true,
			credential: credential('alice', 'secret')
		});
	});

	it.each([
		{ name: 'no header at all', header: undefined, reason: 'not-basic' },
		{
			name: 'a non-Basic scheme',
			header: `Bearer ${btoa('alice:secret')}`,
			reason: 'not-basic'
		},
		{
			name: 'base64 split by a tab',
			header: `Basic ${btoa('alice:secret').slice(0, 4)}\t${btoa('alice:secret').slice(4)}`,
			reason: 'not-basic'
		},
		{
			name: 'base64 followed by a comma',
			header: `Basic ${btoa('alice:secret')},other`,
			reason: 'not-basic'
		},
		{
			name: 'undecodable base64',
			header: 'Basic a',
			reason: 'undecodable'
		},
		{
			name: 'no separator',
			header: `Basic ${btoa('alice')}`,
			reason: 'malformed'
		},
		{
			name: 'an empty user-id',
			header: `Basic ${btoa(':secret')}`,
			reason: 'malformed'
		},
		{
			name: 'a control character in the user-id',
			header: `Basic ${btoa('ali\u{0}ce:secret')}`,
			reason: 'malformed'
		},
		{
			name: 'a control character in the password',
			header: `Basic ${btoa('alice:sec\u{7F}ret')}`,
			reason: 'malformed'
		}
	])('refuses $name', ({ header, reason }) => {
		expect(parseBasicAuthHeader(header)).toStrictEqual({ ok: false, reason });
	});
});

describe('parseAuthenticationHeader', () => {
	it.each(['token', 'token=', 'token==', 'a-b.c_d~e+f/g'])(
		'accepts token68 credential %s',
		(credentials) => {
			expect(parseAuthenticationHeader(`Bearer ${credentials}`, 'Bearer')).toBe(
				credentials
			);
		}
	);

	it.each([
		'Bearer to\tken',
		'Bearer token,other',
		'Bearer token=other',
		'Bearer token\u{7F}',
		'Bear\u{0}er token'
	])('rejects malformed authentication header %j', (header) => {
		expect(parseAuthenticationHeader(header, 'Bearer')).toBeUndefined();
	});
});
