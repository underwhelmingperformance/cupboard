import { NixSha256Hash } from '@cupboard/nix/hash';
import { NarInfo } from '@cupboard/nix/narinfo';
import { describe, expect, it } from 'vitest';

import {
	identityPolicy,
	type VerifiedIdentityPolicy,
	verifyLocalAttestations,
	verifyRemoteAttestations
} from './verify.ts';

const narHash = 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347';
const narDigest = [...NixSha256Hash.parse(narHash).digestBytes()]
	.map((byte) => byte.toString(16).padStart(2, '0'))
	.join('');
const storePathHash = '0123456789abcdfghijklmnpqrsvwxyz';
const bundleDigest = 'a'.repeat(64);
const sbomBundleDigest = 'b'.repeat(64);
const predicateType = 'https://slsa.dev/provenance/v1';
const sbomPredicateType = 'https://spdx.dev/Document';
const trustedRoot = 'private-trusted-root.json';
const verifierThresholds = {
	tlogThreshold: 2,
	ctlogThreshold: 3,
	timestampThreshold: 4
};

interface Ed25519KeyPair {
	readonly privateKey: CryptoKey;
	readonly publicKey: CryptoKey;
}

async function generateSigningKeyPair(): Promise<Ed25519KeyPair> {
	const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
		'sign',
		'verify'
	]);

	if (!('privateKey' in keyPair) || !('publicKey' in keyPair)) {
		throw new Error('expected an Ed25519 key pair');
	}

	return keyPair;
}

async function namedPublicKey(keyPair: Ed25519KeyPair): Promise<string> {
	const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);

	return `cache:${Buffer.from(publicKey).toString('base64')}`;
}

async function signedNarInfo(hash: string = storePathHash): Promise<{
	readonly publicKey: string;
	readonly source: string;
}> {
	const unsigned = new NarInfo(
		`/nix/store/${hash}-app`,
		'nar/example.nar.zst',
		'zstd',
		'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		123,
		narHash,
		456,
		[]
	);
	const keyPair = await generateSigningKeyPair();
	const signature = await crypto.subtle.sign(
		'Ed25519',
		keyPair.privateKey,
		new TextEncoder().encode(unsigned.fingerprint())
	);

	return {
		publicKey: await namedPublicKey(keyPair),
		source: unsigned
			.withSignature(`cache:${Buffer.from(signature).toString('base64')}`)
			.render()
	};
}

describe('attestation verification policy', () => {
	it('requires exactly one identity mode', () => {
		expect(() =>
			identityPolicy({
				certificateOidcIssuer: 'https://issuer.test'
			})
		).toThrow('Pass exactly one of --certificate-identity');

		expect(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateIdentityRegex: 'alice@.*',
				certificateOidcIssuer: 'https://issuer.test'
			})
		).toThrow('Pass exactly one of --certificate-identity');
	});

	it('requires identity and issuer modes to match', () => {
		expect(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuerRegex: 'https://issuer[.]test'
			})
		).toThrow('must both use exact values or both use regex values');
	});

	it('builds exact and regex policies', () => {
		expect(
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuer: 'https://issuer.test'
			})
		).toStrictEqual({
			mode: 'exact',
			identity: 'alice@example.test',
			issuer: 'https://issuer.test'
		});

		const regex = identityPolicy({
			certificateIdentityRegex: 'alice@.*',
			certificateOidcIssuerRegex: 'https://issuer[.]test'
		});

		if (regex.mode !== 'regex') {
			throw new Error('expected regex policy');
		}

		expect({
			mode: regex.mode,
			identity: regex.identity.source,
			issuer: regex.issuer.source
		}).toStrictEqual({
			mode: 'regex',
			identity: 'alice@.*',
			issuer: String.raw`https:\/\/issuer[.]test`
		});
	});
});

describe('local attestation verification', () => {
	const policy: VerifiedIdentityPolicy = {
		mode: 'exact',
		identity: 'alice@example.test',
		issuer: 'https://issuer.test'
	};

	it('returns verified bundle summaries when the subject matches the NAR hash', async () => {
		const results = await verifyLocalAttestations(
			{
				bundles: ['bundle.sigstore.json'],
				narHash,
				predicateType,
				trustedRoot,
				...verifierThresholds,
				certificateIdentity: policy.identity,
				certificateOidcIssuer: policy.issuer
			},
			{
				readFile: () => Promise.resolve(new Uint8Array([1])),
				verify: (_bundle, actualPolicy, options) => {
					expect(actualPolicy).toStrictEqual(policy);
					expect(options).toStrictEqual({
						trustedRoot,
						...verifierThresholds
					});

					return Promise.resolve({
						predicateType,
						subjectDigests: [narDigest],
						signer: {
							key: {} as never,
							identity: {
								subjectAlternativeName: policy.identity,
								extensions: { issuer: policy.issuer }
							}
						}
					});
				}
			}
		);

		expect(results).toStrictEqual([
			{
				bundle: 'bundle.sigstore.json',
				predicateType,
				subjectDigest: narDigest,
				signerIdentity: 'alice@example.test',
				signerIssuer: 'https://issuer.test'
			}
		]);
	});

	it('rejects a verified bundle whose subject does not match the NAR hash', async () => {
		await expect(
			verifyLocalAttestations(
				{
					bundles: ['bundle.sigstore.json'],
					narHash,
					predicateType,
					certificateIdentity: policy.identity,
					certificateOidcIssuer: policy.issuer
				},
				{
					readFile: () => Promise.resolve(new Uint8Array([1])),
					verify: () =>
						Promise.resolve({
							predicateType,
							subjectDigests: ['0'.repeat(64)],
							signer: { key: {} as never }
						})
				}
			)
		).rejects.toThrow('subject does not match');
	});

	it('rejects a verified bundle whose predicate type does not match policy', async () => {
		await expect(
			verifyLocalAttestations(
				{
					bundles: ['bundle.sigstore.json'],
					narHash,
					predicateType,
					certificateIdentity: policy.identity,
					certificateOidcIssuer: policy.issuer
				},
				{
					readFile: () => Promise.resolve(new Uint8Array([1])),
					verify: () =>
						Promise.resolve({
							predicateType: 'https://example.test/other',
							subjectDigests: [narDigest],
							signer: { key: {} as never }
						})
				}
			)
		).rejects.toThrow('predicate type does not match');
	});
});

