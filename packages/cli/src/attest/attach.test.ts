import { createHash } from 'node:crypto';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storedCacheSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	AttestationAttachResponse,
	AttestationDecision,
	AttestationNegotiateRequest
} from '@cupboard/protocol/attestations';
import {
	type Reporter,
	type ResultPayload,
	type ResultRow
} from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import {
	AttestationAttachResponseMismatchError,
	AttestationNegotiationMismatchError,
	AttestationSubjectNotPushedError,
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

interface BundleSubject {
	readonly name: string;
	readonly digest: string;
}

function bundleSubject(
	storePath: StorePathString,
	narHash: NixSha256Hash
): BundleSubject {
	return {
		name: StorePath.basename(storePath),
		digest: narDigestHex(narHash)
	};
}

function sigstoreBundleBytes(
	...subjects: readonly BundleSubject[]
): Uint8Array {
	const statement = {
		_type: 'https://in-toto.io/Statement/v1',
		subject: subjects.map(({ name, digest }) => ({
			name,
			digest: { sha256: digest }
		})),
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
		readonly attachResponse?: (
			decision: Extract<AttestationDecision, { action: 'upload' }>
		) => AttestationAttachResponse;
	}
): AttestationAttachClient {
	const uploadsById = new Map<
		string,
		Extract<AttestationDecision, { action: 'upload' }>
	>();

	return {
		negotiateAttestations(body) {
			record.negotiations.push(body);

			const bundles = body.bundles.map((bundle) =>
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
			);

			for (const decision of bundles) {
				if (decision.action === 'upload') {
					uploadsById.set(decision.uploadId, decision);
				}
			}

			return Promise.resolve({ bundles });
		},
		async uploadNar(r2Key, body) {
			record.uploads.push({ r2Key, body: await collectReadableStream(body) });
		},
		async attachAttestation(uploadId) {
			await options.attach?.(uploadId);
			record.attached.push(uploadId);
			const decision = uploadsById.get(uploadId);

			if (decision === undefined) {
				throw new Error(`No negotiated attestation upload named ${uploadId}`);
			}

			return (
				options.attachResponse?.(decision) ?? {
					storePathHash: decision.storePathHash,
					digest: decision.digest,
					predicateType: 'https://slsa.dev/provenance/v1',
					status: 'attached'
				}
			);
		}
	};
}

describe('runAttestAttach', () => {
	it.each([
		{
			name: 'missing',
			response: (decisions: readonly AttestationDecision[]) =>
				decisions.slice(0, 1)
		},
		{
			name: 'duplicate',
			response: (decisions: readonly AttestationDecision[]) => [
				decisions[0],
				decisions[0]
			]
		},
		{
			name: 'unexpected',
			response: (decisions: readonly AttestationDecision[]) => [
				...decisions,
				{
					action: 'skip' as const,
					storePathHash: StorePath.hash(
						'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-unexpected'
					),
					digest: 'f'.repeat(64)
				}
			]
		}
	])(
		'refuses a $name attestation negotiation response',
		async ({ name, response }) => {
			const record: RecordedClient = {
				negotiations: [],
				uploads: [],
				attached: []
			};
			const client = recordedClient(record, { decide: () => 'skip' });
			const negotiate = client.negotiateAttestations.bind(client);
			client.negotiateAttestations = async (body) => {
				const negotiation = await negotiate(body);

				return {
					bundles: response(negotiation.bundles).filter(
						(decision): decision is AttestationDecision =>
							decision !== undefined
					)
				};
			};
			const appBundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
			const runtimeBundle = sigstoreBundleBytes(
				bundleSubject(runtimePath, runtimeHash)
			);

			await expect(
				runAttestAttach([appPath, runtimePath], reporter([]), {
					client,
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
				})
			).rejects.toMatchObject({
				name: AttestationNegotiationMismatchError.name,
				mismatch: name
			});
		}
	);

	it('attaches and reuses bundles for the named served paths', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const appBundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
		const runtimeBundle = sigstoreBundleBytes(
			bundleSubject(runtimePath, runtimeHash)
		);
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

	it('keeps identical NAR digests attached to their named store paths', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const sharedHash = appHash;
		const bundle = sigstoreBundleBytes(
			bundleSubject(appPath, sharedHash),
			bundleSubject(runtimePath, sharedHash)
		);

		await runAttestAttach([appPath, runtimePath], reporter([]), {
			client: recordedClient(record, { decide: () => 'skip' }),
			pathInfos: [
				pathInfo(appPath, sharedHash),
				pathInfo(runtimePath, sharedHash)
			],
			attestations: [{ path: 'shared.sigstore.json' }],
			readAttestationBundle: () => Promise.resolve(bundle)
		});

		expect(record.negotiations).toStrictEqual([
			{
				bundles: [
					{
						storePathHash: StorePath.hash(appPath),
						digest: sha256Hex(bundle)
					},
					{
						storePathHash: StorePath.hash(runtimePath),
						digest: sha256Hex(bundle)
					}
				]
			}
		]);
	});

	it('refuses a matching digest under a different subject name', async () => {
		const bundle = sigstoreBundleBytes({
			name: StorePath.basename(runtimePath),
			digest: narDigestHex(appHash)
		});

		await expect(
			runAttestAttach([appPath], reporter([]), {
				client: recordedClient(
					{ negotiations: [], uploads: [], attached: [] },
					{ decide: () => 'skip' }
				),
				pathInfos: [pathInfo(appPath, appHash)],
				attestations: [{ path: 'wrong-name.sigstore.json' }],
				readAttestationBundle: () => Promise.resolve(bundle)
			})
		).rejects.toBeInstanceOf(AttestationSubjectNotPushedError);
	});

	it('refuses a bundle that mixes pushed and unrelated subjects', async () => {
		const bundle = sigstoreBundleBytes(bundleSubject(appPath, appHash), {
			name: 'unrelated-output',
			digest: narDigestHex(runtimeHash)
		});

		await expect(
			runAttestAttach([appPath], reporter([]), {
				client: recordedClient(
					{ negotiations: [], uploads: [], attached: [] },
					{ decide: () => 'skip' }
				),
				pathInfos: [pathInfo(appPath, appHash)],
				attestations: [{ path: 'mixed.sigstore.json' }],
				readAttestationBundle: () => Promise.resolve(bundle)
			})
		).rejects.toStrictEqual(
			expect.objectContaining({
				name: 'AttestationSubjectNotPushedError',
				path: 'mixed.sigstore.json',
				subjectDigests: [narDigestHex(runtimeHash)]
			})
		);
	});

	it('records a path the cache does not serve as unservable and attaches the rest', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const appBundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
		const runtimeBundle = sigstoreBundleBytes(
			bundleSubject(runtimePath, runtimeHash)
		);
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
		const appBundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
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

	it('drains an in-flight attachment before propagating its sibling failure', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const appBundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
		const runtimeBundle = sigstoreBundleBytes(
			bundleSubject(runtimePath, runtimeHash)
		);
		const failure = new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 });
		const runtimeStarted = Promise.withResolvers<boolean>();
		const releaseRuntime = Promise.withResolvers<boolean>();
		let hasSettled = false;
		const run = runAttestAttach([appPath, runtimePath], reporter([]), {
			client: recordedClient(record, {
				decide: () => 'upload',
				attach: async (uploadId) => {
					if (uploadId === `attestation-${StorePath.hash(appPath)}`) {
						throw failure;
					}

					runtimeStarted.resolve(true);
					await releaseRuntime.promise;
				}
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
		});

		void run
			.then(() => {
				hasSettled = true;
			})
			.catch(() => {
				hasSettled = true;
			});

		await runtimeStarted.promise;
		await flushMicrotasks();
		expect({ attached: record.attached, hasSettled }).toStrictEqual({
			attached: [],
			hasSettled: false
		});

		releaseRuntime.resolve(true);

		await expect(run).rejects.toBe(failure);
		expect({ attached: record.attached, hasSettled }).toStrictEqual({
			attached: [`attestation-${StorePath.hash(runtimePath)}`],
			hasSettled: true
		});
	});

	it('accounts for an attach that another request completed first as reused', async () => {
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const bundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
		const payloads: ResultPayload[] = [];

		await runAttestAttach([appPath], reporter([], [], payloads), {
			client: recordedClient(record, {
				decide: () => 'upload',
				attachResponse: (decision) => ({
					storePathHash: decision.storePathHash,
					digest: decision.digest,
					predicateType: 'https://slsa.dev/provenance/v1',
					status: 'already-present'
				})
			}),
			pathInfos: [pathInfo(appPath, appHash)],
			attestations: [{ path: 'app.sigstore.json' }],
			readAttestationBundle: () => Promise.resolve(bundle)
		});

		expect(payloads.map(({ data }) => data)).toStrictEqual([
			{
				attached: 0,
				reused: 1,
				unservable: 0,
				uploadedBytes: bundle.byteLength,
				paths: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						outcome: 'reused'
					}
				]
			}
		]);
	});

	it('refuses an attach response for a different bundle identity', async () => {
		const bundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));

		await expect(
			runAttestAttach([appPath], reporter([]), {
				client: recordedClient(
					{ negotiations: [], uploads: [], attached: [] },
					{
						decide: () => 'upload',
						attachResponse: (decision) => ({
							storePathHash: StorePath.hash(runtimePath),
							digest: decision.digest,
							predicateType: 'https://slsa.dev/provenance/v1',
							status: 'attached'
						})
					}
				),
				pathInfos: [pathInfo(appPath, appHash)],
				attestations: [{ path: 'app.sigstore.json' }],
				readAttestationBundle: () => Promise.resolve(bundle)
			})
		).rejects.toBeInstanceOf(AttestationAttachResponseMismatchError);
	});
});

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 5; iteration += 1) {
		await Promise.resolve();
	}
}

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
