import { createHash } from 'node:crypto';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storedCacheSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { AttestationNegotiateRequest } from '@cupboard/protocol/attestations';
import {
	type Reporter,
	type ResultPayload,
	type ResultRow
} from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
	AttestationUploadUnavailableError,
	NarInfoUnavailableError,
	ReferencePathMismatchError
} from '../errors.ts';

import {
	type AttestationAttachClient,
	type AttestationPathInfo,
	readCommittedAttestationPathInfos,
	requireAttestationAttachClient,
	runAttestAttach
} from './attach.ts';

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const runtimePath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime'
);
const appHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 1));
const runtimeHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 2));

function committedNarInfo(
	storePath: StorePathString,
	narHash: NixSha256Hash
): string {
	return [
		`StorePath: ${storePath}`,
		`URL: nar/${StorePath.basename(storePath)}.nar.zst`,
		'Compression: zstd',
		`FileHash: ${narHash.toString()}`,
		'FileSize: 1',
		`NarHash: ${narHash.toString()}`,
		'NarSize: 1',
		'References: ',
		''
	].join('\n');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === 'string' ? input : input.url;
}

function pathInfo(
	storePath: StorePathString,
	narHash: NixSha256Hash
): AttestationPathInfo {
	return {
		storePath,
		narHash
	};
}

