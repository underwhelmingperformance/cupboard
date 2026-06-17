import { createPublicKey } from 'node:crypto';

import { NixSha256Hash } from '@cupboard/nix/hash';
import { NarInfo } from '@cupboard/nix/narinfo';
import { StorePath } from '@cupboard/nix/store-path';
import type { Signer } from '@sigstore/verify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	AttestationPredicateTypeMismatchError,
	AttestationSubjectMismatchError,
	CertificateIdentityModeError,
	CertificateIssuerModeError,
	CertificatePolicyModeMismatchError,
	identityPolicy,
	RemoteNarInfoStorePathMismatchError,
	type VerifiedIdentityPolicy,
	verifyLocalAttestations,
	verifyRemoteAttestations
} from './verify.ts';

const narHash = 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347';
const narDigest = [...NixSha256Hash.parse(narHash).digestBytes()]
	.map((byte) => byte.toString(16).padStart(2, '0'))
	.join('');

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}
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

interface JsonWebKey {
	readonly alg?: string;
	readonly crv?: string;
	readonly d?: string;
	readonly ext?: boolean;
	readonly key_ops?: string[];
	readonly kty?: string;
	readonly x?: string;
}

interface SigningKeyFixture {
	readonly privateKey: JsonWebKey;
	readonly publicKey: JsonWebKey;
}

const fallbackSigningKeyFixture: SigningKeyFixture = {
	privateKey: {
		key_ops: ['sign'],
		ext: true,
		alg: 'Ed25519',
		crv: 'Ed25519',
		d: '95_cr7rZkd-LXcr6qRbgZKCGFW9gqbIWGxir2o5NYAY',
		x: '74apN5wWAk7Q7yJ1hzf0EMHdcmIRanVgF1Xqz-VpOl8',
		kty: 'OKP'
	},
	publicKey: {
		key_ops: ['verify'],
		ext: true,
		alg: 'Ed25519',
		crv: 'Ed25519',
		x: '74apN5wWAk7Q7yJ1hzf0EMHdcmIRanVgF1Xqz-VpOl8',
		kty: 'OKP'
	}
};

const signingKeyFixtures = [
	fallbackSigningKeyFixture,
	{
		privateKey: {
			key_ops: ['sign'],
			ext: true,
			alg: 'Ed25519',
			crv: 'Ed25519',
			d: 'zG6r2ltCQlzKarFboppFA7hKC87ijVwo_FF_zXInf7A',
			x: '0VP8Lp9S44d-OtJwIqEYWmYwCr0agrgoD5m6Fqi5WVQ',
			kty: 'OKP'
		},
		publicKey: {
			key_ops: ['verify'],
			ext: true,
			alg: 'Ed25519',
			crv: 'Ed25519',
			x: '0VP8Lp9S44d-OtJwIqEYWmYwCr0agrgoD5m6Fqi5WVQ',
			kty: 'OKP'
		}
	},
	{
		privateKey: {
			key_ops: ['sign'],
			ext: true,
			alg: 'Ed25519',
			crv: 'Ed25519',
			d: 'mctC2Wtr6n5TdCCQYzhwYxg7JbUk2XsaPthypOh80z8',
			x: 'odRFQRtNeZ5sbNo9kRLaVyXXaFXf4Fi9iz5s-JnKpws',
			kty: 'OKP'
		},
		publicKey: {
			key_ops: ['verify'],
			ext: true,
			alg: 'Ed25519',
			crv: 'Ed25519',
			x: 'odRFQRtNeZ5sbNo9kRLaVyXXaFXf4Fi9iz5s-JnKpws',
			kty: 'OKP'
		}
	},
	{
		privateKey: {
			key_ops: ['sign'],
			ext: true,
			alg: 'Ed25519',
			crv: 'Ed25519',
			d: 'XYQdtxKcV4OwRANdraL1_0HXLzVCcML9sqqmUllvXtw',
			x: 'BQW0MkBrLmMMnQ8GZDx4pA7acN_YSpo2T43bP7mviYc',
			kty: 'OKP'
		},
		publicKey: {
			key_ops: ['verify'],
			ext: true,
			alg: 'Ed25519',
			crv: 'Ed25519',
			x: 'BQW0MkBrLmMMnQ8GZDx4pA7acN_YSpo2T43bP7mviYc',
			kty: 'OKP'
		}
	}
] satisfies readonly SigningKeyFixture[];

