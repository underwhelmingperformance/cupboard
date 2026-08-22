import {
	oidcAudienceSchema,
	type OidcIssuer,
	oidcIssuerSchema,
	oidcTrustAddBodySchema
} from '@cupboard/protocol/oidc';
import { RemoteBodyTooLargeError } from '@cupboard/shared/response-body';
import { StatusCodes } from 'http-status-codes';
import {
	createLocalJWKSet,
	errors as joseErrors,
	exportJWK,
	generateKeyPair,
	type JSONWebKeySet,
	type JWK,
	SignJWT
} from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	decodeInboundClaims,
	fetchOidcDiscovery,
	inboundAlgorithmAllowlist,
	type InboundVerifyOptions,
	intersectAlgorithms,
	OidcDiscoveryError,
	OidcDiscoveryStore,
	OidcKeysUnreachableError,
	OidcTokenDecodeError,
	OidcTokenVerificationError,
	verifyInboundOidcToken
} from './oidc.ts';

const issuer = oidcIssuerSchema.parse('https://accounts.example.com');
const metadataUrl =
	'https://accounts.example.com/.well-known/openid-configuration';
const audience = oidcAudienceSchema.parse('client-id.apps.example.com');
const now = new Date('2026-01-01T00:00:00.000Z');
const kid = 'idp-key-1';
const oversizedDocumentPaddingBytes = 2 * 1024 * 1024;

function streamedJsonResponse(
	value: unknown,
	status: number
): { readonly response: Response; readonly cancel: ReturnType<typeof vi.fn> } {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const split = Math.floor(bytes.byteLength / 2);
	const cancel = vi.fn();
	const body = new ReadableStream<Uint8Array>({
		cancel,
		start(controller) {
			controller.enqueue(bytes.subarray(0, split));
			controller.enqueue(bytes.subarray(split));
			controller.close();
		}
	});

	return {
		response: new Response(body, {
			status,
			headers: { 'content-type': 'application/json' }
		}),
		cancel
	};
}

function configuredRuleIssuer(configured: string): OidcIssuer {
	return oidcTrustAddBodySchema.parse({
		issuer: configured,
		audience,
		claims: { sub: 'repo:owner/repo:ref:refs/heads/main' },
		permittedGrants: [{ type: 'cupboard_wildcard' }]
	}).issuer;
}

function requestUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

function errorShape(error: Error): {
	readonly name: string;
	readonly hasCause: boolean;
} {
	return {
		name: error.name,
		hasCause: error.cause instanceof Error
	};
}

function boundedBodyFailureShape(error: unknown): {
	readonly name: string;
	readonly causeIsTooLarge: boolean;
} {
	return {
		name: error instanceof Error ? error.name : 'NonErrorFailure',
		causeIsTooLarge:
			error instanceof Error && error.cause instanceof RemoteBodyTooLargeError
	};
}

function jsonClaims(json: string): Record<string, unknown> {
	return z.record(z.string(), z.unknown()).parse(JSON.parse(json));
}

function unavailableOidcMetadata(): Promise<Response> {
	return Promise.reject(new Error('issuer is unavailable'));
}

function successfulOidcMetadata(): Promise<Response> {
	return Promise.resolve(
		Response.json({
			issuer,
			jwks_uri: 'https://accounts.example.com/jwks',
			response_types_supported: ['id_token'],
			subject_types_supported: ['public'],
			id_token_signing_alg_values_supported: ['RS256']
		})
	);
}

interface SignOptions {
	readonly at?: Date;
	readonly tokenIssuer?: string;
	readonly withExpiry?: boolean;
	readonly withIssuedAt?: boolean;
	readonly tokenAudience?: string | string[];
}

interface InboundIssuer {
	readonly jwks: JSONWebKeySet;
	sign(claims: Record<string, unknown>, at?: Date): Promise<string>;
	signWithoutExpiry(claims: Record<string, unknown>): Promise<string>;
	signWithoutIssuedAt(claims: Record<string, unknown>): Promise<string>;
	signWithAudience(
		tokenAudience: string | string[],
		claims: Record<string, unknown>
	): Promise<string>;
	signWithIssuer(
		tokenIssuer: string,
		claims: Record<string, unknown>
	): Promise<string>;
}

