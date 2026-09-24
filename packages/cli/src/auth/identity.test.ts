import { describe, expect, it } from 'vitest';

import {
	providerIdentity,
	sessionIdentity,
	UnreadableIdTokenError
} from './identity.ts';

function jwtSegment(value: object): string {
	return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function jwt(claims: Record<string, unknown>): string {
	return `${jwtSegment({ alg: 'EdDSA', typ: 'JWT' })}.${jwtSegment(claims)}.signature`;
}

const tenant = 'https://cupboard.example.workers.dev/t/acme';
const deployment = 'https://cupboard.example.workers.dev';
const expiry = 1_700_000_600;

describe('sessionIdentity', () => {
	it('describes a tenant session from its access token', () => {
		expect(
			sessionIdentity({
				accessToken: jwt({
					iss: tenant,
					aud: tenant,
					sub: 'user-1',
					exp: expiry,
					cb_rule: 'owner'
				}),
				refreshToken: 'refresh'
			})
		).toStrictEqual({
			url: tenant,
			kind: 'tenant',
			subject: 'user-1',
			rule: 'owner',
			accessTokenExpiresAt: new Date(expiry * 1000).toISOString(),
			renewable: true
		});
	});

	it('describes a deployment session, whose audience is a client id', () => {
		expect(
			sessionIdentity({
				accessToken: jwt({ iss: deployment, aud: ['client-id'], sub: 'op' })
			})
		).toStrictEqual({
			url: deployment,
			kind: 'deployment',
			subject: 'op',
			renewable: false
		});
	});

	it.each([
		['a token without an issuer', jwt({ sub: 'user-1' })],
		['a token that is not a JWT', 'opaque']
	])('returns undefined for %s', (_name, accessToken) => {
		expect(sessionIdentity({ accessToken })).toBeUndefined();
	});
});

describe('providerIdentity', () => {
	it('keeps stable string claims and drops per-sign-in ones', () => {
		const identity = providerIdentity(
			jwt({
				iss: 'https://dash.cloudflare.com',
				aud: 'client-id',
				sub: 'user-1',
				email: 'someone@example.com',
				email_verified: true,
				exp: expiry,
				iat: expiry - 60,
				nonce: 'n',
				jti: 'j'
			}),
			'client-id'
		);

		expect(identity).toStrictEqual({
			issuer: 'https://dash.cloudflare.com',
			audience: 'client-id',
			subject: 'user-1',
			expiresAt: new Date(expiry * 1000).toISOString(),
			claims: { email: 'someone@example.com', sub: 'user-1' },
			rule: {
				issuer: 'https://dash.cloudflare.com',
				audience: 'client-id',
				claims: { sub: 'user-1' }
			},
			verified: false
		});
	});

	it('uses the sign-in client as the rule audience when the token names several', () => {
		const identity = providerIdentity(
			jwt({
				iss: 'https://idp.example.com',
				aud: ['other', 'client-id'],
				sub: 'user-1'
			}),
			'client-id'
		);

		expect({
			audience: identity.audience,
			ruleAudience: identity.rule.audience
		}).toStrictEqual({
			audience: ['other', 'client-id'],
			ruleAudience: 'client-id'
		});
	});

	it('falls back to the first audience when the client is not among them', () => {
		const identity = providerIdentity(
			jwt({ iss: 'https://idp.example.com', aud: ['first'], sub: 'user-1' }),
			'client-id'
		);

		expect(identity.rule.audience).toBe('first');
	});

	it.each([
		['no subject', jwt({ iss: 'https://idp.example.com', aud: 'client-id' })],
		['no audience', jwt({ iss: 'https://idp.example.com', sub: 'user-1' })],
		['an undecodable token', 'opaque']
	])('refuses a token with %s', (_name, token) => {
		expect(() => providerIdentity(token, 'client-id')).toThrow(
			UnreadableIdTokenError
		);
	});
});