let nextSigningKeyFixture = 0;

function verifiedSigner(policy: VerifiedIdentityPolicy): Signer {
	return {
		key: createPublicKey({
			key: Buffer.from(
				'MCowBQYDK2VwAyEA74apN5wWAk7Q7yJ1hzf0EMHdcmIRanVgF1Xqz+VpOl8=',
				'base64'
			),
			format: 'der',
			type: 'spki'
		}),
		identity: {
			subjectAlternativeName:
				policy.mode === 'exact' ? policy.identity : policy.identity.source,
			extensions: {
				issuer: policy.mode === 'exact' ? policy.issuer : policy.issuer.source
			}
		}
	};
}

async function generateSigningKeyPair(): Promise<Ed25519KeyPair> {
	const fixture = z
		.custom<SigningKeyFixture>((value) => value !== undefined)
		.parse(
			signingKeyFixtures[nextSigningKeyFixture % signingKeyFixtures.length]
		);
	nextSigningKeyFixture += 1;
	const [privateKey, publicKey] = await Promise.all([
		crypto.subtle.importKey('jwk', fixture.privateKey, 'Ed25519', true, [
			'sign'
		]),
		crypto.subtle.importKey('jwk', fixture.publicKey, 'Ed25519', true, [
			'verify'
		])
	]);

	return { privateKey, publicKey };
}

async function namedPublicKey(keyPair: Ed25519KeyPair): Promise<string> {
	const publicKey = await crypto.subtle.exportKey('raw', keyPair.publicKey);

	return `cache:${Buffer.from(publicKey).toString('base64')}`;
}

