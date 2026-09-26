import { describe, expect, it } from 'vitest';

import { ownDisplayName, principalLabel } from './principal.ts';

function segment(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function unsignedToken(claims: Record<string, unknown>): string {
	return `${segment({ alg: 'none' })}.${segment(claims)}.`;
}

describe('ownDisplayName', () => {
	it.each([
		{
			name: 'prefers the name claim',
			claims: {
				name: 'Ada Lovelace',
				email: 'ada@example.com',
				preferred_username: 'ada',
				sub: 'user-1'
			},
			expected: 'Ada Lovelace'
		},
		{
			name: 'falls back to the email',
			claims: {
				email: 'ada@example.com',
				preferred_username: 'ada',
				sub: 'user-1'
			},
			expected: 'ada@example.com'
		},
		{
			name: 'falls back to the preferred username',
			claims: { preferred_username: 'ada', sub: 'user-1' },
			expected: 'ada'
		},
		{
			name: 'falls back to the subject',
			claims: { sub: 'user-1' },
			expected: 'user-1'
		},
		{
			name: 'skips blank and non-string claims',
			claims: { name: '  ', email: 7, preferred_username: 'ada', sub: 'u' },
			expected: 'ada'
		},
		{
			name: 'returns undefined when no display claim is present',
			claims: { iss: 'https://issuer.example' },
			expected: undefined
		}
	])('$name', ({ claims, expected }) => {
		expect(ownDisplayName(unsignedToken(claims))).toBe(expected);
	});

	it('returns undefined for a token that is not a JWT', () => {
		expect(ownDisplayName('opaque')).toBeUndefined();
	});
});

describe('principalLabel', () => {
	it.each([
		{
			name: 'shows the full issuer and the subject',
			principal: { issuer: 'https://dash.cloudflare.com', subject: 'cf-1' },
			expected: 'https://dash.cloudflare.com · cf-1'
		},
		{
			name: 'keeps the issuer path',
			principal: { issuer: 'http://127.0.0.1:8080/realm', subject: 'u' },
			expected: 'http://127.0.0.1:8080/realm · u'
		}
	])('$name', ({ principal, expected }) => {
		expect(principalLabel(principal)).toBe(expected);
	});
});
