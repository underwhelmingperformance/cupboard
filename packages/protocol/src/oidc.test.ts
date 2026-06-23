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

	it('carries authorization_details as an opaque string for the token service', () => {
		// The body validator keeps it raw; the token service parses it, so a
		// malformed value is `invalid_authorization_details`, not `invalid_request`.
		const raw = JSON.stringify([
			{ type: 'cupboard_cache', actions: ['upload:commit'], cache: 'pr-1' }
		]);
		const parsed = tokenExchangeRequestSchema.parse({
			...request,
			authorization_details: raw
		});

		expect(parsed.authorization_details).toBe(raw);
	});

	it('rejects an empty authorization_details field', () => {
		expect(
			tokenExchangeRequestSchema.safeParse({
				...request,
				authorization_details: ''
			}).success
		).toBe(false);
	});
});

describe('tokenResponseSchema', () => {
	const clientResponse = {
		access_token: 'jwt',
		token_type: 'Bearer',
		expires_in: 600
	};

	it.each([
		{
			name: 'a token-exchange response',
			value: clientResponse,
			expected: clientResponse
		},
		{
			name: 'a response carrying issued_token_type and granted details',
			value: {
				...clientResponse,
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
				authorization_details: [{ type: 'cupboard_wildcard' }]
			},
			expected: {
				...clientResponse,
				issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
				authorization_details: [{ type: 'cupboard_wildcard' }]
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
	const additionBody = {
		issuer: 'https://token.actions.githubusercontent.com',
		audience: 'https://cache.example.workers.dev',
		claims: { repository_id: '1234', repository_owner_id: '5678' },
		permittedGrants: [
			{
				type: 'cupboard_cache',
				actions: ['upload:commit', 'root:set'],
				resources: {
					cache: {
						equalsTemplate: 'pr-{ref}',
						substitutions: {
							ref: {
								claim: 'ref',
								capture: {
									pattern: '^refs/pull/(?<ref>[0-9]+)/merge$',
									group: 'ref'
								}
							}
						},
						validate: 'cacheName'
					},
					root: { equalsResource: 'cache', validate: 'rootName' }
				}
			}
		],
		display: { provider: 'github', repository: 'owner/repo' }
	};
	const summary = {
		id: 'r1',
		issuer: additionBody.issuer,
		audience: additionBody.audience,
		claims: additionBody.claims,
		permittedGrants: additionBody.permittedGrants,
		display: additionBody.display,
		disabled: false
	};

	it.each([
		{
			name: 'a well-formed add body',
			value: additionBody,
			expected: additionBody
		},
		{
			name: 'an add body bound to a loopback issuer over http',
			value: { ...additionBody, issuer: 'http://127.0.0.1:8788' },
			expected: { ...additionBody, issuer: 'http://127.0.0.1:8788' }
		},
		{
			name: 'an add body with a pattern claim',
			value: {
				...additionBody,
				claims: { job_workflow_ref: { pattern: '^owner/repo/.+@.+$' } }
			},
			expected: {
				...additionBody,
				claims: { job_workflow_ref: { pattern: '^owner/repo/.+@.+$' } }
			}
		}
	])('accepts add body: $name', ({ value, expected }) => {
		expect(oidcTrustAddBodySchema.parse(value)).toStrictEqual(expected);
	});

	it.each([
		{
			name: 'an add body with no claims',
			value: { ...additionBody, claims: {} }
		},
		{
			name: 'a non-URL issuer',
			value: { ...additionBody, issuer: 'not-a-url' }
		},
		{
			name: 'a non-loopback issuer over plain http',
			value: {
				...additionBody,
				issuer: 'http://token.actions.githubusercontent.com'
			}
		},
		{
			name: 'an empty audience',
			value: { ...additionBody, audience: '' }
		},
		{
			name: 'an unknown key',
			value: { ...additionBody, surprise: true }
		},
		{
			name: 'a claim with an unanchored pattern',
			value: {
				...additionBody,
				claims: { job_workflow_ref: { pattern: 'owner/repo/.+@.+' } }
			}
		}
	])('rejects add body: $name', ({ value }) => {
		expect(oidcTrustAddBodySchema.safeParse(value).success).toBe(false);
	});

	it('normalises a trailing slash off the issuer', () => {
		const parsed = oidcTrustAddBodySchema.parse({
			...additionBody,
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

	it('rejects a summary with an unknown grant type', () => {
		expect(
			oidcTrustSummarySchema.safeParse({
				...summary,
				permittedGrants: [{ type: 'cupboard_unknown' }]
			}).success
		).toBe(false);
	});
});
