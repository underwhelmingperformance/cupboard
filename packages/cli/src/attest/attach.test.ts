import { createHash } from 'node:crypto';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storeDirectorySchema,
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
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { AttestationUploadUnavailableError } from '../errors.ts';

import {
	type AttestationAttachClient,
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

function pathInfo(
	storePath: StorePathString,
	narHash: NixSha256Hash
): NixValidPathInfo {
	return {
		storePath,
		narHash,
		narSize: 123,
		references: [],
		signatures: [],
		ultimate: true
	};
}

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

function nixStore(paths: Record<string, NixValidPathInfo>): Nix {
	const known = (storePath: StorePathString): NixValidPathInfo => {
		const info = paths[storePath];

		if (info === undefined) {
			throw new Error(`No path info is modelled for ${storePath}`);
		}

		return info;
	};
	const store = {
		resolveClosure: (storePaths: readonly StorePathString[]) =>
			Promise.resolve(storePaths.map((storePath) => known(storePath))),
		queryPathInfo: (storePath: StorePathString) =>
			Promise.resolve(known(storePath)),
		queryPathsInfo: (storePaths: readonly StorePathString[]) =>
			Promise.resolve(storePaths.map((storePath) => known(storePath))),
		queryValidPathsInfo: (storePaths: readonly StorePathString[]) =>
			Promise.resolve(
				storePaths
					.filter((storePath) => paths[storePath] !== undefined)
					.map((storePath) => known(storePath))
			),
		queryValidPaths: (storePaths: readonly StorePathString[]) =>
			Promise.resolve(
				storePaths.filter((storePath) => paths[storePath] !== undefined)
			),
		querySubstitutablePaths: () => Promise.resolve([]),
		queryDerivationOutputPaths: () => Promise.resolve([]),
		queryMissing: () =>
			Promise.resolve({
				willBuild: [],
				willSubstitute: [],
				unknown: [],
				downloadSize: 0,
				narSize: 0
			}),
		narFromPath: (storePath: StorePathString): AsyncIterable<Uint8Array> => {
			throw new Error(`No NAR stream is modelled for ${storePath}`);
		},
		buildPathsWithResults: () => Promise.resolve([])
	};

	return Nix.forStore(store, {
		storeDirectory: storeDirectorySchema.parse('/nix/store'),
		realpath: (path) => path
	});
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
				nix: nixStore({
					[appPath]: pathInfo(appPath, appHash),
					[runtimePath]: pathInfo(runtimePath, runtimeHash)
				}),
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
				nix: nixStore({
					[appPath]: pathInfo(appPath, appHash),
					[runtimePath]: pathInfo(runtimePath, runtimeHash)
				}),
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
		const nix = nixStore({ [appPath]: pathInfo(appPath, appHash) });
		const client = recordedClient(record, {
			decide: () => 'upload',
			attach: () => Promise.reject(failure)
		});

		await expect(
			runAttestAttach([appPath], reporter([]), {
				client,
				nix,
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
