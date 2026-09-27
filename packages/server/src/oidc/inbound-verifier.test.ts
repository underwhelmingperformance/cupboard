import { oidcAudienceSchema, oidcIssuerSchema } from '@cupboard/protocol/oidc';
import {
	errors as joseErrors,
	exportJWK,
	generateKeyPair,
	type JWK,
	SignJWT
} from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { InboundTokenVerifier } from './inbound-verifier.ts';
import {
	OidcDiscoveryError,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	type ResolvedIssuer
} from './oidc.ts';

const issuer = oidcIssuerSchema.parse('https://idp.example.test');
const audience = oidcAudienceSchema.parse('cupboard');

interface SigningKey {
	readonly jwk: JWK;
	readonly token: string;
}

async function signingKey(): Promise<SigningKey> {
	const { publicKey, privateKey } = await generateKeyPair('RS256', {
		extractable: true
	});
	const token = await new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: 'idp' })
		.setIssuer(issuer)
		.setAudience(audience)
		.setSubject('owner')
		.setIssuedAt()
		.setExpirationTime('5m')
		.sign(privateKey);

	return {
		jwk: { ...(await exportJWK(publicKey)), kid: 'idp', alg: 'RS256' },
		token
	};
}

async function verificationError(
	verifier: InboundTokenVerifier,
	token: string
): Promise<unknown> {
	try {
		await verifier.verify({ issuer, audience }, token, new Set());
	} catch (error) {
		return error;
	}

	return new Error('the verification succeeded');
}

describe('InboundTokenVerifier', () => {
	it.each([
		{
			name: 'retries an unreachable key set once, then reports the issuer unavailable',
			resolve: () =>
				Promise.resolve<ResolvedIssuer>({
					resolver: () =>
						Promise.reject(
							new OidcKeysUnreachableError({ cause: new Error('timeout') })
						),
					algorithms: ['RS256']
				}),
			expected: { name: 'IssuerUnavailableError', resolutions: 2 }
		},
		{
			name: 'retries a failed discovery once, then reports the issuer unavailable',
			resolve: () =>
				Promise.reject(
					new OidcDiscoveryError(issuer, { cause: new Error('timeout') })
				),
			expected: { name: 'IssuerUnavailableError', resolutions: 2 }
		},
		{
			name: 'refuses a token whose key the issuer does not publish',
			resolve: () =>
				Promise.resolve<ResolvedIssuer>({
					resolver: () => Promise.reject(new joseErrors.JWKSNoMatchingKey()),
					algorithms: ['RS256']
				}),
			expected: { name: 'SubjectTokenVerificationFailedError', resolutions: 1 }
		},
		{
			name: 'passes an unexpected fault in the key resolver through without a retry',
			resolve: () =>
				Promise.resolve<ResolvedIssuer>({
					resolver: () => Promise.reject(new TypeError('the resolver failed')),
					algorithms: ['RS256']
				}),
			expected: { name: 'TypeError', resolutions: 1 }
		},
		{
			name: 'passes an unexpected fault in discovery through without a retry',
			resolve: () => Promise.reject(new TypeError('discovery failed')),
			expected: { name: 'TypeError', resolutions: 1 }
		}
	])('$name', async ({ resolve, expected }) => {
		let resolutions = 0;
		const verifier = new InboundTokenVerifier({
			resolve: () => {
				resolutions += 1;

				return resolve();
			}
		});
		const { token } = await signingKey();

		const error = await verificationError(verifier, token);

		expect({
			name: error instanceof Error ? error.name : error,
			resolutions
		}).toStrictEqual(expected);
	});

	it('passes a fault in key import through the discovery store without a retry', async () => {
		const { jwk, token } = await signingKey();
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			const url = input instanceof Request ? input.url : String(input);
			requested.push(url);

			return Promise.resolve(
				url.endsWith('/.well-known/openid-configuration')
					? Response.json({
							issuer,
							jwks_uri: `${issuer}/jwks`,
							id_token_signing_alg_values_supported: ['RS256']
						})
					: Response.json({ keys: [jwk] })
			);
		};
		const verifier = new InboundTokenVerifier(
			new OidcDiscoveryStore({ now: () => 0, fetcher })
		);
		const fault = new TypeError('the key could not be imported');
		const importKey = vi
			.spyOn(crypto.subtle, 'importKey')
			.mockRejectedValue(fault);

		try {
			const error = await verificationError(verifier, token);

			expect({ isFault: error === fault, requested }).toStrictEqual({
				isFault: true,
				requested: [
					`${issuer}/.well-known/openid-configuration`,
					`${issuer}/jwks`
				]
			});
		} finally {
			importKey.mockRestore();
		}
	});
});
