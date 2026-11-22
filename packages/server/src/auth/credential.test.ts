import { describe, expect, it } from 'vitest';

import { bearerCredential, presentedCredential } from './credential.ts';

const keySecret = `cupboard_ak_00000000-0000-4000-8000-000000000001_${'a'.repeat(64)}`;

function basic(user: string, password: string): string {
	return `Basic ${btoa(`${user}:${password}`)}`;
}

function requestWith(authorization?: string): Request {
	return new Request(
		'https://cupboard.example.workers.dev/t/acme/nix-cache-info',
		{
			headers: authorization === undefined ? {} : { authorization }
		}
	);
}

describe('presentedCredential', () => {
	it.each([
		{
			name: 'a bearer access token',
			authorization: 'Bearer eyJ.token',
			expected: { kind: 'access-token', token: 'eyJ.token' }
		},
		{
			name: 'a bearer access key',
			authorization: `Bearer ${keySecret}`,
			expected: { kind: 'access-key', secret: keySecret }
		},
		{
			name: 'an access token in a Basic password with any username',
			authorization: basic('anyone', 'cupboard-access+jwt:eyJ.token'),
			expected: { kind: 'access-token', token: 'eyJ.token' }
		},
		{
			name: 'an access key in a Basic password with any username',
			authorization: basic('machine-7', keySecret),
			expected: { kind: 'access-key', secret: keySecret }
		},
		{
			name: 'a static read password',
			authorization: basic(
				'cupboard',
				'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
			),
			expected: undefined
		},
		{
			name: 'no authorization header',
			authorization: undefined,
			expected: undefined
		}
	])('reads $name', ({ authorization, expected }) => {
		expect(presentedCredential(requestWith(authorization))).toStrictEqual(
			expected
		);
	});
});

describe('bearerCredential', () => {
	it.each([
		{
			name: 'a bearer access key',
			authorization: `Bearer ${keySecret}`,
			expected: { kind: 'access-key', secret: keySecret }
		},
		{
			name: 'an access key in a Basic password',
			authorization: basic('machine-7', keySecret),
			expected: undefined
		}
	])('reads $name', ({ authorization, expected }) => {
		expect(bearerCredential(requestWith(authorization))).toStrictEqual(
			expected
		);
	});
});
