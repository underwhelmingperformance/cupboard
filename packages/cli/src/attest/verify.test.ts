import { createPublicKey } from 'node:crypto';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import { storedCacheSchema } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { readUserInputSchema } from '@cupboard/shared/http';
import {
	AttestationPredicateTypeMismatchError,
	AttestationSubjectMismatchError,
	type VerifiedBundle,
	type VerifiedIdentityPolicy,
	type VerifyTrust
} from '@cupboard/shared/sigstore';
import type { Signer } from '@sigstore/verify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	RemoteNarInfoStorePathMismatchError,
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

function* cycleSigningKeyFixtures(): Generator<SigningKeyFixture, never> {
	for (let index = 0; ; index = (index + 1) % signingKeyFixtures.length) {
		const fixture = signingKeyFixtures[index];

		if (fixture !== undefined) {
			yield fixture;
		}
	}
}

const signingKeyFixtureSequence = cycleSigningKeyFixtures();

function termText(term: string | RegExp): string {
	return typeof term === 'string' ? term : term.source;
}

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
			subjectAlternativeName: termText(policy.identity),
			extensions: { issuer: termText(policy.issuer) }
		}
	};
}

const integratedTime = '2024-06-30T14:22:07.000Z';
const tlogEntries = [{ logIndex: '148905233', integratedTime }];
const signedTimestampCount = 1;
const trust: VerifyTrust = {
	tlogEntries,
	timestampCount: signedTimestampCount,
	signedAt: integratedTime
};

function verifiedBundle(
	policy: VerifiedIdentityPolicy,
	fields: {
		readonly predicateType: string;
		readonly subjectDigests: readonly string[];
		readonly predicate?: unknown;
	}
): VerifiedBundle {
	return {
		predicateType: fields.predicateType,
		subjectDigests: fields.subjectDigests,
		signer: verifiedSigner(policy),
		...(fields.predicate !== undefined && { predicate: fields.predicate }),
		signedTimestampCount,
		tlogEntries
	};
}

async function generateSigningKeyPair(): Promise<Ed25519KeyPair> {
	const fixture = signingKeyFixtureSequence.next().value;
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
	const encoder = new TextEncoder();
	const signature = await crypto.subtle.sign(
		'Ed25519',
		keyPair.privateKey,
		encoder.encode(unsigned.fingerprint())
	);

	return {
		publicKey: await namedPublicKey(keyPair),
		source: unsigned
			.withSignature(`cache:${Buffer.from(signature).toString('base64')}`)
			.render()
	};
}

describe('local attestation verification', () => {
	const policy = {
		identity: 'alice@example.test',
		issuer: 'https://issuer.test'
	} satisfies VerifiedIdentityPolicy;

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

					return Promise.resolve(
						verifiedBundle(policy, {
							predicateType,
							subjectDigests: [narDigest]
						})
					);
				}
			}
		);

		expect(results).toStrictEqual([
			{
				bundle: 'bundle.sigstore.json',
				predicateType,
				subjectDigest: narDigest,
				signerIdentity: 'alice@example.test',
				signerIssuer: 'https://issuer.test',
				trust
			}
		]);
	});

	it('surfaces the SLSA provenance summary from the predicate', async () => {
		const predicate = {
			buildDefinition: {
				externalParameters: {
					workflow: {
						ref: 'refs/heads/main',
						repository: 'https://github.com/owner/repo',
						path: '.github/workflows/build.yml'
					}
				},
				internalParameters: { github: { event_name: 'push' } },
				resolvedDependencies: [
					{
						uri: 'git+https://github.com/owner/repo@refs/heads/main',
						digest: { gitCommit: 'abc123' }
					}
				]
			},
			runDetails: {
				builder: { id: 'https://github.com/actions/runner/github-hosted' },
				metadata: {
					invocationId:
						'https://github.com/owner/repo/actions/runs/42/attempts/1'
				}
			}
		};

		const results = await verifyLocalAttestations(
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
					Promise.resolve(
						verifiedBundle(policy, {
							predicateType,
							subjectDigests: [narDigest],
							predicate
						})
					)
			}
		);

		expect(results).toStrictEqual([
			{
				bundle: 'bundle.sigstore.json',
				predicateType,
				subjectDigest: narDigest,
				signerIdentity: 'alice@example.test',
				signerIssuer: 'https://issuer.test',
				provenance: {
					builder: 'https://github.com/actions/runner/github-hosted',
					sourceRepository: 'https://github.com/owner/repo',
					sourceRef: 'refs/heads/main',
					sourceRevision: 'abc123',
					workflow: '.github/workflows/build.yml',
					buildTrigger: 'push',
					invocationId:
						'https://github.com/owner/repo/actions/runs/42/attempts/1'
				},
				trust
			}
		]);
	});

	it('rejects a verified bundle whose subject does not match the NAR hash', async () => {
		const outcome = await (async () => {
			try {
				const results = await verifyLocalAttestations(
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
							Promise.resolve(
								verifiedBundle(policy, {
									predicateType,
									subjectDigests: ['0'.repeat(64)]
								})
							)
					}
				);

				return { results };
			} catch (error_: unknown) {
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
		})();

		expect(outcome).toStrictEqual({
			error: {
				name: AttestationSubjectMismatchError.name,
				expectedSubjectDigest: narDigest,
				subjectDigests: ['0'.repeat(64)]
			}
		});
	});

	it('rejects a verified bundle whose predicate type does not match policy', async () => {
		const outcome = await (async () => {
			try {
				const results = await verifyLocalAttestations(
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
							Promise.resolve(
								verifiedBundle(policy, {
									predicateType: 'https://example.test/other',
									subjectDigests: [narDigest]
								})
							)
					}
				);

				return { results };
			} catch (error_: unknown) {
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
		})();

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
	const policy = {
		identity: 'alice@example.test',
		issuer: 'https://issuer.test'
	} satisfies VerifiedIdentityPolicy;

	it('verifies remote bundles through the cache read surface', async () => {
		const narInfo = await signedNarInfo();
		const stalePublicKey = await namedPublicKey(await generateSigningKeyPair());
		const recordedCalls: {
			readonly url: string;
			readonly authorisation?: string;
		}[] = [];
		const fetcher: typeof fetch = (input, init) => {
			const url = fetchInputUrl(input);
			const requestHeaders = new Headers(init?.headers);
			const authorisation = requestHeaders.get('authorization');
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
				cache: storedCacheSchema.parse('builds'),
				storePathHash,
				readUser: readUserInputSchema.parse('reader'),
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

					return Promise.resolve(
						verifiedBundle(policy, {
							predicateType,
							subjectDigests: [narDigest]
						})
					);
				}
			}
		);

		expect(results).toStrictEqual([
			{
				bundle: bundleDigest,
				predicateType,
				subjectDigest: narDigest,
				signerIdentity: 'alice@example.test',
				signerIssuer: 'https://issuer.test',
				trust
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

		const outcome = await (async () => {
			try {
				const results = await verifyRemoteAttestations(
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
							Promise.resolve(
								verifiedBundle(policy, {
									predicateType,
									subjectDigests: [narDigest]
								})
							)
					}
				);

				return { results };
			} catch (error_: unknown) {
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
		})();

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
