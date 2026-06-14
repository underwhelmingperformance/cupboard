import { describe, expect, it } from 'vitest';

import { tenantReadCredentialSchema } from './tenants.ts';

describe('tenantReadCredentialSchema', () => {
	it('accepts a netrc-safe opaque password', () => {
		const credential = {
			user: 'alice',
			password: 'correct-horse-battery-staple'
		};

		expect(tenantReadCredentialSchema.parse(credential)).toStrictEqual(
			credential
		);
	});

	it.each([
		{ name: 'a too-short password', password: 'short' },
		{
			name: 'a password with a space',
			password: 'correct horse battery staple'
		},
		{ name: 'a password with a newline', password: 'correct\nhorse' },
		{ name: 'a password with a DEL character', password: 'bad' }
	])('rejects $name', ({ password }) => {
		expect(
			tenantReadCredentialSchema.safeParse({ user: 'alice', password }).success
		).toBe(false);
	});
});
