import { describe, expect, it } from 'vitest';
import { type ZodType } from 'zod';

import { tenantCreateBodySchema } from './tenants.ts';

/**
The fields a rejection is about. Asserting only that a parse failed lets a
fixture that is wrong in some other way satisfy the case, so each rejection
names the path it expects to fail on. An unrecognised key reports an empty
path, which is how a fixture that has drifted from the schema shows up here
rather than passing.
*/
function rejectedPaths(schema: ZodType, value: unknown): string[] {
	const result = schema.safeParse(value);

	return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

// A create body that differs from the schema only in its owner issuer, so a
// rejection can be attributed to that field alone.
function tenantCreateBody(ownerIssuer: string): Record<string, unknown> {
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
			rejectedPaths(tenantCreateBodySchema, tenantCreateBody(ownerIssuer))
		).toStrictEqual(['ownerIssuer']);
	});

	// Every case above rejects on `ownerIssuer` alone, so the fixture has to be
	// otherwise valid. Without this, a fixture that drifts from the schema makes
	// all of them pass on the drift instead of on the issuer.
	it('accepts the valid fixture used by the rejection cases', () => {
		expect(
			rejectedPaths(
				tenantCreateBodySchema,
				tenantCreateBody('https://idp.example.test')
			)
		).toStrictEqual([]);
	});

	it('rejects the removed `read` field', () => {
		const body = {
			...tenantCreateBody('https://idp.example.test'),
			read: {
				user: 'alice',
				password: 'wRt2Qm7kZ9x1Yb4Nc6Vd8Fg0Hj3Kl5Mn7Pq9Rs1Tu23'
			}
		};

		expect(rejectedPaths(tenantCreateBodySchema, body)).toStrictEqual(['']);
	});
});
