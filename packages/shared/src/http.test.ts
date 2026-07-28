import { describe, expect, it } from 'vitest';

import {
	basicAuthHeader,
	type BasicCredential,
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

	it('encodes a credential carrying a colon and non-ASCII bytes', () => {
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
		{ name: 'no header at all', header: undefined, reason: 'not-basic' },
		{
			name: 'a non-Basic scheme',
			header: `Bearer ${btoa('alice:secret')}`,
			reason: 'not-basic'
		},
		{
			name: 'undecodable base64',
			header: 'Basic !!!not-base64',
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
		}
	])('refuses $name', ({ header, reason }) => {
		expect(parseBasicAuthHeader(header)).toStrictEqual({ ok: false, reason });
	});
});