describe('readCommittedAttestationPathInfos', () => {
	it('reads a private named cache after the build store is unavailable', async () => {
		const requests: { url: string; authorization?: string }[] = [];
		const infos = await readCommittedAttestationPathInfos(
			[appPath],
			{
				url: new URL('https://cache.example.test/t/acme'),
				cache: storedCacheSchema.parse('builds'),
				readUser: readUserInputSchema.parse('reader'),
				readPassword: 'secret'
			},
			{
				fetch: (input, init) => {
					requests.push({
						url: requestUrl(input),
						authorization:
							new Headers(init?.headers).get('authorization') ?? undefined
					});

					return Promise.resolve(
						new Response(committedNarInfo(appPath, appHash))
					);
				}
			}
		);

		expect({ infos, requests }).toStrictEqual({
			infos: [pathInfo(appPath, appHash)],
			requests: [
				{
					url: 'https://cache.example.test/t/acme/cache/builds/0123456789abcdfghijklmnpqrsvwxyz.narinfo',
					authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`
				}
			]
		});
	});

	it('refuses a destination that no longer serves the path', async () => {
		await expect(
			readCommittedAttestationPathInfos(
				[appPath],
				{
					url: new URL('https://cache.example.test/t/acme'),
					cache: ''
				},
				{
					fetch: () => Promise.resolve(new Response(undefined, { status: 404 }))
				}
			)
		).rejects.toBeInstanceOf(NarInfoUnavailableError);
	});

	it('refuses a narinfo that names a different path', async () => {
		await expect(
			readCommittedAttestationPathInfos(
				[appPath],
				{
					url: new URL('https://cache.example.test/t/acme'),
					cache: ''
				},
				{
					fetch: () =>
						Promise.resolve(
							new Response(committedNarInfo(runtimePath, runtimeHash))
						)
				}
			)
		).rejects.toBeInstanceOf(ReferencePathMismatchError);
	});
});

function narDigestHex(hash: NixSha256Hash): string {
	return [...hash.digestBytes()]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function sigstoreBundleBytes(
	subjectDigest: string | readonly string[]
): Uint8Array {
	const digests =
		typeof subjectDigest === 'string' ? [subjectDigest] : subjectDigest;
	const statement = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: digests.map((sha256) => ({ name: 'nar', digest: { sha256 } })),
		predicateType: 'https://slsa.dev/provenance/v1',
		predicate: { buildDefinition: {}, runDetails: {} }
	};
	const bundle = {
		mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
		verificationMaterial: {
			publicKey: { hint: 'test-key' },
			tlogEntries: []
		},
		dsseEnvelope: {
			payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
			payloadType: 'application/vnd.in-toto+json',
			signatures: [{ sig: Buffer.from('signature').toString('base64') }]
		}
	};

	const encoder = new TextEncoder();
	return encoder.encode(JSON.stringify(bundle));
}

function reporter(
	results: ResultRow[][],
	warnings: { label: string; value?: string }[] = [],
	payloads: ResultPayload[] = []
): Reporter {
	const recordWarn = (label: string, value?: string): void => {
		warnings.push({ label, value });
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact() {
						return;
					},
					warn: recordWarn
				})
			),
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn: recordWarn
				})
			),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message() {
						return;
					},
					group: () => ({
						message() {
							return;
						},
						success() {
							return;
						},
						error() {
							return;
						}
					}),
					warn: recordWarn
				})
			),
		result(payload) {
			results.push([...payload.rows]);
			payloads.push(payload);
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn: recordWarn,
		info() {
			return;
		},
		success() {
			return;
		},
		step() {
			return;
		}
	};
}

async function collectReadableStream(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = await Array.fromAsync(stream);

	return Buffer.concat(chunks);
}

interface RecordedClient {
	readonly negotiations: Omit<AttestationNegotiateRequest, 'pushId'>[];
	readonly uploads: { r2Key: string; body: Uint8Array }[];
	readonly attached: string[];
}

function recordedClient(
	record: RecordedClient,
	options: {
		readonly decide: (bundle: {
			storePathHash: string;
			digest: string;
		}) => 'upload' | 'skip';
		readonly attach?: (uploadId: string) => Promise<void>;
	}
): AttestationAttachClient {
	return {
		negotiateAttestations(body) {
			record.negotiations.push(body);

			return Promise.resolve({
				bundles: body.bundles.map((bundle) =>
					options.decide(bundle) === 'skip'
						? {
								action: 'skip' as const,
								storePathHash: bundle.storePathHash,
								digest: bundle.digest
							}
						: {
								action: 'upload' as const,
								storePathHash: bundle.storePathHash,
								digest: bundle.digest,
								uploadId: `attestation-${bundle.storePathHash}`,
								r2Key: `staging/attestations/${bundle.storePathHash}`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
				)
			});
		},
		async uploadNar(r2Key, body) {
			record.uploads.push({ r2Key, body: await collectReadableStream(body) });
		},
		async attachAttestation(uploadId) {
			await options.attach?.(uploadId);
			record.attached.push(uploadId);

			return {
				storePathHash: StorePath.hash(appPath),
				digest: 'unused',
				predicateType: 'https://slsa.dev/provenance/v1',
				status: 'attached'
			};
		}
	};
}

describe('runAttestAttach', () => {
	it('attaches and reuses bundles for the named served paths', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const appBundle = sigstoreBundleBytes(narDigestHex(appHash));
		const runtimeBundle = sigstoreBundleBytes(narDigestHex(runtimeHash));
		const results: ResultRow[][] = [];
		const warnings: { label: string; value?: string }[] = [];
		const payloads: ResultPayload[] = [];
		const readBundles: string[] = [];

		await runAttestAttach(
			[appPath, runtimePath],
			reporter(results, warnings, payloads),
			{
				client: recordedClient(record, {
					decide: (bundle) =>
						bundle.storePathHash === StorePath.hash(appPath) ? 'upload' : 'skip'
				}),
				pathInfos: [
					pathInfo(appPath, appHash),
					pathInfo(runtimePath, runtimeHash)
				],
				attestations: [
					{ path: 'app.sigstore.json' },
					{ path: 'runtime.sigstore.json' }
				],
				readAttestationBundle(path) {
					readBundles.push(path);

					return Promise.resolve(
						path === 'app.sigstore.json' ? appBundle : runtimeBundle
					);
				}
			}
		);

		expect({
			negotiations: record.negotiations,
			readBundles,
			uploads: record.uploads,
			attached: record.attached,
			warnings,
			payloads
		}).toStrictEqual({
			negotiations: [
				{
					bundles: [
						{
							storePathHash: StorePath.hash(appPath),
							digest: sha256Hex(appBundle)
						},
						{
							storePathHash: StorePath.hash(runtimePath),
							digest: sha256Hex(runtimeBundle)
						}
					]
				}
			],
			readBundles: ['app.sigstore.json', 'runtime.sigstore.json'],
			uploads: [
				{
					r2Key: `staging/attestations/${StorePath.hash(appPath)}`,
					body: Buffer.from(appBundle)
				}
			],
			attached: [`attestation-${StorePath.hash(appPath)}`],
			warnings: [],
			payloads: [
				{
					kind: 'attestation-attach-summary',
					data: {
						attached: 1,
						reused: 1,
						unservable: 0,
						uploadedBytes: appBundle.byteLength,
						paths: [
							{
								storePathHash: StorePath.hash(appPath),
								storePath: appPath,
								outcome: 'attached'
							},
							{
								storePathHash: StorePath.hash(runtimePath),
								storePath: runtimePath,
								outcome: 'reused'
							}
						]
					},
					rows: [
						{
							label: 'Attestations',
							value: '1 attached, 1 reused, 0 unservable'
						},
						{
							label: 'Attestation upload',
							value: expect.any(String) as string
						},
						{ label: StorePath.hash(appPath), value: 'attached' },
						{ label: StorePath.hash(runtimePath), value: 'already attached' }
					]
				}
			]
		});
	});

	it('records a path the cache does not serve as unservable and attaches the rest', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const appBundle = sigstoreBundleBytes(narDigestHex(appHash));
		const runtimeBundle = sigstoreBundleBytes(narDigestHex(runtimeHash));
		const results: ResultRow[][] = [];
		const warnings: { label: string; value?: string }[] = [];
		const payloads: ResultPayload[] = [];

		await runAttestAttach(
			[appPath, runtimePath],
			reporter(results, warnings, payloads),
			{
				client: recordedClient(record, {
					decide: () => 'upload',
					attach: (uploadId) =>
						uploadId === `attestation-${StorePath.hash(appPath)}`
							? Promise.reject(new ORPCError('NOT_FOUND', { status: 404 }))
							: Promise.resolve()
				}),
				pathInfos: [
					pathInfo(appPath, appHash),
					pathInfo(runtimePath, runtimeHash)
				],
				attestations: [
					{ path: 'app.sigstore.json' },
					{ path: 'runtime.sigstore.json' }
				],
				readAttestationBundle: (path) =>
					Promise.resolve(
						path === 'app.sigstore.json' ? appBundle : runtimeBundle
					)
			}
		);

		expect({
			attached: record.attached,
			warningLabels: warnings.map(({ label }) => label),
			data: payloads.map(({ data }) => data)
		}).toStrictEqual({
			attached: [`attestation-${StorePath.hash(runtimePath)}`],
			warningLabels: ['unservable'],
			data: [
				{
					attached: 1,
					reused: 0,
					unservable: 1,
					uploadedBytes: appBundle.byteLength + runtimeBundle.byteLength,
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							outcome: 'unservable'
						},
						{
							storePathHash: StorePath.hash(runtimePath),
							storePath: runtimePath,
							outcome: 'attached'
						}
					]
				}
			]
		});
	});

	it('propagates an attach failure that is not an unservable refusal', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const appBundle = sigstoreBundleBytes(narDigestHex(appHash));
		const failure = new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 });
		const client = recordedClient(record, {
			decide: () => 'upload',
			attach: () => Promise.reject(failure)
		});

		await expect(
			runAttestAttach([appPath], reporter([]), {
				client,
				pathInfos: [pathInfo(appPath, appHash)],
				attestations: [{ path: 'app.sigstore.json' }],
				readAttestationBundle: () => Promise.resolve(appBundle)
			})
		).rejects.toBe(failure);
	});
});

const uploadNar = (): Promise<void> => Promise.resolve();
const negotiateAttestations: AttestationAttachClient['negotiateAttestations'] =
	() => Promise.resolve({ bundles: [] });
const attachAttestation: AttestationAttachClient['attachAttestation'] = () =>
	Promise.resolve({
		storePathHash: StorePath.hash(appPath),
		digest: 'unused',
		predicateType: 'https://slsa.dev/provenance/v1',
		status: 'attached'
	});

describe('requireAttestationAttachClient', () => {
	it.each([
		{
			missing: 'negotiateAttestations',
			client: { attachAttestation, uploadNar }
		},
		{
			missing: 'attachAttestation',
			client: { negotiateAttestations, uploadNar }
		}
	])('refuses a client without $missing', ({ missing, client }) => {
		let thrown: unknown;

		try {
			requireAttestationAttachClient(client);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AttestationUploadUnavailableError);

		if (thrown instanceof AttestationUploadUnavailableError) {
			expect(thrown.method).toBe(missing);
		}
	});
});
