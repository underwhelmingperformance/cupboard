import { describe, expect, it } from 'vitest';

import { isAllowedIssuerUrl, IssuerUrl } from './oidc-issuer.ts';

describe('isAllowedIssuerUrl', () => {
	it.each([
		{
			name: 'an https issuer',
			value: 'https://issuer.example.com',
			allowed: true
		},
		{
			name: 'an https issuer with a path',
			value: 'https://issuer.example.com/realm',
			allowed: true
		},
		{
			name: 'a plain http issuer',
			value: 'http://issuer.example.com',
			allowed: false
		},
		{
			name: 'http on localhost',
			value: 'http://localhost:8788',
			allowed: true
		},
		{
			name: 'http on 127.0.0.1',
			value: 'http://127.0.0.1:8788',
			allowed: true
		},
		{
			name: 'http on the IPv6 loopback',
			value: 'http://[::1]:8788',
			allowed: true
		},
		{
			name: 'http on a host that merely starts with localhost',
			value: 'http://localhost.evil.com',
			allowed: false
		},
		{ name: 'a non-URL string', value: 'not a url', allowed: false }
	])('$name', ({ value, allowed }) => {
		expect(isAllowedIssuerUrl(value)).toBe(allowed);
	});
});

describe('IssuerUrl', () => {
	it.each([
		{ name: 'an https issuer', raw: 'https://issuer.example.com' },
		{
			name: 'an https issuer with a trailing slash',
			raw: 'https://issuer.example.com/'
		},
		{ name: 'an http loopback issuer', raw: 'http://127.0.0.1:8788' }
	])('parses, normalises and builds the discovery URL for $name', ({ raw }) => {
		const issuerUrl = IssuerUrl.parse(raw);
		const normalised = raw.replace(/\/$/, '');

		expect({
			value: issuerUrl?.value,
			discoveryUrl: issuerUrl?.discoveryUrl
		}).toStrictEqual({
			value: normalised,
			discoveryUrl: `${normalised}/.well-known/openid-configuration`
		});
	});

	it.each([
		{ name: 'plain http', raw: 'http://issuer.example.com' },
		{ name: 'a non-URL string', raw: 'not a url' },
		{ name: 'an issuer with a query', raw: 'https://issuer.example.com?t=a' },
		{ name: 'an issuer with a fragment', raw: 'https://issuer.example.com#a' },
		{ name: 'an issuer with userinfo', raw: 'https://user@issuer.example.com' }
	])('refuses to parse $name', ({ raw }) => {
		expect(IssuerUrl.parse(raw)).toBeUndefined();
	});

	it('matches another issuer slash-insensitively', () => {
		const issuerUrl = IssuerUrl.parse('https://issuer.example.com/');

		expect({
			exact: issuerUrl?.matches('https://issuer.example.com'),
			slashed: issuerUrl?.matches('https://issuer.example.com/'),
			other: issuerUrl?.matches('https://issuer.evil.com')
		}).toStrictEqual({ exact: true, slashed: true, other: false });
	});
});