async function inboundIssuer(algorithm = 'RS256'): Promise<InboundIssuer> {
	const { publicKey, privateKey } = await generateKeyPair(algorithm, {
		extractable: true
	});
	const publicJwk: JWK = {
		...(await exportJWK(publicKey)),
		kid,
		alg: algorithm,
		use: 'sig'
	};

	const build = (
		claims: Record<string, unknown>,
		{
			at = now,
			tokenIssuer = issuer,
			withExpiry = true,
			withIssuedAt = true,
			tokenAudience = audience
		}: SignOptions = {}
	): Promise<string> => {
		const issuedAt = Math.floor(at.getTime() / 1000);
		const signJwt = new SignJWT(claims);
		const jwt = signJwt
			.setProtectedHeader({ alg: algorithm, kid })
			.setIssuer(tokenIssuer)
			.setAudience(tokenAudience);

		if (withIssuedAt) {
			jwt.setIssuedAt(issuedAt);
		}

		if (withExpiry) {
			jwt.setExpirationTime(issuedAt + 600);
		}

		return jwt.sign(privateKey);
	};

	return {
		jwks: { keys: [publicJwk] },
		sign: (claims, at = now) => build(claims, { at }),
		signWithoutExpiry: (claims) => build(claims, { withExpiry: false }),
		signWithoutIssuedAt: (claims) => build(claims, { withIssuedAt: false }),
		signWithAudience: (tokenAudience, claims) =>
			build(claims, { tokenAudience }),
		signWithIssuer: (tokenIssuer, claims) => build(claims, { tokenIssuer })
	};
}

function verifyOptions(
	overrides: Partial<Omit<InboundVerifyOptions, 'algorithms'>> = {}
): InboundVerifyOptions {
	return {
		issuer,
		audience,
		algorithms: inboundAlgorithmAllowlist,
		requireIdTokenClaims: true,
		...overrides
	};
}

describe('decodeInboundClaims', () => {
	it('returns the unverified claims of a well-formed token', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner', repository_id: '1234' });

		const claims = decodeInboundClaims(token);

		expect({
			iss: claims.iss,
			aud: claims.aud,
			sub: claims.sub,
			repository_id: claims.repository_id
		}).toStrictEqual({
			iss: issuer,
			aud: audience,
			sub: 'owner',
			repository_id: '1234'
		});
	});

	it('rejects a token that is not a JWT', () => {
		const error = thrownBy(() => decodeInboundClaims('not-a-jwt'));

		expect(error).toBeInstanceOf(OidcTokenDecodeError);
		if (!(error instanceof OidcTokenDecodeError)) {
			throw error;
		}

		expect(errorShape(error)).toStrictEqual({
			name: 'OidcTokenDecodeError',
			hasCause: true
		});
	});
});