async function signedNarInfo(hash: string = storePathHash): Promise<{
	readonly publicKey: string;
	readonly source: string;
}> {
	const unsigned = NarInfo.fromFields({
		storePath: `/nix/store/${hash}-app`,
		url: 'nar/example.nar.zst',
		compression: 'zstd',
		fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		fileSize: 123,
		narHash,
		narSize: 456,
		references: [],
		sigs: []
	});
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
		const missing_ = thrownBy(() =>
			identityPolicy({
				certificateOidcIssuer: 'https://issuer.test'
			})
		);
		const conflicting_ = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateIdentityRegex: 'alice@.*',
				certificateOidcIssuer: 'https://issuer.test'
			})
		);

		expect(missing_).toBeInstanceOf(CertificateIdentityModeError);
		expect(conflicting_).toBeInstanceOf(CertificateIdentityModeError);

		if (
			missing_ instanceof CertificateIdentityModeError &&
			conflicting_ instanceof CertificateIdentityModeError
		) {
			expect({
				missing: { name: missing_.name, identityModes: missing_.identityModes },
				conflicting: {
					name: conflicting_.name,
					identityModes: conflicting_.identityModes
				}
			}).toStrictEqual({
				missing: {
					name: 'CertificateIdentityModeError',
					identityModes: []
				},
				conflicting: {
					name: 'CertificateIdentityModeError',
					identityModes: ['exact', 'regex']
				}
			});
		}
	});

	it('requires exactly one issuer mode', () => {
		const missing_ = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test'
			})
		);
		const conflicting_ = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuer: 'https://issuer.test',
				certificateOidcIssuerRegex: 'https://issuer[.]test'
			})
		);

		expect(missing_).toBeInstanceOf(CertificateIssuerModeError);
		expect(conflicting_).toBeInstanceOf(CertificateIssuerModeError);

		if (
			missing_ instanceof CertificateIssuerModeError &&
			conflicting_ instanceof CertificateIssuerModeError
		) {
			expect({
				missing: { name: missing_.name, issuerModes: missing_.issuerModes },
				conflicting: {
					name: conflicting_.name,
					issuerModes: conflicting_.issuerModes
				}
			}).toStrictEqual({
				missing: {
					name: 'CertificateIssuerModeError',
					issuerModes: []
				},
				conflicting: {
					name: 'CertificateIssuerModeError',
					issuerModes: ['exact', 'regex']
				}
			});
		}
	});

	it('requires identity and issuer modes to match', () => {
		const error_ = thrownBy(() =>
			identityPolicy({
				certificateIdentity: 'alice@example.test',
				certificateOidcIssuerRegex: 'https://issuer[.]test'
			})
		);

		expect(error_).toBeInstanceOf(CertificatePolicyModeMismatchError);

		if (error_ instanceof CertificatePolicyModeMismatchError) {
			expect({
				name: error_.name,
				identityMode: error_.identityMode,
				issuerMode: error_.issuerMode
			}).toStrictEqual({
				name: 'CertificatePolicyModeMismatchError',
				identityMode: 'exact',
				issuerMode: 'regex'
			});
		}
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

		expect(regex).toStrictEqual({
			mode: 'regex',
			identity: /alice@.*/,
			issuer: /https:\/\/issuer[.]test/
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
						signer: verifiedSigner(policy)
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
		const outcome = await verifyLocalAttestations(
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
						signer: verifiedSigner(policy)
					})
			}
		).then(
			(results) => ({ results }),
			(error_: unknown) => {
				const error = z
					.instanceof(AttestationSubjectMismatchError)
					.parse(error_);

				return {
					error: {
						name: error.name,
						expectedSubjectDigest: error.expectedSubjectDigest,
						subjectDigests: error.subjectDigests
					}
				};
			}
		);

		expect(outcome).toStrictEqual({
			error: {
				name: AttestationSubjectMismatchError.name,
				expectedSubjectDigest: narDigest,
				subjectDigests: ['0'.repeat(64)]
			}
		});
	});

	it('rejects a verified bundle whose predicate type does not match policy', async () => {
		const outcome = await verifyLocalAttestations(
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
						signer: verifiedSigner(policy)
					})
			}
		).then(
			(results) => ({ results }),
			(error_: unknown) => {
				const error = z
					.instanceof(AttestationPredicateTypeMismatchError)
					.parse(error_);

				return {
					error: {
						name: error.name,
						expectedPredicateType: error.expectedPredicateType,
						actualPredicateType: error.actualPredicateType
					}
				};
			}
		);

		expect(outcome).toStrictEqual({
			error: {
				name: AttestationPredicateTypeMismatchError.name,
				expectedPredicateType: predicateType,
				actualPredicateType: 'https://example.test/other'
			}
		});
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
		const fetcher: typeof fetch = (input, init) => {
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
		};

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
						signer: verifiedSigner(policy)
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
		const replayedHash = '11111111111111111111111111111111';
		const replayedStorePath = `/nix/store/${replayedHash}-app`;
		const replayedNarInfo = await signedNarInfo(replayedHash);
		const fetches: string[] = [];
		const fetcher: typeof fetch = (input) => {
			const url = fetchInputUrl(input);
			fetches.push(url);

			if (url === `https://cupboard.test/t/acme/${storePathHash}.narinfo`) {
				return Promise.resolve(new Response(replayedNarInfo.source));
			}

			return Promise.resolve(new Response('not found', { status: 404 }));
		};

		const outcome = await verifyRemoteAttestations(
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
				verify: () =>
					Promise.resolve({
						predicateType,
						subjectDigests: [narDigest],
						signer: verifiedSigner(policy)
					})
			}
		).then(
			(results) => ({ results }),
			(error_: unknown) => {
				const error = z
					.instanceof(RemoteNarInfoStorePathMismatchError)
					.parse(error_);

				return {
					error: {
						name: error.name,
						expectedStorePathHash: error.expectedStorePathHash,
						actualStorePathHash: error.actualStorePathHash,
						storePath: error.storePath
					}
				};
			}
		);

		expect({ outcome, fetches }).toStrictEqual({
			outcome: {
				error: {
					name: RemoteNarInfoStorePathMismatchError.name,
					expectedStorePathHash: storePathHash,
					actualStorePathHash: StorePath.hash(replayedStorePath),
					storePath: replayedStorePath
				}
			},
			fetches: [`https://cupboard.test/t/acme/${storePathHash}.narinfo`]
		});
	});
});

function fetchInputUrl(input: string | URL | Request): string {
	if (typeof input === 'string') {
		return input;
	}

	if (input instanceof URL) {
		return input.href;
	}

	return input.url;
}
