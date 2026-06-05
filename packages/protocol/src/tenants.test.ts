import { describe, expect, it } from 'vitest';

import { tenantReadCredentialSchema } from './tenants.ts';

describe('tenantReadCredentialSchema', () => {
	it('accepts a netrc-safe opaque password', () => {
		expect(
			tenantReadCredentialSchema.parse({
				user: 'alice',
				password: 'correct-horse-battery-staple'
			})
		).toStrictEqual({
			user: 'alice',
			password: 'correct-horse-battery-staple'
		});
	});

	it.each([
		'short',
		'correct horse battery staple',
		'correct\nhorse',
		'bad\u007F'
	])('rejects %s', (password) => {
		expect(
			tenantReadCredentialSchema.safeParse({ user: 'alice', password }).success
		).toBe(false);
	});
});
