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

// 32 random bytes in base64url, the only shape a read password may take.
const generatedPassword = 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23';

describe('tenantReadCredentialSchema', () => {
	it('accepts a generated password', () => {
		const credential = { user: 'alice', password: generatedPassword };

		expect(tenantReadCredentialSchema.parse(credential)).toStrictEqual(
			credential
		);
	});

	// The stored verifier is a salted digest, so a password carrying less than
	// the full 256 bits must never reach the control plane.
	it.each([
		{ name: 'a short password', password: 'short' },
		{
			name: 'a memorable password of a plausible length',
			password: 'correct-horse-battery-staple-and-more'
		},
		{
			name: 'a password one character short',
			password: generatedPassword.slice(1)
		},
		{
			name: 'a password with a space',
			password: `${generatedPassword.slice(1)} `
		},
		{
			name: 'a password with base64 padding',
			password: `${generatedPassword.slice(1)}=`
		}
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
				password: generatedPassword
			}).success
		).toBe(false);
	});
});
