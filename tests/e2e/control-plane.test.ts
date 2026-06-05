import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType
} from '../../packages/shared/src/messages.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

// The audience the external IdP stamps into the control subject token (the control
// OAuth client id), and the audience cupboard stamps into the control token it
// mints (CUPBOARD_CONTROL_AUDIENCE, set in the harness bindings).
const subjectAudience = 'cupboard-control-client';
const controlAudience = 'cupboard-control';

interface PublishedKey {
	readonly kid: string;
	readonly kty: string;
	readonly crv: string;
	readonly x: string;
}

function decodeJwtClaims(token: string): Record<string, unknown> {
	const payload = token.split('.')[1] ?? '';

	return JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
		string,
		unknown
	>;
}

// Verifies an Ed25519-signed JWT against a published JWKS, selecting the key by
// the token header's `kid`. Returns false when no published key matches, so a
// control token (signed by a control key) cannot be verified against a tenant's
// key set even though both publish a JWKS at the same shape of path.
function jwtVerifiesAgainst(
	token: string,
	keys: readonly PublishedKey[]
): boolean {
	const [headerPart, payloadPart, signaturePart] = token.split('.');

	if (
		headerPart === undefined ||
		payloadPart === undefined ||
		signaturePart === undefined
	) {
		return false;
	}

	const { kid } = JSON.parse(
		Buffer.from(headerPart, 'base64url').toString()
	) as { kid?: string };
	const jwk = keys.find((key) => key.kid === kid);

	if (jwk === undefined) {
		return false;
	}

	// The signing algorithm is determined by the key type for Ed25519, so it is
	// passed as `undefined` rather than a digest name.
	return verifyEd25519(
		undefined,
		Buffer.from(`${headerPart}.${payloadPart}`),
		createPublicKey({ key: jwk, format: 'jwk' }),
		Buffer.from(signaturePart, 'base64url')
	);
}

describe('control plane token exchange', () => {
	it('mints a global-admin token for the control issuer from a trusted token', () =>
		withTemporaryDirectory('cupboard-e2e-control-', async (directory) => {
			const server = await CupboardTestServer.start(directory);

			try {
				await server.seedControlTrust({
					issuer: server.issuer.issuer,
					audience: subjectAudience,
					claims: { sub: 'global-admin' }
				});

				const subjectToken = server.issuer.sign({
					aud: subjectAudience,
					sub: 'global-admin'
				});
				const response = await fetch(new URL('/token', server.url), {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({
						grant_type: tokenExchangeGrantType,
						subject_token: subjectToken,
						subject_token_type: subjectTokenTypeIdToken
					}).toString()
				});

				expect(response.status).toBe(200);
				const minted = (await response.json()) as {
					access_token: string;
					scope: string;
				};
				const claims = decodeJwtClaims(minted.access_token);

				// A control key is published, and the minted token carries the control
				// identity: the control issuer (the bare-host origin), the control
				// audience, the admin scope, and the verified external subject.
				const jwksResponse = await fetch(
					new URL('/.well-known/jwks.json', server.url)
				);
				const jwks = (await jwksResponse.json()) as {
					keys: PublishedKey[];
				};

				// The tenant publishes its own, disjoint JWKS under its `/t/<tenant>/`
				// prefix; the control token must verify against the control keys and be
				// unverifiable against the tenant's.
				const tenantJwksResponse = await fetch(
					server.tenantPath('/.well-known/jwks.json')
				);
				const tenantJwks = (await tenantJwksResponse.json()) as {
					keys: PublishedKey[];
				};

				expect({
					responseScope: minted.scope,
					iss: claims.iss,
					aud: claims.aud,
					sub: claims.sub,
					scope: claims.scope,
					controlKeyCount: jwks.keys.length,
					verifiesAgainstControlKeys: jwtVerifiesAgainst(
						minted.access_token,
						jwks.keys
					),
					verifiesAgainstTenantKeys: jwtVerifiesAgainst(
						minted.access_token,
						tenantJwks.keys
					)
				}).toStrictEqual({
					responseScope: 'admin',
					iss: server.url.origin,
					aud: controlAudience,
					sub: 'global-admin',
					scope: 'admin',
					controlKeyCount: 1,
					verifiesAgainstControlKeys: true,
					verifiesAgainstTenantKeys: false
				});
			} finally {
				await server.stop();
			}
		}));
});
