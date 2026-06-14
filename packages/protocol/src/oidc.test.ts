import { describe, expect, it } from 'vitest';

import {
	oidcTrustAddBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema,
	tokenExchangeRequestSchema,
	tokenResponseSchema
} from './oidc.ts';

describe('tokenExchangeRequestSchema', () => {
	const request = {
		grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
		subject_token: 'inbound.jwt.value',
		subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
	};

	it('accepts a well-formed exchange request', () => {
		expect(tokenExchangeRequestSchema.parse(request)).toStrictEqual(request);
	});

	it.each([
		{
			name: 'a missing subject token',
			value: { ...request, subject_token: undefined }
		},
		{
			name: 'an empty grant type',
			value: { ...request, grant_type: '' }
		}
	])('rejects $name', ({ value }) => {
		expect(tokenExchangeRequestSchema.safeParse(value).success).toBe(false);
	});

	it('ignores the optional fields RFC 8693 permits', () => {
		const parsed = tokenExchangeRequestSchema.parse({
			...request,
			audience: 'https://cache.example.workers.dev',
			scope: 'write'
		});

		expect(parsed).toStrictEqual(request);
	});
});

describe('tokenResponseSchema', () => {
	const clientResponse = {
		access_token: 'jwt',
		token_type: 'Bearer',
		expires_in: 600,
		scope: 'admin'
	};

	it.each([
		{
			name: 'a token-exchange response',
			value: clientResponse,
			expected: clientResponse
		},
		{
			name: 'a response carrying issued_token_type',
			value: {
				...clientResponse,
				scope: 'write',
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
			},
			expected: {
				...clientResponse,
				scope: 'write',
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
			}
		}
	])('accepts $name', ({ value, expected }) => {
		expect(tokenResponseSchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'a non-Bearer token type',
			value: { ...clientResponse, token_type: 'mac' }
		},
		{
			name: 'a non-positive expires_in',
			value: { ...clientResponse, expires_in: 0 }
		},
		{
			name: 'an unknown key',
			value: { ...clientResponse, surprise: true }
		}
	])('rejects $name', ({ value }) => {
		expect(tokenResponseSchema.safeParse(value).success).toBe(false);
	});
});

describe('oidc trust schemas', () => {
	const addBody = {
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://cache.example.workers.dev',
		claims: { repository_id: '1234', repository_owner_id: '5678' },
		allowedRoots: ['github:owner/repo/']
	};
	const summary = {
		id: 'r1',
		issuer: addBody.issuer,
		audience: addBody.audience,
		scope: 'write',
		claims: addBody.claims,
		allowedRoots: addBody.allowedRoots,
		disabled: false
	};

	it.each([
		{
			name: 'a well-formed add body',
			value: addBody,
			expected: addBody
		},
		{
			name: 'an add body bound to a loopback issuer over http',
			value: { ...addBody, issuer: 'http://127.0.0.1:8788' },
			expected: { ...addBody, issuer: 'http://127.0.0.1:8788' }
		}
	])('accepts add body: $name', ({ value, expected }) => {
		expect(oidcTrustAddBodySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'an add body with no claims',
			value: { ...addBody, claims: {} }
		},
		{
			name: 'a non-URL issuer',
			value: { ...addBody, issuer: 'not-a-url' }
		},
		{
			name: 'a non-loopback issuer over plain http',
			value: {
				...addBody,
				issuer: 'http://token.actions.githubusercontent.com'
			}
		},
		{
			name: 'an empty audience',
			value: { ...addBody, audience: '' }
		},
		{
			name: 'an unknown key',
			value: { ...addBody, surprise: true }
		}
	])('rejects add body: $name', ({ value }) => {
		expect(oidcTrustAddBodySchema.safeParse(value).success).toBe(false);
	});

	it('normalises a trailing slash off the issuer', () => {
		const parsed = oidcTrustAddBodySchema.parse({
			...addBody,
			issuer: 'https://token.actions.githubusercontent.com/'
		});

		expect(parsed.issuer).toBe('https://token.actions.githubusercontent.com');
	});

	it('accepts the summary, list and remove responses', () => {
		const remove = { id: 'r1', removed: true };

		expect({
			summary: oidcTrustSummarySchema.parse(summary),
			list: oidcTrustListResponseSchema.parse({ rules: [summary] }),
			remove: oidcTrustRemoveResponseSchema.parse(remove)
		}).toStrictEqual({
			summary,
			list: { rules: [summary] },
			remove
		});
	});

	it('rejects a summary with an unknown scope', () => {
		expect(
			oidcTrustSummarySchema.safeParse({ ...summary, scope: 'root' }).success
		).toBe(false);
	});
});
