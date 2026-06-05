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

	it.each([
		{ name: 'a well-formed exchange request', value: request, valid: true },
		{
			name: 'a missing subject token',
			value: { ...request, subject_token: undefined },
			valid: false
		},
		{
			name: 'an empty grant type',
			value: { ...request, grant_type: '' },
			valid: false
		}
	])('$name', ({ value, valid }) => {
		expect(tokenExchangeRequestSchema.safeParse(value).success).toBe(valid);
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
		{ name: 'a token-exchange response', value: clientResponse, valid: true },
		{
			name: 'a response carrying issued_token_type',
			value: {
				...clientResponse,
				scope: 'write',
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
			},
			valid: true
		},
		{
			name: 'a non-Bearer token type',
			value: { ...clientResponse, token_type: 'mac' },
			valid: false
		},
		{
			name: 'a non-positive expires_in',
			value: { ...clientResponse, expires_in: 0 },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...clientResponse, surprise: true },
			valid: false
		}
	])('$name', ({ value, valid }) => {
		expect(tokenResponseSchema.safeParse(value).success).toBe(valid);
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
		{ name: 'a well-formed add body', value: addBody, valid: true },
		{
			name: 'an add body bound to a loopback issuer over http',
			value: { ...addBody, issuer: 'http://127.0.0.1:8788' },
			valid: true
		},
		{
			name: 'an add body with no claims',
			value: { ...addBody, claims: {} },
			valid: false
		},
		{
			name: 'a non-URL issuer',
			value: { ...addBody, issuer: 'not-a-url' },
			valid: false
		},
		{
			name: 'a non-loopback issuer over plain http',
			value: {
				...addBody,
				issuer: 'http://token.actions.githubusercontent.com'
			},
			valid: false
		},
		{
			name: 'an empty audience',
			value: { ...addBody, audience: '' },
			valid: false
		},
		{
			name: 'an unknown key',
			value: { ...addBody, surprise: true },
			valid: false
		}
	])('add body: $name', ({ value, valid }) => {
		expect(oidcTrustAddBodySchema.safeParse(value).success).toBe(valid);
	});

	it('normalises a trailing slash off the issuer', () => {
		const parsed = oidcTrustAddBodySchema.parse({
			...addBody,
			issuer: 'https://token.actions.githubusercontent.com/'
		});

		expect(parsed.issuer).toBe('https://token.actions.githubusercontent.com');
	});

	it('accepts the summary, list and remove responses', () => {
		expect({
			summary: oidcTrustSummarySchema.safeParse(summary).success,
			list: oidcTrustListResponseSchema.safeParse({ rules: [summary] }).success,
			remove: oidcTrustRemoveResponseSchema.safeParse({
				id: 'r1',
				removed: true
			}).success
		}).toStrictEqual({ summary: true, list: true, remove: true });
	});

	it('rejects a summary with an unknown scope', () => {
		expect(
			oidcTrustSummarySchema.safeParse({ ...summary, scope: 'root' }).success
		).toBe(false);
	});
});
