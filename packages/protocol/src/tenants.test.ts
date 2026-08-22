import { describe, expect, it } from 'vitest';

import {
	tenantCreateBodySchema,
	tenantReadCredentialSchema
} from './tenants.ts';

describe('tenantCreateBodySchema', () => {
	it.each([
		'not-an-issuer',
		'https://alice@idp.example.test',
		'https://alice:secret@idp.example.test',
		'https://idp.example.test?tenant=acme',
		'https://idp.example.test#issuer',
		'https://idp.example.test?',
		'https://idp.example.test#',
		'https://@idp.example.test',
		'https://:@idp.example.test'
	])('rejects an invalid owner issuer: %s', (ownerIssuer) => {
		const body = {
			id: 'acme',
			readMode: 'public',
			ownerIssuer,
			ownerSubject: 'owner',
			ownerAudience: 'cupboard'
		};

		expect(tenantCreateBodySchema.safeParse(body).success).toBe(false);
	});
});

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

	it.each([
		{ name: 'a colon', user: 'ali:ce' },
		{ name: 'a leading colon', user: ':alice' },
		{ name: 'nothing', user: '' }
	])('rejects a user with $name', ({ user }) => {
		expect(
			tenantReadCredentialSchema.safeParse({
				user,
				password: 'correct-horse-battery-staple'
			}).success
		).toBe(false);
	});
});