describe('verifyInboundOidcToken', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it.each(['RS256', 'ES256', 'EdDSA'])(
		'verifies a %s token against the issuer JWKS',
		async (algorithm) => {
			const idp = await inboundIssuer(algorithm);
			const token = await idp.sign({ sub: 'owner' });

			const payload = await verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			);

			expect({
				iss: payload.iss,
				aud: payload.aud,
				sub: payload.sub
			}).toStrictEqual({ iss: issuer, aud: audience, sub: 'owner' });
		}
	);

	it.each([
		{
			name: 'a mismatched audience',
			options: verifyOptions({
				audience: oidcAudienceSchema.parse('someone-else')
			}),
			at: now
		},
		{
			name: 'a mismatched issuer',
			options: verifyOptions({
				issuer: oidcIssuerSchema.parse('https://evil.example.com')
			}),
			at: now
		},
		{
			name: 'an expired token',
			options: verifyOptions(),
			at: new Date(now.getTime() + 3600 * 1000)
		},
		{
			name: 'an algorithm outside the accepted set',
			options: { issuer, audience, algorithms: ['ES256'] },
			at: now
		}
	])('rejects $name', async ({ options, at }) => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });

		const error = await rejectedBy(() =>
			verifyInboundOidcToken(createLocalJWKSet(idp.jwks), token, options, at)
		);

		expect(error).toBeInstanceOf(OidcTokenVerificationError);
		if (!(error instanceof OidcTokenVerificationError)) {
			throw error;
		}

		expect(errorShape(error)).toStrictEqual({
			name: 'OidcTokenVerificationError',
			hasCause: true
		});
	});

	it('rejects a symmetric algorithm outside the asymmetric allowlist', async () => {
		const encoder = new TextEncoder();
		const secret = encoder.encode('symmetric-secret-key-of-sufficient-length');
		const issuedAt = Math.floor(now.getTime() / 1000);
		const signJwt = new SignJWT({ sub: 'owner' });
		const token = await signJwt
			.setProtectedHeader({ alg: 'HS256', kid })
			.setIssuer(issuer)
			.setAudience(audience)
			.setIssuedAt(issuedAt)
			.setExpirationTime(issuedAt + 600)
			.sign(secret);
		const jwks: JSONWebKeySet = {
			keys: [{ kty: 'oct', kid, alg: 'HS256', k: 'unused' }]
		};

		const error = await rejectedBy(() =>
			verifyInboundOidcToken(
				createLocalJWKSet(jwks),
				token,
				verifyOptions(),
				now
			)
		);

		expect(error).toBeInstanceOf(OidcTokenVerificationError);
		if (!(error instanceof OidcTokenVerificationError)) {
			throw error;
		}

		expect(errorShape(error)).toStrictEqual({
			name: 'OidcTokenVerificationError',
			hasCause: true
		});
	});

	it('rejects an inbound token without an expiry', async () => {
		const idp = await inboundIssuer();
		const token = await idp.signWithoutExpiry({ sub: 'owner' });

		const error = await rejectedBy(() =>
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		);

		expect(error).toBeInstanceOf(OidcTokenVerificationError);
		if (!(error instanceof OidcTokenVerificationError)) {
			throw error;
		}

		expect(errorShape(error)).toStrictEqual({
			name: 'OidcTokenVerificationError',
			hasCause: true
		});
	});

	it.each([
		{
			name: 'subject',
			issue: (idp: InboundIssuer) => idp.sign({})
		},
		{
			name: 'issued-at time',
			issue: (idp: InboundIssuer) => idp.signWithoutIssuedAt({ sub: 'owner' })
		}
	])('rejects an ID token with no $name', async ({ issue }) => {
		const idp = await inboundIssuer();
		const token = await issue(idp);

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it.each([
		{ name: 'a null subject', claims: jsonClaims('{"sub":null}') },
		{ name: 'an object subject', claims: { sub: { id: 'owner' } } },
		{ name: 'an empty subject', claims: { sub: '' } }
	])('rejects an ID token with $name', async ({ claims }) => {
		const idp = await inboundIssuer();
		const token = await idp.sign(claims);

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it.each([
		{ name: 'a string issued-at time', iat: 'now' },
		{ name: 'a null issued-at time', iat: jsonClaims('{"iat":null}').iat }
	])('rejects an ID token with $name', async ({ iat }) => {
		const idp = await inboundIssuer();
		const token = await idp.signWithoutIssuedAt({ sub: 'owner', iat });

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it.each([
		{ tokenAudience: [audience] },
		{ tokenAudience: [audience, audience] }
	])(
		'accepts one distinct audience without an authorised party: $tokenAudience',
		async ({ tokenAudience }) => {
			const idp = await inboundIssuer();
			const token = await idp.signWithAudience(tokenAudience, { sub: 'owner' });

			const payload = await verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			);

			expect(payload.aud).toStrictEqual(tokenAudience);
		}
	);

	it('rejects an untrusted additional audience', async () => {
		const idp = await inboundIssuer();
		const token = await idp.signWithAudience([audience, 'untrusted-client'], {
			sub: 'owner',
			azp: audience
		});

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('rejects multiple distinct audiences without an authorised party', async () => {
		const idp = await inboundIssuer();
		const token = await idp.signWithAudience([audience, 'untrusted-client'], {
			sub: 'owner'
		});

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('classifies an unsupported critical header as a bad token', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });
		const [, payload, signature] = token.split('.', 3);

		if (payload === undefined || signature === undefined) {
			throw new Error('The test issuer returned a malformed token');
		}

		const header = btoa(
			JSON.stringify({ alg: 'RS256', kid, crit: ['unknown'], unknown: true })
		)
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', '');
		const unsupported = `${header}.${payload}.${signature}`;

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				unsupported,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('rejects a token whose issuer differs by a trailing slash', async () => {
		const idp = await inboundIssuer();
		const token = await idp.signWithIssuer(`${issuer}/`, { sub: 'owner' });

		await expect(
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				verifyOptions(),
				now
			)
		).rejects.toBeInstanceOf(OidcTokenVerificationError);
	});

	it('rejects every token when the accepted algorithm set is empty', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });

		const error = await rejectedBy(() =>
			verifyInboundOidcToken(
				createLocalJWKSet(idp.jwks),
				token,
				{ issuer, audience, algorithms: [] },
				now
			)
		);

		expect(error).toBeInstanceOf(OidcTokenVerificationError);
		if (!(error instanceof OidcTokenVerificationError)) {
			throw error;
		}

		expect(errorShape(error)).toStrictEqual({
			name: 'OidcTokenVerificationError',
			hasCause: true
		});
	});

	it('classifies a JWKS retrieval failure as an unreachable issuer', async () => {
		const idp = await inboundIssuer();
		const token = await idp.sign({ sub: 'owner' });

		const error = await rejectedBy(() =>
			verifyInboundOidcToken(
				() => Promise.reject(new joseErrors.JWKSTimeout()),
				token,
				verifyOptions(),
				now
			)
		);

		expect(error).toBeInstanceOf(OidcKeysUnreachableError);
		if (!(error instanceof OidcKeysUnreachableError)) {
			throw error;
		}

		expect(errorShape(error)).toStrictEqual({
			name: 'OidcKeysUnreachableError',
			hasCause: true
		});
	});
});

describe('intersectAlgorithms', () => {
	it.each([
		{
			name: 'narrows to the advertised asymmetric algorithms',
			advertised: ['RS256'],
			expected: ['RS256']
		},
		{
			name: 'removes an advertised algorithm outside the allowlist',
			advertised: ['RS256', 'HS256'],
			expected: ['RS256']
		},
		{
			name: 'returns an empty list when no advertised algorithm is allowed',
			advertised: ['HS256'],
			expected: []
		}
	])('$name', ({ advertised, expected }) => {
		expect(
			intersectAlgorithms(advertised, inboundAlgorithmAllowlist)
		).toStrictEqual(expected);
	});
});

describe('fetchOidcDiscovery', () => {
	it('reads the jwks_uri and signing algorithms', async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requested.push(requestUrl(input));

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256', 'ES256'],
					authorization_endpoint: 'https://accounts.example.com/authorize'
				})
			);
		};

		const discovery = await fetchOidcDiscovery(issuer, fetcher);

		expect({ requested, discovery }).toStrictEqual({
			requested: [metadataUrl],
			discovery: {
				jwksUri: 'https://accounts.example.com/jwks',
				signingAlgValues: ['RS256', 'ES256']
			}
		});
	});

	it('rejects metadata without required signing algorithms', async () => {
		await expect(
			fetchOidcDiscovery(issuer, () =>
				Promise.resolve(
					Response.json({
						issuer,
						jwks_uri: 'https://accounts.example.com/jwks',
						response_types_supported: ['id_token'],
						subject_types_supported: ['public']
					})
				)
			)
		).rejects.toBeInstanceOf(OidcDiscoveryError);
	});

	it('rejects and cancels an oversized successful discovery body', async () => {
		const oversized = streamedJsonResponse(
			{
				issuer,
				jwks_uri: 'https://accounts.example.com/jwks',
				authorization_endpoint: 'https://accounts.example.com/authorize',
				response_types_supported: ['id_token'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
				extension: 'x'.repeat(oversizedDocumentPaddingBytes)
			},
			StatusCodes.OK
		);

		const error = await rejectedBy(() =>
			fetchOidcDiscovery(issuer, () => Promise.resolve(oversized.response))
		);

		expect({
			...boundedBodyFailureShape(error),
			cancellationCount: oversized.cancel.mock.calls.length
		}).toStrictEqual({
			name: 'OidcDiscoveryError',
			causeIsTooLarge: true,
			cancellationCount: 1
		});
	});

	it('rejects and cancels an oversized unsuccessful discovery body', async () => {
		const oversized = streamedJsonResponse(
			{ error: 'x'.repeat(oversizedDocumentPaddingBytes) },
			StatusCodes.NOT_FOUND
		);

		const error = await rejectedBy(() =>
			fetchOidcDiscovery(issuer, () => Promise.resolve(oversized.response))
		);

		expect({
			...boundedBodyFailureShape(error),
			cancellationCount: oversized.cancel.mock.calls.length
		}).toStrictEqual({
			name: 'OidcDiscoveryError',
			causeIsTooLarge: true,
			cancellationCount: 1
		});
	});

	it('cancels the discovery body when the fetch signal aborts', async () => {
		const abort = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, 'timeout')
			.mockReturnValue(abort.signal);
		const { promise: readStarted, resolve: markReadStarted } =
			Promise.withResolvers<true>();
		const cancel = vi.fn();
		let isCancelled = false;
		const bytes = new TextEncoder().encode(
			JSON.stringify({
				issuer,
				jwks_uri: 'https://accounts.example.com/jwks',
				response_types_supported: ['id_token'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256']
			})
		);
		const body = new ReadableStream<Uint8Array>(
			{
				cancel(reason) {
					isCancelled = true;
					cancel(reason);
				},
				pull(controller) {
					markReadStarted(true);

					return new Promise<void>((resolve) => {
						abort.signal.addEventListener(
							'abort',
							() => {
								queueMicrotask(() => {
									if (!isCancelled) {
										controller.enqueue(bytes);
										controller.close();
									}
									resolve();
								});
							},
							{ once: true }
						);
					});
				}
			},
			{ highWaterMark: 0 }
		);

		try {
			const pending = fetchOidcDiscovery(issuer, () =>
				Promise.resolve(new Response(body))
			);
			await readStarted;
			abort.abort(new DOMException('discovery timed out', 'TimeoutError'));
			const error = await rejectedBy(() => pending);

			expect({
				name: error instanceof Error ? error.name : 'NonErrorFailure',
				causeIsAbort:
					error instanceof Error && error.cause === abort.signal.reason,
				cancellationCount: cancel.mock.calls.length,
				timeoutCalls: timeout.mock.calls
			}).toStrictEqual({
				name: 'OidcDiscoveryError',
				causeIsAbort: true,
				cancellationCount: 1,
				timeoutCalls: [[15_000]]
			});
		} finally {
			timeout.mockRestore();
		}
	});

	it.each([
		{
			name: 'a non-OK response',
			fetcher: (): Promise<Response> =>
				Promise.resolve(new Response('nope', { status: 404 }))
		},
		{
			name: 'metadata without a jwks_uri',
			fetcher: (): Promise<Response> =>
				Promise.resolve(Response.json({ issuer }))
		},
		{
			name: 'metadata with a different issuer',
			fetcher: (): Promise<Response> =>
				Promise.resolve(
					Response.json({
						issuer: 'https://accounts.evil.com',
						jwks_uri: 'https://accounts.example.com/jwks'
					})
				)
		},
		{
			name: 'metadata with a non-loopback HTTP jwks_uri',
			fetcher: (): Promise<Response> =>
				Promise.resolve(
					Response.json({
						issuer,
						jwks_uri: 'http://accounts.example.com/jwks'
					})
				)
		},
		{
			name: 'a redirect away from the metadata endpoint',
			fetcher: (): Promise<Response> =>
				Promise.resolve(
					new Response(undefined, {
						status: 302,
						headers: { location: 'https://accounts.evil.com/.well-known' }
					})
				)
		}
	])('rejects $name with OidcDiscoveryError', async ({ fetcher }) => {
		const error = await rejectedBy(() => fetchOidcDiscovery(issuer, fetcher));

		expect(error).toBeInstanceOf(OidcDiscoveryError);
		if (!(error instanceof OidcDiscoveryError)) {
			throw error;
		}

		expect({
			...errorShape(error),
			issuer: error.issuer
		}).toStrictEqual({
			name: 'OidcDiscoveryError',
			hasCause: true,
			issuer
		});
	});

	it('rejects an issuer that is not an allowed URL without fetching', async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requested.push(requestUrl(input));

			return Promise.resolve(Response.json({}));
		};

		const error = await rejectedBy(() =>
			fetchOidcDiscovery(
				oidcIssuerSchema.parse('http://accounts.example.com'),
				fetcher
			)
		);

		expect(error).toBeInstanceOf(OidcDiscoveryError);
		if (!(error instanceof OidcDiscoveryError)) {
			throw error;
		}

		expect({
			...errorShape(error),
			issuer: error.issuer,
			requested
		}).toStrictEqual({
			name: 'OidcDiscoveryError',
			hasCause: true,
			issuer: 'http://accounts.example.com',
			requested: []
		});
	});
});

