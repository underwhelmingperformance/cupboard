import { describe, expect, it } from 'vitest';

import {
	controlOidcTrustAddBodySchema,
	oidcTrustAddBodySchema,
	oidcTrustListResponseSchema,
	oidcTrustRemoveResponseSchema,
	oidcTrustSummarySchema,
	refreshTokenGrantRequestSchema,
	refreshTokenGrantType,
	subjectTokenProblems,
	subjectTokenProblemSchema,
	tokenExchangeGrantRequestSchema,
	tokenExchangeRequestSchema,
	tokenRequestSchema,
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

	it.each([
		'audience',
		'resource',
		'scope',
		'requested_token_type',
		'actor_token',
		'actor_token_type'
	])('rejects the unsupported %s field', (field) => {
		expect(
			tokenExchangeRequestSchema.safeParse({
				...request,
				[field]: 'unsupported'
			}).success
		).toBe(false);
	});

	it('ignores an unknown extension parameter', () => {
		expect(
			tokenExchangeRequestSchema.parse({
				...request,
				'urn:example:extension': 'value'
			})
		).toStrictEqual(request);
	});

	it('rejects a repeated singleton parameter', () => {
		expect(
			tokenExchangeRequestSchema.safeParse({
				...request,
				subject_token: ['first', 'second']
			}).success
		).toBe(false);
	});

	it('leaves authorization_details encoded for the token service', () => {
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

describe('tokenRequestSchema', () => {
	it('preserves singleton fields without applying grant-specific validation', () => {
		const request = {
			grant_type: 'authorization_code',
			subject_token: '',
			resource: 'https://resource.example',
			extension: 'value'
		};

		expect(tokenRequestSchema.parse(request)).toStrictEqual(request);
	});
});

describe('tokenExchangeGrantRequestSchema', () => {
	const request = {
		grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
		subject_token: 'inbound.jwt.value',
		subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
	};

	it.each([
		{
			name: 'a missing subject token',
			value: { ...request, subject_token: undefined }
		},
		{
			name: 'a missing subject token type',
			value: { ...request, subject_token_type: undefined }
		},
		{
			name: 'a refresh token',
			value: { ...request, refresh_token: 'refresh-token' }
		}
	])('rejects $name', ({ value }) => {
		expect(tokenExchangeGrantRequestSchema.safeParse(value).success).toBe(
			false
		);
	});
});

describe('refreshTokenGrantRequestSchema', () => {
	const request = {
		grant_type: refreshTokenGrantType,
		refresh_token: 'refresh-token'
	};

	it('accepts a well-formed refresh request', () => {
		expect(refreshTokenGrantRequestSchema.parse(request)).toStrictEqual(
			request
		);
	});

	it.each([
		{
			name: 'a missing refresh token',
			value: { ...request, refresh_token: undefined }
		},
		{
			name: 'a subject token',
			value: { ...request, subject_token: 'inbound.jwt.value' }
		},
		{
			name: 'a subject token type',
			value: {
				...request,
				subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
			}
		}
	])('rejects $name', ({ value }) => {
		expect(refreshTokenGrantRequestSchema.safeParse(value).success).toBe(false);
	});

	it.each([
		'audience',
		'resource',
		'scope',
		'requested_token_type',
		'actor_token',
		'actor_token_type'
	])('rejects the unsupported %s field', (field) => {
		expect(
			refreshTokenGrantRequestSchema.safeParse({
				...request,
				[field]: 'unsupported'
			}).success
		).toBe(false);
	});

	it('ignores an unknown extension parameter', () => {
		expect(
			refreshTokenGrantRequestSchema.parse({
				...request,
				'urn:example:extension': 'value'
			})
		).toStrictEqual(request);
	});
});

describe('subjectTokenProblemSchema', () => {
	it('parses every stable subject-token problem value', () => {
		expect(
			Object.values(subjectTokenProblems).map((problem) =>
				subjectTokenProblemSchema.parse(problem)
			)
		).toStrictEqual([
			'subject-token-invalid',
			'subject-token-untrusted',
			'subject-token-claim-mismatch'
		]);
	});

	it('rejects an unknown subject-token problem', () => {
		expect(
			subjectTokenProblemSchema.safeParse('subject-token-new-problem').success
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
			name: 'an issuer with a username',
			value: { ...additionBody, issuer: 'https://alice@idp.example.test' }
		},
		{
			name: 'an issuer with a password',
			value: {
				...additionBody,
				issuer: 'https://alice:secret@idp.example.test'
			}
		},
		{
			name: 'an issuer with a query',
			value: { ...additionBody, issuer: 'https://idp.example.test?tenant=acme' }
		},
		{
			name: 'an issuer with a fragment',
			value: { ...additionBody, issuer: 'https://idp.example.test#issuer' }
		},
		{
			name: 'an issuer with a bare query',
			value: { ...additionBody, issuer: 'https://idp.example.test?' }
		},
		{
			name: 'an issuer with a bare fragment',
			value: { ...additionBody, issuer: 'https://idp.example.test#' }
		},
		{
			name: 'an issuer with bare userinfo',
			value: { ...additionBody, issuer: 'https://@idp.example.test' }
		},
		{
			name: 'an issuer with bare userinfo separators',
			value: { ...additionBody, issuer: 'https://:@idp.example.test' }
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

	it('preserves a trailing slash in the issuer', () => {
		const parsed = oidcTrustAddBodySchema.parse({
			...additionBody,
			issuer: 'https://token.actions.githubusercontent.com/'
		});

		expect(parsed.issuer).toBe('https://token.actions.githubusercontent.com/');
	});

	it('requires an exact subject for control trust', () => {
		const exact = { ...additionBody, claims: { sub: 'operator' } };
		const patterned = {
			...additionBody,
			claims: { sub: { pattern: '^operator.*$' } }
		};

		expect({
			exact: controlOidcTrustAddBodySchema.safeParse(exact).success,
			patterned: controlOidcTrustAddBodySchema.safeParse(patterned).success,
			missing: controlOidcTrustAddBodySchema.safeParse(additionBody).success
		}).toStrictEqual({ exact: true, patterned: false, missing: false });
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
