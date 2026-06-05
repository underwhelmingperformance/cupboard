import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType
} from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';

import {
	CupboardTestServer,
	signupAudience,
	signupSecret
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

function postForm(url: URL, form: Record<string, string>): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(form).toString()
	});
}

describe('control plane signup bootstrap', () => {
	it('claims global admin, then mints an admin token and provisions a tenant', () =>
		withTemporaryDirectory('cupboard-e2e-signup-', async (directory) => {
			// This test drives the fresh-deployment bootstrap itself, so the harness
			// must not pre-provision a tenant or seed the control trust policy.
			const server = await CupboardTestServer.start(directory, {
				provision: false
			});

			try {
				const signup = await postForm(new URL('/signup', server.url), {
					subject_token: server.issuer.sign({
						aud: signupAudience,
						sub: 'founder'
					}),
					claim_secret: signupSecret
				});
				const claim = (await signup.json()) as {
					issuer: string;
					subject: string;
					claimed: boolean;
				};

				// A wrong claim secret is refused at the gate, even for the principal that
				// holds the claim.
				const badGate = await postForm(new URL('/signup', server.url), {
					subject_token: server.issuer.sign({
						aud: signupAudience,
						sub: 'founder'
					}),
					claim_secret: 'wrong'
				});

				// A different principal cannot take over the claim.
				const intruder = await postForm(new URL('/signup', server.url), {
					subject_token: server.issuer.sign({
						aud: signupAudience,
						sub: 'intruder'
					}),
					claim_secret: signupSecret
				});

				// The claim seeded control trust, so this principal can now mint a
				// control admin token.
				const exchange = await postForm(new URL('/token', server.url), {
					grant_type: tokenExchangeGrantType,
					subject_token: server.issuer.sign({
						aud: signupAudience,
						sub: 'founder'
					}),
					subject_token_type: subjectTokenTypeIdToken
				});
				const minted = (await exchange.json()) as {
					access_token: string;
					scope: string;
				};

				// The admin token provisions a tenant.
				const create = await fetch(new URL('/control/tenants', server.url), {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						authorization: `Bearer ${minted.access_token}`
					},
					body: JSON.stringify({
						id: 'acme',
						readMode: 'private',
						ownerIssuer: server.issuer.issuer,
						ownerSubject: 'owner',
						ownerAudience: signupAudience
					})
				});
				const created = (await create.json()) as {
					id: string;
					status: string;
				};

				expect({
					signupStatus: signup.status,
					claim,
					badGateStatus: badGate.status,
					intruderStatus: intruder.status,
					mintedScope: minted.scope,
					createStatus: create.status,
					created: { id: created.id, status: created.status }
				}).toStrictEqual({
					signupStatus: 200,
					claim: {
						issuer: server.issuer.issuer,
						subject: 'founder',
						claimed: true
					},
					badGateStatus: 403,
					intruderStatus: 409,
					mintedScope: 'admin',
					createStatus: 200,
					created: { id: 'acme', status: 'active' }
				});
			} finally {
				await server.stop();
			}
		}));
});
