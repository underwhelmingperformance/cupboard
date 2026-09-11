import { describe, expect, it } from 'vitest';
import { type ZodType } from 'zod';

import {
	tenantCreateBodySchema,
	tenantReadCredentialSchema
} from './tenants.ts';

/**
 * The fields a rejection is about. Asserting only that a parse failed lets a
 * fixture that is wrong in some other way satisfy the case, so each rejection
 * names the path it expects to fail on. An unrecognised key reports an empty
 * path, which is how a fixture that has drifted from the schema shows up here
 * rather than passing.
 */
function rejectedPaths(schema: ZodType, value: unknown): string[] {
	const result = schema.safeParse(value);

	return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

// A create body that differs from the schema only in its owner issuer, so a
// rejection can be attributed to that field alone.
function bodyWith(ownerIssuer: string): unknown {
	return {
		id: 'acme',
		defaultCacheAccess: 'public',
		ownerIssuer,
		ownerSubject: 'owner',
		ownerAudience: 'cupboard'
	};
}

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
		expect(
			rejectedPaths(tenantCreateBodySchema, bodyWith(ownerIssuer))
		).toStrictEqual(['ownerIssuer']);
	});

	// Every case above rejects on `ownerIssuer` alone, so the fixture has to be
	// otherwise valid. Without this, a fixture that drifts from the schema makes
	// all of them pass on the drift instead of on the issuer.
	it('accepts the fixture the rejections vary', () => {
		expect(
			rejectedPaths(
				tenantCreateBodySchema,
				bodyWith('https://idp.example.test')
			)
		).toStrictEqual([]);
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
			rejectedPaths(tenantReadCredentialSchema, {
				user: 'alice',
				password
			})
		).toStrictEqual(['password']);
	});

	it.each([
		{ name: 'a colon', user: 'ali:ce' },
		{ name: 'a leading colon', user: ':alice' },
		{ name: 'nothing', user: '' }
	])('rejects a user with $name', ({ user }) => {
		expect(
			rejectedPaths(tenantReadCredentialSchema, {
				user,
				password: generatedPassword
			})
		).toStrictEqual(['user']);
	});
});
