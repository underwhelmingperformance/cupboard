import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { createCliUi } from '@cupboard/cli-ui';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	cacheNameSchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	AttestationAttachPathsResponseInput,
	AttestationAttachResponseInput,
	AttestationBundleNegotiateRequestInput,
	AttestationBundleNegotiateResponseInput,
	AttestationDecisionInput,
	AttestationNegotiateRequestInput
} from '@cupboard/protocol/attestations';
import {
	attestationAttachMaxPaths,
	attestationNegotiateMaxBundles
} from '@cupboard/protocol/attestations';
import {
	parseReporterResults,
	type Reporter,
	type ResultPayload,
	type ResultRow,
	type StepLog
} from '@cupboard/reporter';
import { readUserInputSchema } from '@cupboard/shared/http';
import { ORPCError } from '@orpc/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AttestationAttachResponseMismatchError,
	AttestationBundleInvalidError,
	AttestationBundleResponseMismatchError,
	AttestationNegotiationMismatchError,
	AttestationPathUnservableError,
	AttestationUploadUnavailableError,
	NarInfoUnavailableError,
	ReferencePathMismatchError
} from '../errors.ts';

import {
	type AttestationAttachClient,
	type AttestationPathInfo,
	parseAttestationBundle,
	prepareAttestationBundles,
	type PreparedAttestationBundle,
	readCommittedAttestationPathInfos,
	requireAttestationAttachClient,
	runAttestationAttachment,
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
	it('reads committed path identities from a private named cache', async () => {
		const requests: { url: string; authorization?: string }[] = [];
		const progress: number[] = [];
		const infos = await readCommittedAttestationPathInfos(
			[appPath],
			{
				url: new URL('https://cache.example.test/t/acme'),
				cache: { kind: 'named', name: cacheNameSchema.parse('builds') },
				readUser: readUserInputSchema.parse('reader'),
				readPassword: 'secret'
			},
			{
				onProgress: (completed) => {
					progress.push(completed);
				},
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

		expect({ infos, requests, progress }).toStrictEqual({
			progress: [1],
			infos: [pathInfo(appPath, appHash)],
			requests: [
				{
					url: 'https://cache.example.test/t/acme/cache/builds/0123456789abcdfghijklmnpqrsvwxyz.narinfo',
					authorization: `Basic ${Buffer.from('reader:secret').toString('base64')}`
				}
			]
		});
	});

	it('refuses a path absent from the destination before negotiation', async () => {
		await expect(
			readCommittedAttestationPathInfos(
				[appPath],
				{
					url: new URL('https://cache.example.test/t/acme'),
					cache: { kind: 'default' }
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
					cache: { kind: 'default' }
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
	readonly name?: string;
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

describe('parseAttestationBundle', () => {
	it('reports when a Sigstore bundle has no DSSE envelope', () => {
		const bytes = new TextEncoder().encode(JSON.stringify({}));

		expect(() => parseAttestationBundle('bundle.sigstore.json', bytes)).toThrow(
			new AttestationBundleInvalidError(
				'bundle.sigstore.json',
				'bundle has no DSSE envelope'
			)
		);
	});
});

function reporter(
	results: ResultRow[][],
	warnings: { label: string; value?: string }[] = [],
	payloads: ResultPayload[] = [],
	steps: { label: string; message: string }[] = []
): Reporter {
	const recordWarn = (label: string, value?: string): void => {
		warnings.push({ label, value });
	};
	const recordResult = (payload: ResultPayload): void => {
		results.push([...payload.rows]);
		payloads.push(payload);
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact() {
						return;
					},
					warn: recordWarn,
					result: recordResult
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
		steps: (label, body) =>
			Promise.resolve(
				body({
					message(message) {
						steps.push({ label, message });
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
		result: recordResult,
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
	readonly negotiations: Omit<AttestationNegotiateRequestInput, 'pushId'>[];
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
			decision: Extract<AttestationDecisionInput, { action: 'upload' }>
		) => AttestationAttachResponseInput;
	}
): AttestationAttachClient {
	const uploadsById = new Map<
		string,
		Extract<AttestationDecisionInput, { action: 'upload' }>
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

const transportExpiry = () =>
	new Date(Date.now() + 15 * 60 * 1000).toISOString();

function transportFixture(paths = 1, bundleCount = 1) {
	const prepared: PreparedAttestationBundle[] = Array.from(
		{ length: bundleCount },
		(_, bundleIndex) =>
			Array.from({ length: paths }, (_, pathIndex) => ({
				storePathHash: StorePath.hash(
					`/nix/store/${(pathIndex + bundleIndex * (paths === 1 ? 1 : 0)).toString(2).padStart(32, '0')}-path`
				),
				digest: bundleIndex.toString(16).padStart(64, '0'),
				bytes: new Uint8Array([bundleIndex])
			}))
	).flat();
	const expiry = transportExpiry;
	const responseFor = (
		digest: string,
		paths: readonly string[]
	): AttestationAttachPathsResponseInput => ({
		expiresAt: expiry(),
		paths: paths.map((storePathHash) => ({
			storePathHash,
			digest,
			predicateType: 'https://slsa.dev/provenance/v1',
			status: 'attached'
		}))
	});
	const uploaded: { key: string; bytes: Uint8Array }[] = [];
	const client = {
		negotiateAttestations:
			vi.fn<AttestationAttachClient['negotiateAttestations']>(),
		attachAttestation: vi.fn<AttestationAttachClient['attachAttestation']>(),
		negotiateAttestationBundles: vi.fn(
			(
				body: Omit<AttestationBundleNegotiateRequestInput, 'pushId'>
			): Promise<AttestationBundleNegotiateResponseInput> =>
				Promise.resolve({
					bundles: body.bundles.map(({ digest }) => ({
						action: 'upload',
						digest,
						uploadId: digest,
						r2Key: `staging/${digest}`,
						expiresAt: expiry()
					}))
				})
		),
		uploadNar: vi.fn(async (key: string, body: ReadableStream<Uint8Array>) => {
			uploaded.push({
				key,
				bytes: new Uint8Array(await collectReadableStream(body))
			});
		}),
		attachAttestationPaths: vi.fn(
			(id: string, body: { readonly storePathHashes: readonly string[] }) =>
				Promise.resolve(responseFor(id, body.storePathHashes))
		)
	};
	const group = { error: vi.fn(), message: vi.fn(), success: vi.fn() };
	const log: StepLog = { group: () => group, message: vi.fn(), warn: vi.fn() };
	return { prepared, client, log, uploaded, responseFor, expiry };
}

describe('bundle attachment transport', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	it('stops renewal work after a sibling fails and preserves the failure if reporting throws', async () => {
		const { prepared, client, log, expiry } = transportFixture(1, 2);
		const started = Promise.withResolvers<undefined>();
		const renewal = Promise.withResolvers<undefined>();
		const failed = Promise.withResolvers<undefined>();
		const failure = new ORPCError('INTERNAL_SERVER_ERROR');
		const partial = vi.fn(() => {
			throw new Error('result file unavailable');
		});
		client.negotiateAttestationBundles.mockImplementation(async (body) => {
			if (body.bundles.length === 1) {
				started.resolve(undefined);
				await renewal.promise;
			}
			return {
				bundles: body.bundles.map(({ digest }) => ({
					digest,
					action: 'upload',
					uploadId: digest,
					r2Key: `staging/${digest}`,
					expiresAt:
						body.bundles.length === 2 && digest === prepared[1]?.digest
							? new Date(0).toISOString()
							: expiry()
				}))
			};
		});
		client.attachAttestationPaths.mockImplementation(async () => {
			await started.promise;
			failed.resolve(undefined);
			throw failure;
		});
		const pending = runAttestationAttachment(prepared, log, {
			client,
			onPartial: partial
		});
		const rejected = expect(pending).rejects.toBe(failure);
		await failed.promise;
		await vi.advanceTimersByTimeAsync(1);
		renewal.resolve(undefined);
		await rejected;
		expect({
			uploads: client.uploadNar.mock.calls.map(([key]) => key),
			attachments: client.attachAttestationPaths.mock.calls,
			partial: partial.mock.calls
		}).toStrictEqual({
			uploads: prepared.map(({ digest }) => `staging/${digest}`),
			attachments: [
				[prepared[0]?.digest, { storePathHashes: [prepared[0]?.storePathHash] }]
			],
			partial: [
				{
					uploadedBytes: 2,
					bundles: prepared.map(({ storePathHash, digest }, index) => ({
						storePathHash,
						digest,
						outcome: index === 0 ? 'unconfirmed' : 'unattempted'
					}))
				}
			].map((result) => [result])
		});
	});
	it('records a complete mixed page before a strict publication refusal and awaits its sibling', async () => {
		const { prepared, client, log, responseFor } = transportFixture(2, 2);
		const partial = vi.fn();
		client.attachAttestationPaths.mockImplementation(async (digest, body) => {
			const response = responseFor(digest, body.storePathHashes);
			if (digest === prepared[0]?.digest) {
				return {
					...response,
					paths: response.paths.map((path, index) => ({
						...path,
						status: index === 0 ? 'attached' : 'unservable'
					}))
				};
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			return response;
		});
		const rejected = expect(
			runAttestationAttachment(prepared, log, { client, onPartial: partial })
		).rejects.toBeInstanceOf(AttestationPathUnservableError);
		await vi.runAllTimersAsync();
		await rejected;
		expect(partial.mock.calls).toStrictEqual([
			[
				{
					uploadedBytes: 2,
					bundles: prepared.map(({ storePathHash, digest }, index) => ({
						storePathHash,
						digest,
						outcome: index === 1 ? 'unservable' : 'attached'
					}))
				}
			]
		]);
	});
	it.each([
		{ transport: 'grouped', failureKind: 'cancelled' },
		{ transport: 'grouped', failureKind: 'invalid-response' },
		{ transport: 'legacy fallback', failureKind: 'cancelled' },
		{ transport: 'legacy fallback', failureKind: 'invalid-response' }
	])(
		'reports uncertain $failureKind responses and awaits concurrent $transport attachments',
		async ({ transport, failureKind }) => {
			const { prepared, client, log, responseFor } = transportFixture(1, 8);
			const partial = vi.fn();
			const siblings = Promise.withResolvers<undefined>();
			const failed = Promise.withResolvers<undefined>();
			const failure = new DOMException('cancelled', 'AbortError');
			const first = prepared[0];
			if (first === undefined) {
				throw new Error('missing fixture pair');
			}
			client.attachAttestationPaths.mockImplementation(async (digest, body) => {
				if (digest === first.digest) {
					failed.resolve(undefined);
					if (failureKind === 'cancelled') {
						throw failure;
					}
					return responseFor('f'.repeat(64), body.storePathHashes);
				}
				await siblings.promise;
				const response = responseFor(digest, body.storePathHashes);
				return {
					...response,
					paths: response.paths.map((path) => ({
						...path,
						status:
							digest === prepared[1]?.digest
								? 'already-present'
								: digest === prepared[2]?.digest
									? 'unservable'
									: 'attached'
					}))
				};
			});
			if (transport === 'legacy fallback') {
				client.negotiateAttestationBundles.mockRejectedValue(
					new ORPCError('NOT_FOUND', { status: 404 })
				);
				client.negotiateAttestations.mockImplementation((body) =>
					Promise.resolve({
						bundles: body.bundles.map((bundle) => ({
							...bundle,
							action: 'upload',
							uploadId: bundle.digest,
							r2Key: `staging/${bundle.digest}`,
							expiresAt: transportExpiry()
						}))
					})
				);
				client.attachAttestation.mockImplementation(async (digest) => {
					const pair = prepared.find((bundle) => bundle.digest === digest);
					if (pair === undefined) {
						throw new Error('missing legacy pair');
					}
					if (digest === prepared[2]?.digest) {
						await siblings.promise;
						throw new ORPCError('NOT_FOUND');
					}
					const response = await client.attachAttestationPaths(digest, {
						storePathHashes: [pair.storePathHash]
					});
					const path = response.paths[0];
					if (path === undefined || path.status === 'unservable') {
						throw new Error('invalid legacy fixture');
					}
					return { ...path, status: path.status };
				});
			}
			const pending = runAttestationAttachment(prepared, log, {
				client,
				skipUnservable: true,
				onPartial: partial
			});
			const rejection =
				failureKind === 'cancelled'
					? expect(pending).rejects.toBe(failure)
					: expect(pending).rejects.toBeInstanceOf(
							transport === 'grouped'
								? AttestationBundleResponseMismatchError
								: AttestationAttachResponseMismatchError
						);
			await failed.promise;
			await vi.advanceTimersByTimeAsync(1);
			expect(partial.mock.calls).toStrictEqual([]);
			siblings.resolve(undefined);
			await rejection;
			expect(partial.mock.calls).toStrictEqual([
				[
					{
						uploadedBytes: transport === 'grouped' ? 6 : 8,
						bundles: prepared.map(({ storePathHash, digest }, index) => ({
							storePathHash,
							digest,
							outcome:
								index === 0
									? 'unconfirmed'
									: index === 1
										? 'reused'
										: index === 2
											? 'unservable'
											: index < 6
												? 'attached'
												: 'unattempted'
						}))
					}
				]
			]);
		}
	);

	it('reports confirmed pages and concurrent completions before the original failure', async () => {
		const { prepared, client, log, responseFor } = transportFixture(
			attestationAttachMaxPaths + 1,
			7
		);
		const failure = new Error('attachment failed');
		const partial = vi.fn();
		client.attachAttestationPaths.mockImplementation(async (digest, body) => {
			if (digest === prepared[0]?.digest && body.storePathHashes.length === 1) {
				throw failure;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			return responseFor(digest, body.storePathHashes);
		});
		const rejected = expect(
			runAttestationAttachment(prepared, log, {
				client,
				onPartial: partial
			})
		).rejects.toBe(failure);
		await vi.runAllTimersAsync();
		await rejected;
		expect(partial.mock.calls).toStrictEqual([
			[
				{
					uploadedBytes: 6,
					bundles: prepared.map(({ storePathHash, digest }, index) => ({
						storePathHash,
						digest,
						outcome:
							index < attestationAttachMaxPaths
								? 'attached'
								: index === attestationAttachMaxPaths
									? 'unconfirmed'
									: index >= 6 * (attestationAttachMaxPaths + 1) ||
										  index % (attestationAttachMaxPaths + 1) ===
												attestationAttachMaxPaths
										? 'unattempted'
										: 'attached'
					}))
				}
			]
		]);
	});
	it.each([
		{ description: 'a public bundle', paths: 1600, bundleCount: 1 },
		{
			description: 'overlapping provenance and publication bundles',
			paths: 1600,
			bundleCount: 2
		},
		{ description: 'private individual bundles', paths: 1, bundleCount: 130 }
	])(
		'uploads each distinct bundle once for $description',
		async ({ paths, bundleCount }) => {
			const fixture = transportFixture(paths, bundleCount);
			const { prepared, client, log } = fixture;
			const outcome = await runAttestationAttachment(prepared, log, { client });
			const pages = client.attachAttestationPaths.mock.calls.toSorted(
				([left], [right]) => left.localeCompare(right)
			);
			expect({
				negotiated: client.negotiateAttestationBundles.mock.calls.flatMap(
					([body]) => body.bundles
				),
				uploaded: fixture.uploaded,
				attachedPairs: pages.flatMap(([digest, body]) =>
					body.storePathHashes.map((storePathHash) => ({
						digest,
						storePathHash
					}))
				),
				boundedPages: pages.every(
					([, body]) => body.storePathHashes.length <= attestationAttachMaxPaths
				),
				outcome,
				legacyCalls: client.negotiateAttestations.mock.calls
			}).toStrictEqual({
				negotiated: Array.from({ length: bundleCount }, (_, index) => ({
					digest: index.toString(16).padStart(64, '0')
				})),
				uploaded: Array.from({ length: bundleCount }, (_, index) => ({
					key: `staging/${index.toString(16).padStart(64, '0')}`,
					bytes: new Uint8Array([index])
				})),
				attachedPairs: prepared.map(({ digest, storePathHash }) => ({
					digest,
					storePathHash
				})),
				boundedPages: true,
				outcome: {
					attached: prepared.length,
					reused: 0,
					uploadedBytes: bundleCount,
					unservableStorePathHashes: new Set(),
					bundles: prepared.map(({ digest, storePathHash }) => ({
						digest,
						storePathHash,
						outcome: 'attached'
					}))
				},
				legacyCalls: []
			});
		}
	);

	it.each(['missing', 'duplicate', 'unexpected'] as const)(
		'rejects %s negotiation decisions before upload',
		async (mismatch) => {
			const { prepared, client, log, expiry } = transportFixture();
			const digest = '0'.repeat(64);
			const decision = {
				action: 'reuse' as const,
				digest,
				uploadId: digest,
				expiresAt: expiry()
			};
			client.negotiateAttestationBundles.mockResolvedValue({
				bundles:
					mismatch === 'missing'
						? []
						: mismatch === 'duplicate'
							? [decision, decision]
							: [{ ...decision, digest: 'f'.repeat(64) }]
			});
			await expect(
				runAttestationAttachment(prepared, log, { client })
			).rejects.toThrow(
				new AttestationBundleResponseMismatchError(
					'negotiation',
					mismatch,
					mismatch === 'unexpected' ? 'f'.repeat(64) : digest
				)
			);
			expect({
				uploads: client.uploadNar.mock.calls,
				attachments: client.attachAttestationPaths.mock.calls
			}).toStrictEqual({ uploads: [], attachments: [] });
		}
	);

	it.each(['missing', 'duplicate', 'unexpected-path', 'wrong-digest'] as const)(
		'rejects a %s attachment result',
		async (kind) => {
			const { prepared, client, log, responseFor } = transportFixture();
			const digest = '0'.repeat(64);
			const storePathHash = StorePath.hash(
				'/nix/store/00000000000000000000000000000000-path'
			);
			const unexpectedPath = StorePath.hash(runtimePath);
			client.attachAttestationPaths.mockImplementation(() => {
				const response = responseFor(digest, [storePathHash]);
				return Promise.resolve({
					...response,
					paths:
						kind === 'missing'
							? []
							: kind === 'duplicate'
								? [...response.paths, ...response.paths]
								: response.paths.map((entry) => ({
										...entry,
										...(kind === 'wrong-digest'
											? { digest: 'f'.repeat(64) }
											: { storePathHash: unexpectedPath })
									}))
				});
			});
			const mismatch =
				kind === 'missing' || kind === 'duplicate' ? kind : 'unexpected';
			const identity = `${kind === 'unexpected-path' ? unexpectedPath : storePathHash} ${kind === 'wrong-digest' ? 'f'.repeat(64) : digest}`;
			await expect(
				runAttestationAttachment(prepared, log, { client })
			).rejects.toThrow(
				new AttestationBundleResponseMismatchError(
					'attachment',
					mismatch,
					identity
				)
			);
		}
	);

	it.each(['upload', 'reuse'] as const)(
		'deduplicates overlapping copies of the same digest with an %s decision',
		async (action) => {
			const { prepared, client, log, expiry } = transportFixture(2);
			client.negotiateAttestationBundles.mockImplementation((body) =>
				Promise.resolve({
					bundles: body.bundles.map(({ digest }) => ({
						action,
						digest,
						uploadId: digest,
						r2Key: `staging/${digest}`,
						expiresAt: expiry()
					}))
				})
			);
			const outcome = await runAttestationAttachment(
				[...prepared, ...prepared],
				log,
				{ client }
			);
			expect({
				negotiations: client.negotiateAttestationBundles.mock.calls,
				pages: client.attachAttestationPaths.mock.calls,
				uploadedBytes: outcome.uploadedBytes,
				bundles: outcome.bundles
			}).toStrictEqual({
				negotiations: [[{ bundles: [{ digest: '0'.repeat(64) }] }]],
				pages: [
					[
						'0'.repeat(64),
						{ storePathHashes: prepared.map((entry) => entry.storePathHash) }
					]
				],
				uploadedBytes: action === 'upload' ? 1 : 0,
				bundles: prepared.map(({ digest, storePathHash }) => ({
					digest,
					storePathHash,
					outcome: 'attached'
				}))
			});
			expect(client.uploadNar).toHaveBeenCalledTimes(
				action === 'upload' ? 1 : 0
			);
		}
	);

	it.each([true, false])(
		'preserves mixed page outcomes with skipUnservable=%s',
		async (skipUnservable) => {
			const { prepared, client, log, responseFor } = transportFixture(
				attestationAttachMaxPaths + 1
			);
			const unavailable = prepared.at(-1);
			if (unavailable === undefined) {
				throw new Error('Expected the second page subject');
			}
			client.attachAttestationPaths.mockImplementation((id, body) =>
				Promise.resolve({
					...responseFor(id, body.storePathHashes),
					paths: responseFor(id, body.storePathHashes).paths.map(
						(entry, index) => ({
							...entry,
							status:
								entry.storePathHash === unavailable.storePathHash
									? 'unservable'
									: index === 0
										? 'already-present'
										: 'attached'
						})
					)
				})
			);
			const result = runAttestationAttachment(prepared, log, {
				client,
				skipUnservable
			});
			if (!skipUnservable) {
				await expect(result).rejects.toThrow(
					new AttestationPathUnservableError(unavailable.storePathHash)
				);
				return;
			}
			expect(await result).toStrictEqual({
				attached: attestationAttachMaxPaths - 1,
				reused: 1,
				uploadedBytes: 1,
				unservableStorePathHashes: new Set([unavailable.storePathHash]),
				bundles: prepared.map(({ digest, storePathHash }, index) => ({
					digest,
					storePathHash,
					outcome:
						index === 0
							? 'reused'
							: storePathHash === unavailable.storePathHash
								? 'unservable'
								: 'attached'
				}))
			});
		}
	);

	it('negotiates later work only after the preceding batch completes', async () => {
		const { prepared, client, log, responseFor, expiry } = transportFixture(
			1,
			7
		);
		let now = Date.parse('2050-01-01T00:00:00.000Z');
		const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
		const negotiatedAt: number[] = [];
		try {
			client.negotiateAttestationBundles.mockImplementation((body) => {
				negotiatedAt.push(now);
				return Promise.resolve({
					bundles: body.bundles.map(({ digest }) => ({
						action: 'reuse',
						digest,
						uploadId: digest,
						expiresAt: expiry()
					}))
				});
			});
			let completed = 0;
			client.attachAttestationPaths.mockImplementation((id, body) => {
				completed += 1;
				if (completed === 6) {
					now += 16 * 60 * 1000;
				}
				return Promise.resolve(responseFor(id, body.storePathHashes));
			});
			await runAttestationAttachment(prepared, log, { client });
			expect(negotiatedAt).toStrictEqual([
				Date.parse('2050-01-01T00:00:00.000Z'),
				Date.parse('2050-01-01T00:16:00.000Z')
			]);
		} finally {
			clock.mockRestore();
		}
	});

	it.each(['elapsed', 'not-found', 'persistent-not-found'] as const)(
		'renews the current page after %s without losing earlier outcomes',
		async (reason) => {
			const { prepared, client, log, responseFor, expiry } = transportFixture(
				attestationAttachMaxPaths + 1
			);
			let now = Date.parse('2050-01-01T00:00:00.000Z');
			const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
			let session = 0;
			const missing = new ORPCError('NOT_FOUND');
			try {
				client.negotiateAttestationBundles.mockImplementation((body) => {
					session += 1;
					return Promise.resolve({
						bundles: body.bundles.map(({ digest }) => ({
							action: 'reuse',
							digest,
							uploadId: String(session),
							expiresAt: expiry()
						}))
					});
				});
				client.attachAttestationPaths.mockImplementation((id, body) => {
					const isSecondPage = body.storePathHashes.length === 1;
					if (
						isSecondPage &&
						reason !== 'elapsed' &&
						(id === '1' || reason === 'persistent-not-found')
					) {
						return Promise.reject(missing);
					}
					const response = responseFor('0'.repeat(64), body.storePathHashes);
					if (!isSecondPage && reason === 'elapsed') {
						now += 16 * 60 * 1000;
					}
					return Promise.resolve(response);
				});
				const result = runAttestationAttachment(prepared, log, {
					client,
					skipUnservable: true
				});
				if (reason === 'persistent-not-found') {
					await expect(result).rejects.toBe(missing);
				} else {
					const outcome = await result;
					expect(outcome.bundles).toStrictEqual(
						prepared.map(({ digest, storePathHash }) => ({
							digest,
							storePathHash,
							outcome: 'attached'
						}))
					);
				}
				const firstPage = prepared
					.slice(0, attestationAttachMaxPaths)
					.map((entry) => entry.storePathHash);
				const secondPage = prepared
					.slice(attestationAttachMaxPaths)
					.map((entry) => entry.storePathHash);
				expect(client.attachAttestationPaths.mock.calls).toStrictEqual([
					['1', { storePathHashes: firstPage }],
					...(reason === 'elapsed'
						? []
						: [['1', { storePathHashes: secondPage }]]),
					['2', { storePathHashes: secondPage }]
				]);
				expect(client.uploadNar.mock.calls).toStrictEqual([]);
			} finally {
				clock.mockRestore();
			}
		}
	);

	it.each([1, 2])(
		'uses the legacy API when bundle negotiation is absent (%s subjects)',
		async (paths) => {
			const { prepared, client, log } = transportFixture(paths);
			const record: RecordedClient = {
				negotiations: [],
				uploads: [],
				attached: []
			};
			const legacy = recordedClient(record, { decide: () => 'upload' });
			client.negotiateAttestationBundles.mockRejectedValue(
				new ORPCError('NOT_FOUND')
			);
			const result = await runAttestationAttachment(prepared, log, {
				client: { ...client, ...legacy }
			});
			expect({
				result,
				record,
				pages: client.attachAttestationPaths.mock.calls
			}).toStrictEqual({
				result: {
					attached: prepared.length,
					reused: 0,
					uploadedBytes: prepared.length,
					unservableStorePathHashes: new Set(),
					bundles: prepared.map(({ storePathHash, digest }) => ({
						storePathHash,
						digest,
						outcome: 'attached'
					}))
				},
				record: {
					negotiations: [
						{
							bundles: prepared.map(({ storePathHash, digest }) => ({
								storePathHash,
								digest
							}))
						}
					],
					uploads: prepared.map(({ storePathHash, bytes }) => ({
						r2Key: `staging/attestations/${storePathHash}`,
						body: Buffer.from(bytes)
					})),
					attached: prepared.map(
						({ storePathHash }) => `attestation-${storePathHash}`
					)
				},
				pages: []
			});
		}
	);

	it('attaches every subject through a legacy client without changing the signed bundle', async () => {
		const bundle = sigstoreBundleBytes(
			bundleSubject(appPath, appHash),
			bundleSubject(runtimePath, runtimeHash)
		);
		const digest = sha256Hex(bundle);
		const record: RecordedClient = {
			negotiations: [],
			uploads: [],
			attached: []
		};
		const payloads: ResultPayload[] = [];
		await runAttestAttach([appPath, runtimePath], reporter([], [], payloads), {
			client: recordedClient(record, { decide: () => 'upload' }),
			pathInfos: [
				pathInfo(appPath, appHash),
				pathInfo(runtimePath, runtimeHash)
			],
			attestations: [{ path: 'shared.sigstore.json' }],
			readAttestationBundle: () => Promise.resolve(bundle)
		});
		const paths = [appPath, runtimePath];
		expect({
			record,
			summaries: payloads.map(({ kind, data }) => ({ kind, data }))
		}).toStrictEqual({
			record: {
				negotiations: [
					{
						bundles: paths.map((path) => ({
							storePathHash: StorePath.hash(path),
							digest
						}))
					}
				],
				uploads: paths.map((path) => ({
					r2Key: `staging/attestations/${StorePath.hash(path)}`,
					body: Buffer.from(bundle)
				})),
				attached: paths.map((path) => `attestation-${StorePath.hash(path)}`)
			},
			summaries: [
				{
					kind: 'attestation-attach-summary',
					data: {
						attached: 2,
						reused: 0,
						unservable: 0,
						uploadedBytes: bundle.byteLength * 2,
						paths: paths.map((storePath) => ({
							storePathHash: StorePath.hash(storePath),
							storePath,
							outcome: 'attached'
						}))
					}
				}
			]
		});
	});

	it.each([
		new ORPCError('UNAUTHORIZED'),
		new ORPCError('FORBIDDEN'),
		new ORPCError('INTERNAL_SERVER_ERROR'),
		new ORPCError('NOT_FOUND', { defined: true }),
		new Error('connection refused')
	])(
		'keeps an unexpected bundle negotiation failure fatal: %s',
		async (error) => {
			const { prepared, client, log } = transportFixture(2);
			client.negotiateAttestationBundles.mockRejectedValue(error);
			await expect(
				runAttestationAttachment(prepared, log, { client })
			).rejects.toBe(error);
			expect({
				legacyNegotiation: client.negotiateAttestations.mock.calls,
				legacyAttachment: client.attachAttestation.mock.calls,
				upload: client.uploadNar.mock.calls,
				attachment: client.attachAttestationPaths.mock.calls
			}).toStrictEqual({
				legacyNegotiation: [],
				legacyAttachment: [],
				upload: [],
				attachment: []
			});
		}
	);

	it('does not fall back after the server accepted grouped negotiation', async () => {
		const { prepared, client, log, expiry } = transportFixture();
		const error = new ORPCError('NOT_FOUND');
		client.negotiateAttestationBundles
			.mockResolvedValueOnce({
				bundles: prepared.map(({ digest }) => ({
					action: 'upload',
					digest,
					uploadId: digest,
					r2Key: `staging/${digest}`,
					expiresAt: expiry()
				}))
			})
			.mockRejectedValueOnce(error);
		client.attachAttestationPaths.mockRejectedValueOnce(
			new ORPCError('NOT_FOUND')
		);
		await expect(
			runAttestationAttachment(prepared, log, { client })
		).rejects.toBe(error);
		expect({
			legacyNegotiation: client.negotiateAttestations.mock.calls,
			legacyAttachment: client.attachAttestation.mock.calls,
			groupedNegotiations: client.negotiateAttestationBundles.mock.calls,
			groupedAttachments: client.attachAttestationPaths.mock.calls
		}).toStrictEqual({
			legacyNegotiation: [],
			legacyAttachment: [],
			groupedNegotiations: [
				[{ bundles: prepared.map(({ digest }) => ({ digest })) }],
				[{ bundles: prepared.map(({ digest }) => ({ digest })) }]
			],
			groupedAttachments: [
				[
					prepared[0]?.digest,
					{
						storePathHashes: prepared.map(({ storePathHash }) => storePathHash)
					}
				]
			]
		});
	});
});

describe('runAttestAttach', () => {
	it.each(
		(['terminal', 'json', 'github'] as const).flatMap((mode) =>
			(['summary', 'details'] as const).map((presentation) => ({
				mode,
				presentation
			}))
		)
	)(
		'records each bundle in $mode/$presentation output and result files, then reuses confirmed attachments on retry',
		async ({ mode, presentation }) => {
			const directory = await mkdtemp(
				path.join(tmpdir(), 'cupboard-attach-partial-')
			);
			try {
				const bundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
				const second = sigstoreBundleBytes({
					...bundleSubject(appPath, appHash),
					name: 'second'
				});
				const firstDigest = sha256Hex(bundle);
				const secondDigest = sha256Hex(second);
				const record: RecordedClient = {
					negotiations: [],
					uploads: [],
					attached: []
				};
				const failure = new ORPCError('INTERNAL_SERVER_ERROR', { status: 500 });
				const client = recordedClient(record, {
					decide: ({ digest }) => (digest === firstDigest ? 'skip' : 'upload'),
					attach: () => Promise.reject(failure)
				});
				const output: string[] = [];
				const stream = new Writable({
					write(chunk: Buffer | string, _encoding, callback) {
						output.push(String(chunk));
						callback();
					}
				});
				const resultFile = path.join(directory, 'result.jsonl');
				const ui = createCliUi({
					mode,
					presentation,
					colour: false,
					stream,
					out: stream,
					resultFile
				});
				const dependencies = {
					client,
					pathInfos: [pathInfo(appPath, appHash)],
					attestations: [{ path: 'first' }, { path: 'second' }],
					readAttestationBundle: (path: string) =>
						Promise.resolve(path === 'first' ? bundle : second)
				};
				await expect(
					runAttestAttach([appPath], ui.reporter(), dependencies)
				).rejects.toBe(failure);
				const partial = {
					kind: 'attestation-attach-partial',
					data: {
						attached: 0,
						reused: 1,
						unservable: 0,
						unconfirmed: 1,
						unattempted: 0,
						uploadedBytes: second.byteLength,
						bundles: [
							{
								storePathHash: StorePath.hash(appPath),
								storePath: appPath,
								digest: firstDigest,
								outcome: 'reused'
							},
							{
								storePathHash: StorePath.hash(appPath),
								storePath: appPath,
								digest: secondDigest,
								outcome: 'unconfirmed'
							}
						]
					}
				};
				const outputText = output
					.join('')
					.replaceAll('│', '')
					.replaceAll(/\s+/g, ' ');
				const recoveryAdvice =
					'After resolving the reported error, retry with the same bundle files. Existing attachments will be reused.';
				expect({
					results: parseReporterResults(await readFile(resultFile, 'utf8')),
					outputContainsPairs:
						outputText.includes(firstDigest) &&
						outputText.includes(secondDigest),
					recoveryAdviceAfterOutcome:
						outputText.indexOf(recoveryAdvice) >
						outputText.indexOf(
							presentation === 'summary' && mode !== 'json'
								? 'attachment outcome unknown'
								: secondDigest
						)
				}).toStrictEqual({
					results: [partial],
					outputContainsPairs: mode === 'json' || presentation === 'details',
					recoveryAdviceAfterOutcome: mode !== 'json'
				});
				client.negotiateAttestations = (body) =>
					Promise.resolve({
						bundles: body.bundles.map((pair) => ({ ...pair, action: 'skip' }))
					});
				await runAttestAttach([appPath], ui.reporter(), dependencies);
				expect(
					parseReporterResults(await readFile(resultFile, 'utf8'))
				).toStrictEqual([
					partial,
					{
						kind: 'attestation-attach-summary',
						data: {
							attached: 0,
							reused: 2,
							unservable: 0,
							uploadedBytes: 0,
							paths: [
								{
									storePathHash: StorePath.hash(appPath),
									storePath: appPath,
									outcome: 'reused'
								}
							]
						}
					}
				]);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	);
	it('negotiates a closure larger than the protocol cap in bounded batches', async () => {
		const prepared: PreparedAttestationBundle[] = Array.from(
			{ length: attestationNegotiateMaxBundles + 1 },
			(_, index) => ({
				storePathHash: StorePath.hash(appPath),
				digest: index.toString(16).padStart(64, '0'),
				bytes: new Uint8Array()
			})
		);
		const batchSizes: number[] = [];
		const group = {
			error: vi.fn(),
			message: vi.fn(),
			success: vi.fn()
		};
		const log: StepLog = {
			group: () => group,
			message: vi.fn(),
			warn: vi.fn()
		};
		const outcome = await runAttestationAttachment(prepared, log, {
			client: {
				negotiateAttestations(body) {
					batchSizes.push(body.bundles.length);

					return Promise.resolve({
						bundles: body.bundles.map((bundle) => ({
							action: 'skip',
							...bundle
						}))
					});
				},
				uploadNar: () => Promise.resolve(),
				attachAttestation
			}
		});

		expect({
			batchSizes,
			attached: outcome.attached,
			reused: outcome.reused
		}).toStrictEqual({
			batchSizes: [attestationNegotiateMaxBundles, 1],
			attached: 0,
			reused: attestationNegotiateMaxBundles + 1
		});
	});

	it.each([
		{
			name: 'missing',
			response: (decisions: readonly AttestationDecisionInput[]) =>
				decisions.slice(0, 1)
		},
		{
			name: 'duplicate',
			response: (decisions: readonly AttestationDecisionInput[]) => [
				decisions[0],
				decisions[0]
			]
		},
		{
			name: 'unexpected',
			response: (decisions: readonly AttestationDecisionInput[]) => [
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
						(decision): decision is AttestationDecisionInput =>
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
		const steps: { label: string; message: string }[] = [];

		await runAttestAttach(
			[appPath, runtimePath],
			reporter(results, warnings, payloads, steps),
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
			payloads,
			steps
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
			steps: [
				{
					label: 'Attached attestation paths',
					message: `${StorePath.basename(appPath)}: attached`
				},
				{
					label: 'Attached attestation paths',
					message: `${StorePath.basename(runtimePath)}: already attached`
				}
			],
			payloads: [
				{
					kind: 'attestation-attach-summary',
					title: 'Attestation attachment',
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
							value: '1 attached, 1 already attached, 0 unavailable'
						},
						{
							label: 'Attestation upload',
							value: expect.any(String) as string
						}
					]
				}
			]
		});
	});

	it('caps grouped path details and keeps every attachment in the machine result', async () => {
		const paths = Array.from({ length: 21 }, (_, index) =>
			storePathSchema.parse(`/nix/store/${String(index).padStart(32, '0')}-app`)
		);
		const steps: { label: string; message: string }[] = [];
		const payloads: ResultPayload[] = [];
		const bundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
		await runAttestAttach(paths, reporter([], [], payloads, steps), {
			client: recordedClient(
				{ negotiations: [], uploads: [], attached: [] },
				{ decide: () => 'skip' }
			),
			pathInfos: paths.map((path) => pathInfo(path, appHash)),
			attestations: [{ path: 'shared' }],
			readAttestationBundle: () => Promise.resolve(bundle)
		});
		expect({ steps, data: payloads[0]?.data }).toStrictEqual({
			steps: [
				...paths.slice(0, 20).map((path) => ({
					label: 'Attached attestation paths',
					message: `${StorePath.basename(path)}: already attached`
				})),
				{
					label: 'Attached attestation paths',
					message: '1 additional path in the machine result.'
				}
			],
			data: {
				attached: 0,
				reused: 21,
				unservable: 0,
				uploadedBytes: 0,
				paths: paths.map((storePath) => ({
					storePath,
					storePathHash: StorePath.hash(storePath),
					outcome: 'reused'
				}))
			}
		});
	});

	it('attaches identical NAR digests to all selected store paths', async () => {
		const negotiations: unknown[] = [];
		const pages: unknown[] = [];
		const sharedHash = appHash;
		const bundle = sigstoreBundleBytes(
			bundleSubject(appPath, sharedHash),
			bundleSubject(runtimePath, sharedHash)
		);

		await runAttestAttach([appPath, runtimePath], reporter([]), {
			client: {
				...recordedClient(
					{ negotiations: [], uploads: [], attached: [] },
					{ decide: () => 'skip' }
				),
				negotiateAttestationBundles(body) {
					negotiations.push(body);
					return Promise.resolve({
						bundles: body.bundles.map(({ digest }) => ({
							action: 'reuse',
							digest,
							uploadId: digest,
							expiresAt: transportExpiry()
						}))
					});
				},
				attachAttestationPaths(id, body) {
					pages.push(body);
					return Promise.resolve({
						expiresAt: transportExpiry(),
						paths: body.storePathHashes.map((storePathHash) => ({
							storePathHash,
							digest: id,
							predicateType: 'https://slsa.dev/provenance/v1',
							status: 'already-present'
						}))
					});
				}
			},
			pathInfos: [
				pathInfo(appPath, sharedHash),
				pathInfo(runtimePath, sharedHash)
			],
			attestations: [{ path: 'shared.sigstore.json' }],
			readAttestationBundle: () => Promise.resolve(bundle)
		});

		expect({ negotiations, pages }).toStrictEqual({
			negotiations: [{ bundles: [{ digest: sha256Hex(bundle) }] }],
			pages: [
				{
					storePathHashes: [
						StorePath.hash(appPath),
						StorePath.hash(runtimePath)
					]
				}
			]
		});
	});

	it.each([undefined, '_', StorePath.basename(runtimePath)])(
		'matches a NAR digest with subject name %s',
		async (name) => {
			const bundle = sigstoreBundleBytes({
				...(name !== undefined && { name }),
				digest: narDigestHex(appHash)
			});

			const prepared = await prepareAttestationBundles(
				[pathInfo(appPath, appHash)],
				{
					sources: [{ path: 'bundle.sigstore.json' }],
					readBundle: () => Promise.resolve(bundle),
					divergent: new Map()
				}
			);

			expect(prepared).toStrictEqual([
				{
					storePathHash: StorePath.hash(appPath),
					digest: sha256Hex(bundle),
					bytes: bundle
				}
			]);
		}
	);

	it('matches one subject to every selected store path with the same NAR digest', async () => {
		const bundle = sigstoreBundleBytes(bundleSubject(appPath, appHash));
		const prepared = await prepareAttestationBundles(
			[pathInfo(appPath, appHash), pathInfo(runtimePath, appHash)],
			{
				sources: [{ path: 'bundle.sigstore.json' }],
				readBundle: () => Promise.resolve(bundle),
				divergent: new Map()
			}
		);

		expect(prepared).toStrictEqual(
			[appPath, runtimePath].map((storePath) => ({
				storePathHash: StorePath.hash(storePath),
				digest: sha256Hex(bundle),
				bytes: bundle
			}))
		);
	});

	it('refuses a bundle that mixes selected and unrelated subjects', async () => {
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
				message:
					'Attestation bundle mixed.sigstore.json has subjects outside the selected paths: ' +
					narDigestHex(runtimeHash),
				path: 'mixed.sigstore.json',
				subjectDigests: [narDigestHex(runtimeHash)]
			})
		);
	});

	it('records NOT_FOUND during attachment as unservable and attaches the rest', async () => {
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