describe('remote attestation verification', () => {
	const policy: VerifiedIdentityPolicy = {
		mode: 'exact',
		identity: 'alice@example.test',
		issuer: 'https://issuer.test'
	};

	it('verifies remote bundles through the cache read surface', async () => {
		const narInfo = await signedNarInfo();
		const stalePublicKey = await namedPublicKey(await generateSigningKeyPair());
		const recordedCalls: {
			readonly url: string;
			readonly authorisation?: string;
		}[] = [];
		const fetcher = ((
			input: string | URL | Request,
			init?: RequestInit
		): Promise<Response> => {
			const url = fetchInputUrl(input);
			const authorisation = new Headers(init?.headers).get('authorization');
			recordedCalls.push({
				url,
				authorisation: authorisation ?? undefined
			});

			if (url === 'https://cupboard.test/t/acme/pubkey') {
				return Promise.resolve(
					new Response(`${stalePublicKey}\n${narInfo.publicKey}\n`)
				);
			}

			if (
				url ===
				`https://cupboard.test/t/acme/cache/builds/${storePathHash}.narinfo`
			) {
				return Promise.resolve(new Response(narInfo.source));
			}

			if (
				url ===
				`https://cupboard.test/t/acme/cache/builds/attestations/${storePathHash}`
			) {
				return Promise.resolve(
					Response.json({
						attestations: [
							{
								digest: bundleDigest,
								predicateType,
								size: 123
							},
							{
								digest: sbomBundleDigest,
								predicateType: sbomPredicateType,
								size: 456
							}
						]
					})
				);
			}

			if (
				url ===
				`https://cupboard.test/t/acme/cache/builds/attestation-bundles/${bundleDigest}`
			) {
				return Promise.resolve(new Response(new Uint8Array([1])));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		}) as typeof fetch;

		const results = await verifyRemoteAttestations(
			{
				url: 'https://cupboard.test/t/acme',
				cache: 'builds',
				storePathHash,
				readUser: 'reader',
				readPassword: 'secret',
				trustCachePubkey: true,
				predicateType,
				trustedRoot,
				...verifierThresholds,
				certificateIdentity: policy.identity,
				certificateOidcIssuer: policy.issuer
			},
			{
				fetch: fetcher,
				verify: (_bundle, actualPolicy, options) => {
					expect(actualPolicy).toStrictEqual(policy);
					expect(options).toStrictEqual({
						trustedRoot,
						...verifierThresholds
					});

					return Promise.resolve({
						predicateType,
						subjectDigests: [narDigest],
						signer: {
							key: {} as never,
							identity: {
								subjectAlternativeName: policy.identity,
								extensions: { issuer: policy.issuer }
							}
						}
					});
				}
			}
		);

		expect(results).toStrictEqual([
			{
				bundle: bundleDigest,
				predicateType,
				subjectDigest: narDigest,
				signerIdentity: 'alice@example.test',
				signerIssuer: 'https://issuer.test'
			}
		]);

		expect(recordedCalls).toStrictEqual([
			{
				url: 'https://cupboard.test/t/acme/cache/builds/0123456789abcdfghijklmnpqrsvwxyz.narinfo',
				authorisation: 'Basic cmVhZGVyOnNlY3JldA=='
			},
			{
				url: 'https://cupboard.test/t/acme/pubkey',
				authorisation: undefined
			},
			{
				url: 'https://cupboard.test/t/acme/cache/builds/attestations/0123456789abcdfghijklmnpqrsvwxyz',
				authorisation: 'Basic cmVhZGVyOnNlY3JldA=='
			},
			{
				url: `https://cupboard.test/t/acme/cache/builds/attestation-bundles/${bundleDigest}`,
				authorisation: 'Basic cmVhZGVyOnNlY3JldA=='
			}
		]);
	});

	it('rejects a remote narinfo whose signed store path has a different hash', async () => {
		const replayedNarInfo = await signedNarInfo(
			'11111111111111111111111111111111'
		);
		const fetcher = ((input: string | URL | Request): Promise<Response> => {
			const url = fetchInputUrl(input);

			if (url === `https://cupboard.test/t/acme/${storePathHash}.narinfo`) {
				return Promise.resolve(new Response(replayedNarInfo.source));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		}) as typeof fetch;

		await expect(
			verifyRemoteAttestations(
				{
					url: 'https://cupboard.test/t/acme',
					storePathHash,
					predicateType,
					trustedPublicKey: replayedNarInfo.publicKey,
					certificateIdentity: policy.identity,
					certificateOidcIssuer: policy.issuer
				},
				{
					fetch: fetcher,
					verify: () => {
						throw new Error('bundle verifier should not be called');
					}
				}
			)
		).rejects.toThrow('store path does not match');
	});
});

function fetchInputUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.toString();
	}

	return input.url;
}
