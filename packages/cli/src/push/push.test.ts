import { createHash } from 'node:crypto';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	AttestationNegotiateRequest,
	AttestationPrepareResponse
} from '@cupboard/protocol/attestations';
import type {
	RootSetBody,
	RootSetResponse
} from '@cupboard/protocol/retention';
import type {
	UploadNegotiateRequest,
	UploadPrepareResponse
} from '@cupboard/protocol/upload';
import { formatBytes, type Reporter, type ResultRow } from '@cupboard/reporter';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CommitOptions } from '../client/client.ts';
import {
	AttestationSubjectNotPushedError,
	CupboardHttpError,
	CupboardUploadError,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	UploadVerificationFailedError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';
import {
	type CompressedAndHashedNarFile,
	CompressedNarFile
} from '../nix/blob.ts';
import { type NarDigest, NixSha256Hash } from '../nix/nar.ts';

import {
	type PushClient,
	type PushDependencies,
	type PushNarArchive,
	runPush
} from './push.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
const appDigest = digest(1, 123);
const runtimeDigest = digest(2, 234);
const fileHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 9));

function fallbackPrepareUploadResponse(): UploadPrepareResponse {
	return {
		uploadUrl: '',
		uploadHeaders: {},
		expiresAt: ''
	};
}

function fallbackCommitResponse() {
	return {
		storePathHash: StorePath.hash(appPath),
		narHash: appDigest.narHash.toString(),
		status: 'committed' as const
	};
}

