import { createPublicKey, verify as verifyEd25519 } from 'node:crypto';

import {
	subjectTokenTypeIdToken,
	tokenExchangeGrantType,
	tokenResponseSchema
} from '@cupboard/protocol/oidc';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';

// The audience the external IdP stamps into the control subject token (the control
// OAuth client id), and the audience cupboard stamps into the control token it
// mints (CUPBOARD_CONTROL_AUDIENCE, set in the harness bindings).
const subjectAudience = 'cupboard-control-client';
const controlAudience = 'cupboard-control';

const jwtPartsSchema = z.tuple([z.string(), z.string(), z.string()]);
const jwtHeaderSchema = z.object({ kid: z.string() });
const authorizationDetailSchema = z.object({ type: z.string() });
const jwtClaimsSchema = z.object({
	iss: z.string(),
	aud: z.string(),
	sub: z.string(),
	authorization_details: z.array(authorizationDetailSchema)
});
const publishedKeySchema = z.object({
	kid: z.string(),
	kty: z.string(),
	crv: z.string(),
	x: z.string()
});
const publishedJwksSchema = z.object({ keys: z.array(publishedKeySchema) });

type PublishedKey = z.infer<typeof publishedKeySchema>;

function decodeJwtClaims(token: string): z.infer<typeof jwtClaimsSchema> {
	const [, payload] = jwtPartsSchema.parse(token.split('.'));

	return jwtClaimsSchema.parse(decodeJsonPart(payload));
}

function decodeJsonPart(part: string): unknown {
	const parsed: unknown = JSON.parse(Buffer.from(part, 'base64url').toString());

	return parsed;
}

function publishedJwks(body: unknown): z.infer<typeof publishedJwksSchema> {
	return publishedJwksSchema.parse(body);
}

// Verifies an Ed25519-signed JWT against a published JWKS, selecting the key by
// the token header's `kid`. Returns false when no published key matches, so a
// control token (signed by a control key) cannot be verified against a tenant's
// key set even though both publish a JWKS at the same shape of path.
function isJwtVerifiedAgainst(
	token: string,
	keys: readonly PublishedKey[]
): boolean {
	const [headerPart, payloadPart, signaturePart] = jwtPartsSchema.parse(
		token.split('.')
	);
	const { kid } = jwtHeaderSchema.parse(decodeJsonPart(headerPart));
	const jwk = keys.find((key) => key.kid === kid);

	if (jwk === undefined) {
		return false;
	}

	// The signing algorithm is determined by the key type for Ed25519, so it is
	// passed as `undefined` for Ed25519 key types.
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
				const body = new URLSearchParams({
					grant_type: tokenExchangeGrantType,
					subject_token: subjectToken,
					subject_token_type: subjectTokenTypeIdToken
				});
				const response = await fetch(new URL('/token', server.url), {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: body.toString()
				});

				const issued = tokenResponseSchema.parse(await response.json());
				const claims = decodeJwtClaims(issued.access_token);

				// A control key is published, and the issued token carries the control
				// identity: the control issuer (the bare-host origin), the control
				// audience, the wildcard grant, and the verified external subject.
				const jwksResponse = await fetch(
					new URL('/.well-known/jwks.json', server.url)
				);
				const jwks = publishedJwks(await jwksResponse.json());

				// The tenant publishes its own, disjoint JWKS under its `/t/<tenant>/`
				// prefix; the control token must verify against the control keys and be
				// unverifiable against the tenant's.
				const tenantJwksResponse = await fetch(
					server.tenantPath('/.well-known/jwks.json')
				);
				const tenantJwks = publishedJwks(await tenantJwksResponse.json());

				expect({
					tokenStatus: response.status,
					responseGrants: issued.authorization_details,
					controlJwksStatus: jwksResponse.status,
					tenantJwksStatus: tenantJwksResponse.status,
					iss: claims.iss,
					aud: claims.aud,
					sub: claims.sub,
					grants: claims.authorization_details,
					controlKeyCount: jwks.keys.length,
					tenantKeyCount: tenantJwks.keys.length,
					verifiesAgainstControlKeys: isJwtVerifiedAgainst(
						issued.access_token,
						jwks.keys
					),
					verifiesAgainstTenantKeys: isJwtVerifiedAgainst(
						issued.access_token,
						tenantJwks.keys
					)
				}).toStrictEqual({
					tokenStatus: 200,
					responseGrants: [{ type: 'cupboard_wildcard' }],
					controlJwksStatus: 200,
					tenantJwksStatus: 200,
					iss: server.url.origin,
					aud: controlAudience,
					sub: 'global-admin',
					grants: [{ type: 'cupboard_wildcard' }],
					controlKeyCount: 1,
					tenantKeyCount: 1,
					verifiesAgainstControlKeys: true,
					verifiesAgainstTenantKeys: false
				});
			} finally {
				await server.stop();
			}
		}));
});