describe('OidcDiscoveryStore', () => {
	it('rejects and cancels an oversized JWKS body', async () => {
		const idp = await inboundIssuer();
		const oversized = streamedJsonResponse(
			{
				...idp.jwks,
				extension: 'x'.repeat(oversizedDocumentPaddingBytes)
			},
			StatusCodes.OK
		);
		const fetcher: typeof fetch = (input) =>
			requestUrl(input) === metadataUrl
				? successfulOidcMetadata()
				: Promise.resolve(oversized.response);
		const store = new OidcDiscoveryStore({ now: () => 0, fetcher });
		const resolved = await store.resolve(issuer);
		const token = await idp.sign({ sub: 'owner' });

		const error = await rejectedBy(() =>
			verifyInboundOidcToken(
				resolved.resolver,
				token,
				{ issuer, audience, algorithms: resolved.algorithms },
				now
			)
		);

		expect({
			...boundedBodyFailureShape(error),
			cancellationCount: oversized.cancel.mock.calls.length
		}).toStrictEqual({
			name: 'OidcKeysUnreachableError',
			causeIsTooLarge: true,
			cancellationCount: 1
		});
	});

	it('re-runs discovery once a cached entry is older than the cache age', async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requested.push(requestUrl(input));

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		};
		let nowMs = 0;
		const store = new OidcDiscoveryStore({ now: () => nowMs, fetcher });

		await store.resolve(issuer);
		nowMs += 5 * 60 * 1000;
		await store.resolve(issuer);
		nowMs += 6 * 60 * 1000;
		await store.resolve(issuer);

		expect(requested).toStrictEqual([
			'https://accounts.example.com/.well-known/openid-configuration',
			'https://accounts.example.com/.well-known/openid-configuration'
		]);
	});

	it('keeps exact issuer spellings in separate cache entries', async () => {
		const requested: string[] = [];
		const discoveredIssuers = [issuer, `${issuer}/`];
		const fetcher: typeof fetch = (input) => {
			requested.push(requestUrl(input));

			return Promise.resolve(
				Response.json({
					issuer: discoveredIssuers[requested.length - 1],
					jwks_uri: 'https://accounts.example.com/jwks',
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		};
		const store = new OidcDiscoveryStore({ now: () => 0, fetcher });

		for (const configured of [issuer, `${issuer}/`]) {
			await store.resolve(configuredRuleIssuer(configured));
		}

		expect({ requested }).toStrictEqual({
			requested: [metadataUrl, metadataUrl]
		});
	});

	it('uses one discovery fetch for concurrent first resolutions', async () => {
		const requested: string[] = [];
		const fetcher: typeof fetch = (input) => {
			requested.push(requestUrl(input));

			return Promise.resolve(
				Response.json({
					issuer,
					jwks_uri: 'https://accounts.example.com/jwks',
					response_types_supported: ['id_token'],
					subject_types_supported: ['public'],
					id_token_signing_alg_values_supported: ['RS256']
				})
			);
		};
		const store = new OidcDiscoveryStore({ now: () => 0, fetcher });

		await Promise.all([store.resolve(issuer), store.resolve(issuer)]);

		expect({ requested }).toStrictEqual({ requested: [metadataUrl] });
	});

	it('evicts failed discovery so the next resolve retries', async () => {
		const requested: string[] = [];
		let nextResponse = unavailableOidcMetadata;
		const fetcher: typeof fetch = (input) => {
			requested.push(requestUrl(input));
			const response = nextResponse();
			nextResponse = successfulOidcMetadata;

			return response;
		};
		const store = new OidcDiscoveryStore({ now: () => 0, fetcher });

		const error = await rejectedBy(() => store.resolve(issuer));

		expect(error).toBeInstanceOf(OidcDiscoveryError);
		if (!(error instanceof OidcDiscoveryError)) {
			throw error;
		}
		await store.resolve(issuer);

		expect({
			...errorShape(error),
			issuer: error.issuer,
			requested
		}).toStrictEqual({
			name: 'OidcDiscoveryError',
			hasCause: true,
			issuer,
			requested: [metadataUrl, metadataUrl]
		});
	});
});