describe('runPush', () => {
	it('uploads missing blobs and commits uploaded metadata', async () => {
		const negotiations: UploadNegotiateRequest[] = [];
		const uploads: {
			r2Key: string;
			uploadUrl: string;
			body: Uint8Array;
			contentLength: number;
			headers: Readonly<Record<string, string>>;
		}[] = [];
		const readRequests: string[] = [];
		const commits: string[] = [];
		const results: ResultRow[][] = [];
		const uploadBody = Buffer.from('compressed nar');
		const removedTemporaryDirectories: string[] = [];
		const preparedUploads: {
			uploadId: string;
			body: {
				fileHash: string;
				fileSize: number;
				compression: 'zstd';
			};
		}[] = [];

		await runPush([appPath], reporter(results), {
			client: {
				negotiate(body) {
					negotiations.push(body);

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							},
							{
								action: 'skip',
								storePathHash: StorePath.hash(runtimePath),
								narHash: runtimeDigest.narHash.toString()
							}
						]
					});
				},
				prepareUpload(uploadId, body) {
					preparedUploads.push({ uploadId, body });

					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				async uploadBlob(upload) {
					uploads.push({
						r2Key: upload.r2Key,
						uploadUrl: upload.uploadUrl,
						body: await collectReadableStream(upload.body),
						contentLength: upload.contentLength,
						headers: upload.headers
					});
				},
				commit(target) {
					commits.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [runtimePath]),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createNarArchive: (storePath) =>
				new FakeNarArchive(storePath === appPath ? appDigest : runtimeDigest),
			compressNar: (nar, path) =>
				fakeCompressedNar(nar, path, digestForNar(nar)),
			readCompressedNar(path) {
				readRequests.push(path);

				return byteStream([uploadBody]);
			},
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory(path) {
				removedTemporaryDirectories.push(path);

				return Promise.resolve();
			}
		});

		expect(negotiations).toStrictEqual([
			{
				paths: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						narHash: appDigest.narHash.toString(),
						narSize: 123,
						references: [StorePath.basename(runtimePath)],
						deriver: undefined,
						ca: undefined
					},
					{
						storePathHash: StorePath.hash(runtimePath),
						storePath: runtimePath,
						narHash: runtimeDigest.narHash.toString(),
						narSize: 234,
						references: [],
						deriver: undefined,
						ca: undefined
					}
				]
			}
		]);
		expect(preparedUploads).toStrictEqual([
			{
				uploadId: 'upload-app',
				body: {
					fileHash: fileHash.toString(),
					fileSize: 456,
					compression: 'zstd'
				}
			}
		]);
		expect(uploads).toStrictEqual([
			{
				r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
				uploadUrl: 'https://upload.example/app',
				body: uploadBody,
				contentLength: 456,
				headers: {
					'x-amz-checksum-sha256': fileHash.digestBase64()
				}
			}
		]);
		expect(readRequests).toStrictEqual([
			`/tmp/cupboard-test/${StorePath.hash(appPath)}.nar.zst`
		]);
		expect(commits).toStrictEqual(['upload-app']);
		expect({ removedTemporaryDirectories, results }).toStrictEqual({
			removedTemporaryDirectories: ['/tmp/cupboard-test'],
			results: [
				[
					{ label: 'Uploaded paths', value: '1' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '456 B' },
					{ label: 'Pinned paths', value: '1' },
					{ label: 'Pin expiry', value: 'permanent' }
				]
			]
		});
	});

	it('compresses and prepares NARs in parallel up to the limit', async () => {
		const limit = 2;
		const paths = ['1', '2', '3', '4'].map(
			(n) => `/nix/store/${n}123456789abcdfghijklmnpqrsvwxyz-p${n}`
		);
		const digests = new Map(
			paths.map((path, index) => [path, digest(10 + index, 100 + index)])
		);
		const closure = Object.fromEntries(
			paths.map((path) => [
				path,
				pathInfo(path, knownDigest(digests, path), [])
			])
		);

		let running = 0;
		let peak = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const uploadedKeys: string[] = [];

		await runPush(paths, reporter([]), {
			prepareConcurrency: limit,
			client: {
				negotiate: (body) =>
					Promise.resolve({
						uploads: body.paths.map((path) => ({
							action: 'upload',
							storePathHash: path.storePathHash,
							narHash: path.narHash,
							uploadId: `upload-${path.storePathHash}`,
							r2Key: `nar/${path.narHash}.nar.zst`,
							expiresAt: '2026-05-18T12:00:00.000Z'
						}))
					}),
				prepareUpload: () =>
					Promise.resolve({
						uploadUrl: 'https://upload.example/p',
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					}),
				uploadBlob(upload) {
					uploadedKeys.push(upload.r2Key);

					return Promise.resolve();
				},
				commit: () => Promise.resolve(fallbackCommitResponse()),
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore(closure),
			createNarArchive: (storePath) =>
				new FakeNarArchive(knownDigest(digests, storePath)),
			async compressNar(nar, path) {
				running += 1;
				peak = Math.max(peak, running);

				// Once a full batch is in flight, release the gate so the rest can
				// run; the peak then reveals how many compressed at once.
				if (running >= limit) {
					release?.();
				}

				await gate;
				running -= 1;

				return fakeCompressedNar(nar, path, digestForNar(nar));
			},
			readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ peak, uploaded: uploadedKeys.length }).toStrictEqual({
			peak: limit,
			uploaded: paths.length
		});
	});

	it('re-negotiates and retries an upload whose slot expired before prepare', async () => {
		let negotiations = 0;
		const preparedIds: string[] = [];
		const uploadedKeys: string[] = [];
		const commits: string[] = [];

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
					negotiations += 1;
					const uploadId = negotiations === 1 ? 'upload-stale' : 'upload-fresh';

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId,
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareUpload(uploadId) {
					preparedIds.push(uploadId);

					if (uploadId === 'upload-stale') {
						// The pending row expired and was reaped while the slow prepare
						// queue worked through the closure.
						return Promise.reject(
							new ORPCError('NOT_FOUND', { message: 'Upload expired' })
						);
					}

					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob(upload) {
					uploadedKeys.push(upload.r2Key);

					return Promise.resolve();
				},
				commit(target) {
					commits.push(target.uploadId);

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar, path) =>
				fakeCompressedNar(nar, path, digestForNar(nar)),
			readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ negotiations, preparedIds, uploadedKeys, commits }).toStrictEqual({
			negotiations: 2,
			preparedIds: ['upload-stale', 'upload-fresh'],
			uploadedKeys: [`nar/${appDigest.narHash.toString()}.nar.zst`],
			commits: ['upload-fresh']
		});
	});

	it('re-negotiates and re-uploads when a commit slot expired', async () => {
		let negotiations = 0;
		const preparedIds: string[] = [];
		const uploadedKeys: string[] = [];
		const commitAttempts: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
					negotiations += 1;
					const uploadId = negotiations === 1 ? 'commit-stale' : 'commit-fresh';

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId,
								r2Key,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareUpload(uploadId) {
					preparedIds.push(uploadId);

					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob(upload) {
					uploadedKeys.push(upload.r2Key);

					return Promise.resolve();
				},
				commit(target) {
					commitAttempts.push(target.uploadId);

					if (target.uploadId === 'commit-stale') {
						// The slot expired and was reaped during a long upload phase,
						// taking the staged bytes with it.
						return Promise.reject(
							new CupboardHttpError('POST', '/commit', 404, 'Upload expired')
						);
					}

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar, path) =>
				fakeCompressedNar(nar, path, digestForNar(nar)),
			readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({
			negotiations,
			preparedIds,
			uploadedKeys,
			commitAttempts
		}).toStrictEqual({
			negotiations: 2,
			preparedIds: ['commit-stale', 'commit-fresh'],
			uploadedKeys: [r2Key, r2Key],
			commitAttempts: ['commit-stale', 'commit-fresh']
		});
	});

	it('re-presigns and retries an upload whose presigned URL expired', async () => {
		const preparedIds: string[] = [];
		const uploadAttempts: string[] = [];
		const readRequests: string[] = [];
		const commits: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;
		const expiredBody =
			'<?xml version="1.0" encoding="UTF-8"?><Error><Code>ExpiredRequest</Code><Message>Request has expired</Message></Error>';

		await runPush([appPath], reporter([]), {
			client: {
				negotiate: () =>
					Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					}),
				prepareUpload(uploadId) {
					preparedIds.push(uploadId);

					return Promise.resolve({
						uploadUrl: `https://upload.example/app?attempt=${String(preparedIds.length)}`,
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob(upload) {
					uploadAttempts.push(upload.uploadUrl);

					// The first presigned URL aged out in the prepare-to-upload gap; R2
					// rejects the stale signature so the path must be re-presigned.
					if (uploadAttempts.length === 1) {
						return Promise.reject(
							new CupboardUploadError(
								upload.r2Key,
								StatusCodes.FORBIDDEN,
								expiredBody
							)
						);
					}

					return Promise.resolve();
				},
				commit(target) {
					commits.push(target.uploadId);

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar, path) =>
				fakeCompressedNar(nar, path, digestForNar(nar)),
			readCompressedNar(path) {
				readRequests.push(path);

				return byteStream([Buffer.from('compressed nar')]);
			},
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		const compressedPath = `/tmp/cupboard-test/${StorePath.hash(appPath)}.nar.zst`;

		expect({
			preparedIds,
			uploadAttempts,
			readRequests,
			commits
		}).toStrictEqual({
			preparedIds: ['upload-app', 'upload-app'],
			uploadAttempts: [
				'https://upload.example/app?attempt=1',
				'https://upload.example/app?attempt=2'
			],
			readRequests: [compressedPath, compressedPath],
			commits: ['upload-app']
		});
	});

	it('with --dry-run, reports the plan without uploading or committing', async () => {
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		await runPush([appPath], reporter(results), {
			dryRun: true,
			client: {
				negotiate() {
					clientCalls.push({ method: 'negotiate', paths: [appPath] });

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							},
							{
								action: 'skip',
								storePathHash: StorePath.hash(runtimePath),
								narHash: runtimeDigest.narHash.toString()
							}
						]
					});
				},
				prepareUpload: () => {
					clientCalls.push({ method: 'prepareUpload' });

					return Promise.resolve(fallbackPrepareUploadResponse());
				},
				uploadBlob: () => {
					clientCalls.push({ method: 'uploadBlob' });

					return Promise.resolve();
				},
				commit: () => {
					clientCalls.push({ method: 'commit' });

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: () => {
					clientCalls.push({ method: 'setRoot' });

					return Promise.resolve(rootSummary({ name: '', targets: [] }));
				}
			} satisfies PushClient,
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [runtimePath]),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, results }).toStrictEqual({
			clientCalls: [{ method: 'negotiate', paths: [appPath] }],
			results: [
				[
					{ label: 'Would upload', value: '1' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Would pin paths', value: '1' },
					{ label: 'Pin expiry', value: 'permanent' }
				]
			]
		});
	});

	it('with --no-wait, returns with pending paths and records no retention', async () => {
		const results: ResultRow[][] = [];
		const warnings: { label: string; value?: string }[] = [];
		const clientCalls: unknown[] = [];

		await runPush([appPath], reporter(results, warnings), {
			wait: false,
			client: {
				negotiate(body) {
					clientCalls.push({
						method: 'negotiate',
						paths: body.paths.map((path) => path.storePath)
					});

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareUpload() {
					clientCalls.push({ method: 'prepareUpload' });

					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob() {
					clientCalls.push({ method: 'uploadBlob' });

					return Promise.resolve();
				},
				commit() {
					clientCalls.push({ method: 'commit' });

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'pending'
					});
				},
				setRoot() {
					clientCalls.push({ method: 'setRoot' });

					return Promise.resolve(rootSummary({ name: '', targets: [] }));
				}
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar, path) =>
				fakeCompressedNar(nar, path, digestForNar(nar)),
			readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, results, warnings }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{ method: 'prepareUpload' },
				{ method: 'uploadBlob' },
				{ method: 'commit' }
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '1' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '0' },
					{ label: 'Bytes uploaded', value: '456 B' }
				]
			],
			warnings: [
				{
					label: 'pending verification',
					value:
						'1 path(s) await server-side verification; retention not recorded (omit --no-wait to wait and record it)'
				}
			]
		});
	});

	it('reports reused blobs separately from freshly uploaded paths', async () => {
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		await runPush([appPath], reporter(results), {
			client: {
				negotiate(body) {
					clientCalls.push({
						method: 'negotiate',
						paths: body.paths.map((path) => path.storePath)
					});

					return Promise.resolve({
						uploads: [
							{
								action: 'commit',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'reuse-app'
							}
						]
					});
				},
				uploadBlob() {
					clientCalls.push({ method: 'uploadBlob' });

					return Promise.resolve();
				},
				prepareUpload() {
					clientCalls.push({ method: 'prepareUpload' });

					return Promise.resolve({
						uploadUrl: '',
						uploadHeaders: {},
						expiresAt: ''
					});
				},
				commit(target) {
					clientCalls.push({ method: 'commit', uploadId: target.uploadId });

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(name, body) {
					clientCalls.push({ method: 'setRoot', fields: { name, ...body } });

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [])
			}),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar() {
				clientCalls.push({ method: 'compressNar' });

				return fakeCompressedNar(
					new FakeNarArchive(appDigest),
					appPath,
					appDigest
				);
			},
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{ method: 'commit', uploadId: 'reuse-app' },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				}
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '1' },
					{ label: 'Skipped', value: '0' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Pinned paths', value: '1' },
					{ label: 'Pin expiry', value: 'permanent' }
				]
			]
		});
	});

	it('attaches attestation bundles to the matching pushed closure path', async () => {
		const roots: SetRootCall[] = [];
		const negotiations: AttestationNegotiateRequest[] = [];
		const uploaded: {
			readonly r2Key: string;
			readonly body: Uint8Array;
			readonly contentLength: number;
			readonly headers: Readonly<Record<string, string>>;
		}[] = [];
		const attached: string[] = [];
		const preparedAttestations: string[] = [];
		const readBundles: string[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];
		const bundle = sigstoreBundleBytes(narDigestHex(appDigest.narHash));
		const bundleDigest = sha256Hex(bundle);
		const attestationUpload: AttestationPrepareResponse = {
			uploadUrl: 'https://upload.example/attestation',
			uploadHeaders: { 'x-amz-checksum-sha256': 'attestation-checksum' },
			expiresAt: '2026-05-18T12:00:00.000Z'
		};

		await runPush([appPath], reporter(results), {
			client: {
				...skipClient(roots, clientCalls),
				negotiateAttestations(body) {
					negotiations.push(body);

					return Promise.resolve({
						bundles: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								digest: bundleDigest,
								uploadId: 'attestation-app',
								r2Key: 'staging/attestations/attestation-app',
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareAttestation(uploadId) {
					preparedAttestations.push(uploadId);

					return Promise.resolve(attestationUpload);
				},
				async uploadBlob(upload) {
					uploaded.push({
						r2Key: upload.r2Key,
						body: await collectReadableStream(upload.body),
						contentLength: upload.contentLength,
						headers: upload.headers
					});
				},
				attachAttestation(uploadId) {
					attached.push(uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						digest: bundleDigest,
						predicateType: 'https://slsa.dev/provenance/v1',
						status: 'attached'
					});
				}
			} satisfies PushClient,
			attestations: [{ path: 'app.sigstore.json' }],
			readAttestationBundle(path) {
				readBundles.push(path);

				return Promise.resolve(bundle);
			},
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect(negotiations).toStrictEqual([
			{
				bundles: [
					{
						storePathHash: StorePath.hash(appPath),
						digest: bundleDigest
					}
				]
			}
		]);
		expect({ preparedAttestations, readBundles }).toStrictEqual({
			preparedAttestations: ['attestation-app'],
			readBundles: ['app.sigstore.json']
		});
		expect({ clientCalls, roots }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				}
			],
			roots: [
				{
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				}
			]
		});
		expect(uploaded).toStrictEqual([
			{
				r2Key: 'staging/attestations/attestation-app',
				body: Buffer.from(bundle),
				contentLength: bundle.byteLength,
				headers: { 'x-amz-checksum-sha256': 'attestation-checksum' }
			}
		]);
		expect(attached).toStrictEqual(['attestation-app']);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Already cached', value: '0' },
				{ label: 'Skipped', value: '1' },
				{ label: 'Bytes uploaded', value: '0 B' },
				{
					label: 'Attestations',
					value: '1 attached, 0 reused, 0 deferred'
				},
				{
					label: 'Attestation upload',
					value: formatBytes(bundle.byteLength)
				},
				{ label: 'Pinned paths', value: '1' },
				{ label: 'Pin expiry', value: 'permanent' }
			]
		]);
	});

	it('attaches a multi-subject bundle to every matching closure path', async () => {
		const roots: SetRootCall[] = [];
		const negotiations: AttestationNegotiateRequest[] = [];
		const uploaded: {
			readonly r2Key: string;
			readonly body: Uint8Array;
			readonly contentLength: number;
			readonly headers: Readonly<Record<string, string>>;
		}[] = [];
		const attached: string[] = [];
		const preparedAttestations: string[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];
		const bundle = sigstoreBundleBytes([
			narDigestHex(appDigest.narHash),
			narDigestHex(runtimeDigest.narHash)
		]);
		const bundleDigest = sha256Hex(bundle);
		const attestationUpload: AttestationPrepareResponse = {
			uploadUrl: 'https://upload.example/attestation',
			uploadHeaders: { 'x-amz-checksum-sha256': 'attestation-checksum' },
			expiresAt: '2026-05-18T12:00:00.000Z'
		};

		await runPush([appPath], reporter(results), {
			client: {
				...skipClient(roots, clientCalls),
				negotiateAttestations(body) {
					negotiations.push(body);

					return Promise.resolve({
						bundles: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								digest: bundleDigest,
								uploadId: 'attestation-app',
								r2Key: 'staging/attestations/attestation-app',
								expiresAt: '2026-05-18T12:00:00.000Z'
							},
							{
								action: 'upload',
								storePathHash: StorePath.hash(runtimePath),
								digest: bundleDigest,
								uploadId: 'attestation-runtime',
								r2Key: 'staging/attestations/attestation-runtime',
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareAttestation(uploadId) {
					preparedAttestations.push(uploadId);

					return Promise.resolve(attestationUpload);
				},
				async uploadBlob(upload) {
					uploaded.push({
						r2Key: upload.r2Key,
						body: await collectReadableStream(upload.body),
						contentLength: upload.contentLength,
						headers: upload.headers
					});
				},
				attachAttestation(uploadId) {
					attached.push(uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						digest: bundleDigest,
						predicateType: 'https://slsa.dev/provenance/v1',
						status: 'attached'
					});
				}
			} satisfies PushClient,
			attestations: [{ path: 'build.sigstore.json' }],
			readAttestationBundle: () => Promise.resolve(bundle),
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [runtimePath]),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect(negotiations).toStrictEqual([
			{
				bundles: [
					{ storePathHash: StorePath.hash(appPath), digest: bundleDigest },
					{ storePathHash: StorePath.hash(runtimePath), digest: bundleDigest }
				]
			}
		]);
		expect({ preparedAttestations, attached }).toStrictEqual({
			preparedAttestations: ['attestation-app', 'attestation-runtime'],
			attached: ['attestation-app', 'attestation-runtime']
		});
		expect(uploaded).toStrictEqual([
			{
				r2Key: 'staging/attestations/attestation-app',
				body: Buffer.from(bundle),
				contentLength: bundle.byteLength,
				headers: { 'x-amz-checksum-sha256': 'attestation-checksum' }
			},
			{
				r2Key: 'staging/attestations/attestation-runtime',
				body: Buffer.from(bundle),
				contentLength: bundle.byteLength,
				headers: { 'x-amz-checksum-sha256': 'attestation-checksum' }
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Already cached', value: '0' },
				{ label: 'Skipped', value: '2' },
				{ label: 'Bytes uploaded', value: '0 B' },
				{
					label: 'Attestations',
					value: '2 attached, 0 reused, 0 deferred'
				},
				{
					label: 'Attestation upload',
					value: formatBytes(bundle.byteLength * 2)
				},
				{ label: 'Pinned paths', value: '1' },
				{ label: 'Pin expiry', value: 'permanent' }
			]
		]);
	});

	it('skips attestation work when attachment is disabled', async () => {
		const roots: SetRootCall[] = [];
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(roots, clientCalls),
			attest: false,
			attestations: [{ path: 'app.sigstore.json' }],
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				}
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Pinned paths', value: '1' },
					{ label: 'Pin expiry', value: 'permanent' }
				]
			]
		});
	});

	it('rejects an attestation bundle whose subject is outside the closure', async () => {
		const otherDigest = digest(9, 999);
		const bundle = sigstoreBundleBytes(narDigestHex(otherDigest.narHash));
		const clientCalls: unknown[] = [];
		const readBundles: string[] = [];

		const outcome = await (async () => {
			try {
				await runPush([appPath], reporter([]), {
					client: skipClient([], clientCalls),
					attestations: [{ path: 'other.sigstore.json' }],
					readAttestationBundle(path) {
						readBundles.push(path);

						return Promise.resolve(bundle);
					},
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
					createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
					removeTemporaryDirectory: () => Promise.resolve()
				});
				return { pushed: true };
			} catch (error_: unknown) {
				const error = z
					.instanceof(AttestationSubjectNotPushedError)
					.parse(error_);

				return {
					error: {
						name: error.name,
						path: error.path,
						subjectDigests: error.subjectDigests
					}
				};
			}
		})();

		expect({ outcome, clientCalls, readBundles }).toStrictEqual({
			outcome: {
				error: {
					name: AttestationSubjectNotPushedError.name,
					path: 'other.sigstore.json',
					subjectDigests: [narDigestHex(otherDigest.narHash)]
				}
			},
			clientCalls: [{ method: 'negotiate', paths: [appPath] }],
			readBundles: ['other.sigstore.json']
		});
	});

	it('compresses and hashes uploaded NARs in a single pass', async () => {
		const archives: FakeNarArchive[] = [];

		await runPush([appPath], reporter([]), {
			client: {
				negotiate: () =>
					Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					}),
				prepareUpload: () =>
					Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {},
						expiresAt: '2026-05-18T12:00:00.000Z'
					}),
				uploadBlob: () => Promise.resolve(),
				commit: () =>
					Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					}),
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [])
			}),
			createNarArchive: () => {
				const archive = new FakeNarArchive(appDigest);
				archives.push(archive);

				return archive;
			},
			compressNar: (nar, path) => fakeCompressedNar(nar, path, appDigest),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect(archives.map((archive) => archive.iterations)).toStrictEqual([1]);
	});

	it('rejects mismatched computed NAR metadata with a typed error', async () => {
		const clientCalls: unknown[] = [];
		const expectedPathInfo = pathInfo(appPath, appDigest, []);
		const actualNar = await fakeCompressedNar(
			new FakeNarArchive(digest(8, 999)),
			'/tmp/cupboard-test/app.nar.zst',
			digest(8, 999)
		);

		const options = {
			client: {
				negotiate(body) {
					clientCalls.push({
						method: 'negotiate',
						paths: body.paths.map((path) => path.storePath)
					});

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareUpload() {
					clientCalls.push({ method: 'prepareUpload' });

					return Promise.resolve(fallbackPrepareUploadResponse());
				},
				uploadBlob() {
					clientCalls.push({ method: 'uploadBlob' });

					return Promise.resolve();
				},
				commit() {
					clientCalls.push({ method: 'commit' });

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot() {
					clientCalls.push({ method: 'setRoot' });

					return Promise.resolve(rootSummary({ name: '', targets: [] }));
				}
			} satisfies PushClient,
			nix: nixStore({
				[appPath]: expectedPathInfo
			}),
			createNarArchive: () => new FakeNarArchive(digest(8, 999)),
			compressNar: (nar, path) => fakeCompressedNar(nar, path, digest(8, 999)),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		} satisfies PushDependencies;
		const outcome = await (async () => {
			try {
				await runPush([appPath], reporter([]), options);
				return { pushed: true };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(PushNarMetadataMismatchError);

				if (error_ instanceof PushNarMetadataMismatchError) {
					return {
						error: {
							name: error_.name,
							storePath: error_.storePath,
							expectedNarHash: error_.expectedNarHash,
							actualNarHash: error_.actualNarHash,
							expectedNarSize: error_.expectedNarSize,
							actualNarSize: error_.actualNarSize
						}
					};
				}

				return { pushed: true };
			}
		})();

		expect({ outcome, clientCalls }).toStrictEqual({
			outcome: {
				error: {
					name: PushNarMetadataMismatchError.name,
					storePath: appPath,
					expectedNarHash: expectedPathInfo.narHash.toString(),
					actualNarHash: actualNar.narDigest.narHash.toString(),
					expectedNarSize: expectedPathInfo.narSize,
					actualNarSize: actualNar.narDigest.narSize
				}
			},
			clientCalls: [{ method: 'negotiate', paths: [appPath] }]
		});
	});

	it('sets a named channel to the pushed paths with --root', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(roots, clientCalls),
			root: 'main',
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, roots, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{ method: 'setRoot', fields: { name: 'main', targets: [appPath] } }
			],
			roots: [{ fields: { name: 'main', targets: [appPath] } }],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Root', value: 'main' },
					{ label: 'Root expiry', value: 'permanent' }
				]
			]
		});
	});

	it('sets an expiring channel with --root and --ttl', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(roots, clientCalls),
			root: 'main',
			ttlSeconds: 1_209_600,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, roots, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{
					method: 'setRoot',
					fields: { name: 'main', targets: [appPath], ttlSeconds: 1_209_600 }
				}
			],
			roots: [
				{ fields: { name: 'main', targets: [appPath], ttlSeconds: 1_209_600 } }
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Root', value: 'main' },
					{
						label: 'Root expiry',
						value: 'expires 2026-01-15T00:00:00.000Z'
					}
				]
			]
		});
	});

	it('pins each pushed path when no root is given', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath, runtimePath], reporter(results), {
			client: skipClient(roots, clientCalls),
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, roots, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath, runtimePath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				},
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(runtimePath)}`,
						targets: [runtimePath]
					}
				}
			],
			roots: [
				{
					fields: { name: `pin:${StorePath.hash(appPath)}`, targets: [appPath] }
				},
				{
					fields: {
						name: `pin:${StorePath.hash(runtimePath)}`,
						targets: [runtimePath]
					}
				}
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '2' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Pinned paths', value: '2' },
					{ label: 'Pin expiry', value: 'permanent' }
				]
			]
		});
	});

	it('applies --ttl to implicit pins when no root is given', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(roots, clientCalls),
			ttlSeconds: 604_800,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, roots, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath],
						ttlSeconds: 604_800
					}
				}
			],
			roots: [
				{
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath],
						ttlSeconds: 604_800
					}
				}
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Pinned paths', value: '1' },
					{ label: 'Pin expiry', value: 'expires 2026-01-15T00:00:00.000Z' }
				]
			]
		});
	});

	it('derives a stable pin name when the same path is pushed again', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const dependencies = {
			client: skipClient(roots, clientCalls),
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		};

		await runPush([appPath], reporter([]), dependencies);
		await runPush([appPath], reporter([]), dependencies);

		expect({ clientCalls, roots }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				},
				{ method: 'negotiate', paths: [appPath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				}
			],
			roots: [
				{
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				},
				{
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath]
					}
				}
			]
		});
	});

	it('records retention only after committing the uploads', async () => {
		const events: string[] = [];

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
					events.push('negotiate');

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				prepareUpload() {
					events.push('prepareUpload');

					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob() {
					events.push('uploadBlob');

					return Promise.resolve();
				},
				commit() {
					events.push('commit');

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar, path) => fakeCompressedNar(nar, path, appDigest),
			readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect(events).toStrictEqual([
			'negotiate',
			'prepareUpload',
			'uploadBlob',
			'commit',
			'setRoot'
		]);
	});

	it('reports an expiry range when expiring pins differ', async () => {
		const expiries = ['2026-01-15T00:00:00.000Z', '2026-01-15T00:00:05.000Z'];
		let call = 0;
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		const client: PushClient = {
			negotiate(body) {
				clientCalls.push({
					method: 'negotiate',
					paths: body.paths.map((path) => path.storePath)
				});

				return Promise.resolve({
					uploads: body.paths.map((path) => ({
						action: 'skip',
						storePathHash: path.storePathHash,
						narHash: path.narHash
					}))
				});
			},
			prepareUpload() {
				clientCalls.push({ method: 'prepareUpload' });

				return Promise.resolve(fallbackPrepareUploadResponse());
			},
			uploadBlob() {
				clientCalls.push({ method: 'uploadBlob' });

				return Promise.resolve();
			},
			commit() {
				clientCalls.push({ method: 'commit' });

				return Promise.resolve(fallbackCommitResponse());
			},
			setRoot(name, body) {
				const expiresAt = expiries.at(call) ?? expiries.at(-1);
				call += 1;
				clientCalls.push({ method: 'setRoot', fields: { name, ...body } });

				return Promise.resolve(rootSummary({ name, ...body }, expiresAt));
			}
		};

		await runPush([appPath, runtimePath], reporter(results), {
			client,
			ttlSeconds: 604_800,
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		});

		expect({ clientCalls, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath, runtimePath] },
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(appPath)}`,
						targets: [appPath],
						ttlSeconds: 604_800
					}
				},
				{
					method: 'setRoot',
					fields: {
						name: `pin:${StorePath.hash(runtimePath)}`,
						targets: [runtimePath],
						ttlSeconds: 604_800
					}
				}
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '2' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Pinned paths', value: '2' },
					{
						label: 'Pin expiry',
						value:
							'expires 2026-01-15T00:00:00.000Z to 2026-01-15T00:00:05.000Z'
					}
				]
			]
		});
	});

	it('parks the commit for a deferred upload, then records retention', async () => {
		const events: string[] = [];
		const commitOptions: CommitOptions[] = [];

		await runPush([appPath], reporter([]), {
			wait: true,
			waitTimeoutSeconds: 30,
			client: {
				...deferredUpload(events),
				commit(_uploadId, options) {
					events.push('commit');
					commitOptions.push(options);

					// The client parks on the commit socket and settles once the
					// verification verdict arrives.
					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			...deferredDeps()
		});

		expect({ events, commitOptions }).toStrictEqual({
			events: ['negotiate', 'prepareUpload', 'uploadBlob', 'commit', 'setRoot'],
			commitOptions: [{ wait: true, timeoutSeconds: 30 }]
		});
	});

	it('records a failed commit, warns with its reason, and fails incomplete', async () => {
		const warnings: { label: string; value?: string }[] = [];
		const events: string[] = [];

		const options = {
			client: {
				...deferredUpload(events),
				commit() {
					events.push('commit');

					return Promise.reject(
						new UploadVerificationFailedError('upload-app', 'mismatch')
					);
				},
				setRoot(name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			...deferredDeps()
		} satisfies PushDependencies;
		const outcome = await (async () => {
			try {
				await runPush([appPath], reporter([], warnings), options);
				return { pushed: true };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(PushIncompleteError);

				if (error_ instanceof PushIncompleteError) {
					return {
						error: {
							name: error_.name,
							failedPaths: error_.failedPaths
						}
					};
				}

				return { pushed: true };
			}
		})();

		expect({ outcome, events }).toStrictEqual({
			outcome: {
				error: {
					name: PushIncompleteError.name,
					failedPaths: [StorePath.basename(appPath)]
				}
			},
			events: ['negotiate', 'prepareUpload', 'uploadBlob', 'commit']
		});

		expect(warnings).toStrictEqual([
			{
				label: 'commit failed',
				value: `${StorePath.basename(appPath)}: An uploaded NAR did not match the hash it declared. Re-run cupboard push to retry.`
			},
			{
				label: 'incomplete',
				value:
					'1 path(s) failed; retention not recorded, re-run cupboard push to finish'
			}
		]);
	});

	it('uploads what it can, skips retention, and fails when an upload fails', async () => {
		const uploaded: string[] = [];
		const committed: string[] = [];
		const roots: RootSetBody[] = [];

		const options = {
			client: {
				negotiate: () =>
					Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-app',
								r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							},
							{
								action: 'upload',
								storePathHash: StorePath.hash(runtimePath),
								narHash: runtimeDigest.narHash.toString(),
								uploadId: 'upload-runtime',
								r2Key: `nar/${runtimeDigest.narHash.toString()}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					}),
				prepareUpload: (uploadId) =>
					Promise.resolve({
						uploadUrl: `https://upload.example/${uploadId}`,
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					}),
				async uploadBlob(upload) {
					await collectReadableStream(upload.body);

					if (upload.r2Key.includes(runtimeDigest.narHash.toString())) {
						throw new CupboardUploadError(upload.r2Key, 500, 'boom');
					}

					uploaded.push(upload.r2Key);
				},
				commit(target) {
					committed.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(_name, body) {
					roots.push(body);

					return Promise.resolve(rootSummary({ name: '', ...body }));
				}
			} satisfies PushClient,
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createNarArchive: (storePath) =>
				new FakeNarArchive(storePath === appPath ? appDigest : runtimeDigest),
			compressNar: (nar, path) =>
				fakeCompressedNar(nar, path, digestForNar(nar)),
			readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
			createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
			removeTemporaryDirectory: () => Promise.resolve()
		} satisfies PushDependencies;
		const outcome = await (async () => {
			try {
				await runPush([appPath, runtimePath], reporter([]), options);
				return { pushed: true };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(PushIncompleteError);

				if (error_ instanceof PushIncompleteError) {
					return {
						error: {
							name: error_.name,
							failedPaths: error_.failedPaths
						}
					};
				}

				return { pushed: true };
			}
		})();

		expect({ outcome, uploaded, committed, roots }).toStrictEqual({
			outcome: {
				error: {
					name: PushIncompleteError.name,
					failedPaths: [StorePath.basename(runtimePath)]
				}
			},
			uploaded: [`nar/${appDigest.narHash.toString()}.nar.zst`],
			committed: ['upload-app'],
			roots: []
		});
	});
});

function deferredUpload(
	events: string[]
): Pick<PushClient, 'negotiate' | 'prepareUpload' | 'uploadBlob' | 'commit'> {
	return {
		negotiate() {
			events.push('negotiate');

			return Promise.resolve({
				uploads: [
					{
						action: 'upload',
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						uploadId: 'upload-app',
						r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
						expiresAt: '2026-05-18T12:00:00.000Z'
					}
				]
			});
		},
		prepareUpload() {
			events.push('prepareUpload');

			return Promise.resolve({
				uploadUrl: 'https://upload.example/app',
				uploadHeaders: {},
				expiresAt: '2026-05-18T12:00:00.000Z'
			});
		},
		uploadBlob() {
			events.push('uploadBlob');

			return Promise.resolve();
		},
		commit() {
			events.push('commit');

			return Promise.resolve({
				storePathHash: StorePath.hash(appPath),
				narHash: appDigest.narHash.toString(),
				status: 'pending'
			});
		}
	};
}

function deferredDeps() {
	return {
		nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
		createNarArchive: () => new FakeNarArchive(appDigest),
		compressNar: (nar: PushNarArchive, path: string) =>
			fakeCompressedNar(nar, path, appDigest),
		readCompressedNar: () => byteStream([Buffer.from('compressed nar')]),
		createTemporaryDirectory: () => Promise.resolve('/tmp/cupboard-test'),
		removeTemporaryDirectory: () => Promise.resolve()
	} satisfies Partial<PushDependencies>;
}

class FakeNarArchive {
	iterations = 0;

	constructor(readonly digestValue: NarDigest) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		this.iterations += 1;
		await Promise.resolve();

		yield this.digestValue.narHash.digestBytes();
	}
}

