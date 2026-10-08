import {
	issuedAccessTokenType,
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import { signupResponseSchema } from '@cupboard/protocol/signup';
import { describe, expect, it } from 'vitest';

import {
	CupboardTestServer,
	signupAudience,
	signupSecret
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { signBound } from '../support/subject-binding.ts';

function postForm(url: URL, form: Record<string, string>): Promise<Response> {
	const body = new URLSearchParams(form);
	return fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: body.toString()
	});
}

async function boundForm(
	server: CupboardTestServer,
	subject: string
): Promise<Record<string, string>> {
	const bound = await signBound(
		server.issuer,
		{ aud: signupAudience, sub: subject },
		server.url
	);

	return { subject_token: bound.token, ...bound.form };
}

describe('control plane signup bootstrap', () => {
	it('claims global admin with a session, then exchanges a fresh ID token and provisions a tenant', () =>
		withTemporaryDirectory('cupboard-e2e-signup-', async (directory) => {
			// This test drives the fresh-deployment bootstrap itself, so the harness
			// must not pre-provision a tenant or seed the control trust policy.
			const server = await CupboardTestServer.start(directory, {
				provision: false
			});

			try {
				const signup = await postForm(new URL('/signup', server.url), {
					...(await boundForm(server, 'founder')),
					claim_secret: signupSecret
				});

				// A wrong claim secret is refused at the gate, even for the principal that
				// holds the claim.
				const badGate = await postForm(new URL('/signup', server.url), {
					...(await boundForm(server, 'founder')),
					claim_secret: 'wrong'
				});

				// A different principal cannot take over the claim.
				const intruder = await postForm(new URL('/signup', server.url), {
					...(await boundForm(server, 'intruder')),
					claim_secret: signupSecret
				});

				// The claim seeded control trust, so this principal can now obtain a
				// control admin token.
				const exchange = await postForm(new URL('/token', server.url), {
					grant_type: tokenExchangeGrantType,
					...(await boundForm(server, 'founder')),
					subject_token_type: subjectTokenTypeIdToken
				});
				const issued = tokenResponseSchema.parse(await exchange.json());

				// The admin token provisions a tenant.
				const create = await fetch(new URL('/control/tenants', server.url), {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${issued.access_token}`
					},
					body: JSON.stringify({
						id: 'acme',
						defaultCacheAccess: 'private',
						ownerIssuer: server.issuer.issuer,
						ownerSubject: 'owner',
						ownerAudience: signupAudience
					})
				});
				expect({
					signupStatus: signup.status,
					badGateStatus: badGate.status,
					intruderStatus: intruder.status,
					issuedGrants: issued.authorization_details,
					createStatus: create.status
				}).toStrictEqual({
					signupStatus: 200,
					badGateStatus: 403,
					intruderStatus: 409,
					issuedGrants: [{ type: 'cupboard_wildcard' }],
					createStatus: 200
				});
				const {
					access_token: accessToken,
					refresh_token: refreshToken,
					...claimed
				} = signupResponseSchema.parse(await signup.json());
				expect({
					...claimed,
					hasAccessToken: accessToken !== '',
					hasRefreshToken: refreshToken !== undefined
				}).toStrictEqual({
					issuer: server.issuer.issuer,
					subject: 'founder',
					audience: signupAudience,
					claimed: true,
					hasAccessToken: true,
					token_type: 'Bearer',
					expires_in: 600,
					issued_token_type: issuedAccessTokenType,
					hasRefreshToken: true,
					authorization_details: [{ type: 'cupboard_wildcard' }]
				});
				expect(await create.json()).toMatchObject({
					id: 'acme',
					ownerIssuer: server.issuer.issuer,
					ownerSubject: 'owner',
					ownerAudience: signupAudience,
					configVersion: 1,
					status: 'active'
				});
			} finally {
				await server.stop();
			}
		}));
});