async function fakeCompressedNar(
	nar: PushNarArchive,
	path: string,
	narDigest: NarDigest
): Promise<CompressedAndHashedNarFile> {
	await drain(nar);

	return {
		compressed: new CompressedNarFile(path, {
			fileHash,
			fileSize: 456,
			compression: 'zstd'
		}),
		narDigest
	} satisfies CompressedAndHashedNarFile;
}

async function drain(source: PushNarArchive): Promise<void> {
	await collectReadableStream(byteStream(source));
}

async function collectReadableStream(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];

	try {
		let isDone = false;

		while (!isDone) {
			const next = await reader.read();
			isDone = next.done;

			if (next.done) {
				continue;
			}

			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}

	return Buffer.concat(chunks);
}

function digestForNar(nar: PushNarArchive): NarDigest {
	if (!(nar instanceof FakeNarArchive)) {
		throw new TypeError('expected a FakeNarArchive');
	}

	return nar.digestValue;
}

function knownDigest(digests: Map<string, NarDigest>, path: string): NarDigest {
	const value = digests.get(path);

	if (value === undefined) {
		throw new Error(`no digest for ${path}`);
	}

	return value;
}

function digest(byte: number, narSize: number): NarDigest {
	return {
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, byte)),
		narSize
	};
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

function narDigestHex(hash: NixSha256Hash): string {
	return [...hash.digestBytes()]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function pathInfo(
	storePath: string,
	narDigest: NarDigest,
	references: readonly string[]
): NixValidPathInfo {
	return {
		storePath,
		narHash: narDigest.narHash,
		narSize: narDigest.narSize,
		references,
		signatures: []
	};
}

function knownPathInfo(
	paths: Record<string, NixValidPathInfo>,
	storePath: string
): NixValidPathInfo {
	return z
		.custom<NixValidPathInfo>((value) => value !== undefined)
		.parse(paths[storePath]);
}

function nixStore(paths: Record<string, NixValidPathInfo>): Nix {
	const store = {
		resolveClosure(storePaths: readonly string[]) {
			const closure = new Set(storePaths);

			for (const storePath of storePaths) {
				const references = paths[storePath]?.references ?? [];
				for (const reference of references) {
					closure.add(reference);
				}
			}

			return Promise.resolve(
				[...closure].map((storePath) => knownPathInfo(paths, storePath))
			);
		},
		queryPathInfo: (storePath: string) =>
			Promise.resolve(knownPathInfo(paths, storePath))
	};

	return Nix.forStore(store, {
		storeDirectory: '/nix/store',
		realpath: (path) => path
	});
}

function rootSummary(
	fields: SetRootFields,
	expiresAtOverride?: string
): RootSetResponse {
	const base = {
		name: fields.name,
		expired: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		targets: fields.targets.map((storePath) => ({
			storePathHash: StorePath.hash(storePath),
			storePath,
			present: true
		}))
	};
	const expiresAt =
		expiresAtOverride ??
		(fields.ttlSeconds === undefined ? undefined : '2026-01-15T00:00:00.000Z');

	if (expiresAt === undefined) {
		return base;
	}

	return { ...base, expiresAt };
}

type SetRootFields = RootSetBody & { readonly name: string };

interface SetRootCall {
	readonly fields: SetRootFields;
}

function skipClient(roots: SetRootCall[], clientCalls: unknown[]): PushClient {
	return {
		negotiate(body) {
			clientCalls.push({
				method: 'negotiate',
				paths: body.paths.map((path) => path.storePath)
			});

			return Promise.resolve({
				uploads: body.paths.map((path) => ({
					action: 'skip',
					storePathHash: path.storePathHash,
					narHash: path.narHash
				}))
			});
		},
		prepareUpload() {
			clientCalls.push({ method: 'prepareUpload' });

			return Promise.resolve(fallbackPrepareUploadResponse());
		},
		uploadBlob() {
			clientCalls.push({ method: 'uploadBlob' });

			return Promise.resolve();
		},
		commit() {
			clientCalls.push({ method: 'commit' });

			return Promise.resolve(fallbackCommitResponse());
		},
		setRoot(name, body) {
			const fields = { name, ...body };
			clientCalls.push({ method: 'setRoot', fields });
			roots.push({ fields });

			return Promise.resolve(rootSummary(fields));
		}
	};
}

function reporter(
	results: ResultRow[][],
	warnings: { label: string; value?: string }[] = []
): Reporter {
	const recordWarn = (label: string, value?: string): void => {
		warnings.push({ label, value });
	};

	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact(label, value) {
						void label;
						void value;
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
		},
		data() {
			return;
		},
		error() {
			return;
		},
		warn: recordWarn,
		info(message) {
			void message;
		},
		success(message) {
			void message;
		},
		step(message) {
			void message;
		}
	};
}
