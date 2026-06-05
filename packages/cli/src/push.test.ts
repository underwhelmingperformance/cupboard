import { StorePath } from '@cupboard/nix/store-path';
import type {
	RootSetBody,
	RootSetResponse
} from '@cupboard/protocol/retention';
import type { UploadNegotiateRequest } from '@cupboard/protocol/upload';
import { describe, expect, it } from 'vitest';

import { type CompressedAndHashedNarFile, CompressedNarFile } from './blob.ts';
import { byteStream } from './byte-stream.ts';
import type { AccessCredential } from './client.ts';
import { PushNarMetadataMismatchError } from './errors.ts';
import { type NarDigest, NixSha256Hash } from './nar.ts';
import type { NixStoreClient, NixValidPathInfo } from './nix-store.ts';
import { type PushClient, type PushNarArchive, runPush } from './push.ts';
import type { Reporter, ResultRow } from './reporter.ts';

const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
const appDigest = digest(1, 123);
const runtimeDigest = digest(2, 234);
const fileHash = NixSha256Hash.fromDigest(Buffer.alloc(32, 9));

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
				negotiate(token, body) {
					expect(token).toBe('write-token');
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
				prepareUpload(token, uploadId, body) {
					expect(token).toBe('write-token');
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
				commit(token, uploadId) {
					expect(token).toBe('write-token');
					commits.push(uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(token, name, body) {
					expect(token).toBe('write-token');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			token: 'write-token',
			nixStore: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [runtimePath]),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createNarArchive: (storePath) =>
				new FakeNarArchive(storePath === appPath ? appDigest : runtimeDigest),
			compressNar(nar, path) {
				return fakeCompressedNar(nar, path, digestForNar(nar));
			},
			readCompressedNar(path) {
				readRequests.push(path);

				return byteStream([uploadBody]);
			},
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory(path) {
				expect(path).toBe('/tmp/cupboard-test');

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
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '1' },
				{ label: 'Reused blobs', value: '0' },
				{ label: 'Skipped', value: '1' },
				{ label: 'Uploaded', value: '456 B' },
				{ label: 'Pinned paths', value: '1' },
				{ label: 'Pin expiry', value: 'permanent' }
			]
		]);
	});

	it('warns when a commit is left pending server-side verification', async () => {
		const results: ResultRow[][] = [];
		const warnings: { label: string; value?: string }[] = [];

		await runPush([appPath], reporter(results, warnings), {
			client: {
				negotiate() {
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
					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {
							'x-amz-checksum-sha256': fileHash.digestBase64()
						},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob() {
					return Promise.resolve();
				},
				commit() {
					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'pending'
					});
				},
				setRoot(token, name, body) {
					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			token: 'write-token',
			nixStore: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar(nar, path) {
				return fakeCompressedNar(nar, path, digestForNar(nar));
			},
			readCompressedNar() {
				return byteStream([Buffer.from('compressed nar')]);
			},
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(warnings).toStrictEqual([
			{
				label: 'pending verification',
				value:
					'1 path(s) await server-side verification before they can be substituted'
			}
		]);
	});

	it('reports reused blobs separately from freshly uploaded paths', async () => {
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: {
				negotiate() {
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
					throw new UnexpectedPushClientCallError('uploadBlob');
				},
				prepareUpload() {
					throw new UnexpectedPushClientCallError('prepareUpload');
				},
				commit(_token, uploadId) {
					expect(uploadId).toBe('reuse-app');

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(_token, name, body) {
					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			token: 'write-token',
			nixStore: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [])
			}),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar() {
				throw new UnexpectedPushClientCallError('compressNar');
			},
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Reused blobs', value: '1' },
				{ label: 'Skipped', value: '0' },
				{ label: 'Uploaded', value: '0 B' },
				{ label: 'Pinned paths', value: '1' },
				{ label: 'Pin expiry', value: 'permanent' }
			]
		]);
	});

	it('compresses and hashes uploaded NARs in a single pass', async () => {
		const archives: FakeNarArchive[] = [];

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
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
					return Promise.resolve({
						uploadUrl: 'https://upload.example/app',
						uploadHeaders: {},
						expiresAt: '2026-05-18T12:00:00.000Z'
					});
				},
				uploadBlob() {
					return Promise.resolve();
				},
				commit() {
					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed'
					});
				},
				setRoot(_token, name, body) {
					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			token: 'write-token',
			nixStore: nixStore({
				[appPath]: pathInfo(appPath, appDigest, [])
			}),
			createNarArchive: () => {
				const archive = new FakeNarArchive(appDigest);
				archives.push(archive);

				return archive;
			},
			compressNar(nar, path) {
				return fakeCompressedNar(nar, path, appDigest);
			},
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(archives.map((archive) => archive.iterations)).toStrictEqual([1]);
	});

	it('rejects mismatched computed NAR metadata with a typed error', async () => {
		await expect(
			runPush([appPath], reporter([]), {
				client: {
					negotiate() {
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
						throw new UnexpectedPushClientCallError('prepareUpload');
					},
					uploadBlob() {
						throw new UnexpectedPushClientCallError('uploadBlob');
					},
					commit() {
						throw new UnexpectedPushClientCallError('commit');
					},
					setRoot() {
						throw new UnexpectedPushClientCallError('setRoot');
					}
				} satisfies PushClient,
				token: 'write-token',
				nixStore: nixStore({
					[appPath]: pathInfo(appPath, appDigest, [])
				}),
				createNarArchive: () => new FakeNarArchive(digest(8, 999)),
				compressNar(nar, path) {
					return fakeCompressedNar(nar, path, digest(8, 999));
				},
				createTemporaryDirectory() {
					return Promise.resolve('/tmp/cupboard-test');
				},
				removeTemporaryDirectory() {
					return Promise.resolve();
				}
			})
		).rejects.toThrow(PushNarMetadataMismatchError);
	});

	it('sets a named channel to the pushed paths with --root', async () => {
		const setRoots: SetRootCall[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(setRoots),
			token: 'write-token',
			root: 'main',
			nixStore: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(setRoots).toStrictEqual([
			{ token: 'write-token', fields: { name: 'main', targets: [appPath] } }
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Reused blobs', value: '0' },
				{ label: 'Skipped', value: '1' },
				{ label: 'Uploaded', value: '0 B' },
				{ label: 'Root', value: 'main' },
				{ label: 'Root expiry', value: 'permanent' }
			]
		]);
	});

	it('sets an expiring channel with --root and --ttl', async () => {
		const setRoots: SetRootCall[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(setRoots),
			token: 'write-token',
			root: 'main',
			ttlSeconds: 1_209_600,
			nixStore: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(setRoots).toStrictEqual([
			{
				token: 'write-token',
				fields: { name: 'main', targets: [appPath], ttlSeconds: 1_209_600 }
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Reused blobs', value: '0' },
				{ label: 'Skipped', value: '1' },
				{ label: 'Uploaded', value: '0 B' },
				{ label: 'Root', value: 'main' },
				{ label: 'Root expiry', value: 'expires 2026-01-15T00:00:00.000Z' }
			]
		]);
	});

	it('pins each pushed path when no root is given', async () => {
		const setRoots: SetRootCall[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath, runtimePath], reporter(results), {
			client: skipClient(setRoots),
			token: 'write-token',
			nixStore: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(setRoots).toStrictEqual([
			{
				token: 'write-token',
				fields: { name: `pin:${StorePath.hash(appPath)}`, targets: [appPath] }
			},
			{
				token: 'write-token',
				fields: {
					name: `pin:${StorePath.hash(runtimePath)}`,
					targets: [runtimePath]
				}
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Reused blobs', value: '0' },
				{ label: 'Skipped', value: '2' },
				{ label: 'Uploaded', value: '0 B' },
				{ label: 'Pinned paths', value: '2' },
				{ label: 'Pin expiry', value: 'permanent' }
			]
		]);
	});

	it('applies --ttl to implicit pins when no root is given', async () => {
		const setRoots: SetRootCall[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(setRoots),
			token: 'write-token',
			ttlSeconds: 604_800,
			nixStore: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(setRoots).toStrictEqual([
			{
				token: 'write-token',
				fields: {
					name: `pin:${StorePath.hash(appPath)}`,
					targets: [appPath],
					ttlSeconds: 604_800
				}
			}
		]);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Reused blobs', value: '0' },
				{ label: 'Skipped', value: '1' },
				{ label: 'Uploaded', value: '0 B' },
				{ label: 'Pinned paths', value: '1' },
				{ label: 'Pin expiry', value: 'expires 2026-01-15T00:00:00.000Z' }
			]
		]);
	});

	it('derives a stable pin name when the same path is pushed again', async () => {
		const setRoots: SetRootCall[] = [];
		const dependencies = {
			client: skipClient(setRoots),
			token: 'write-token',
			nixStore: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		};

		await runPush([appPath], reporter([]), dependencies);
		await runPush([appPath], reporter([]), dependencies);

		expect(setRoots.map((call) => call.fields.name)).toStrictEqual([
			`pin:${StorePath.hash(appPath)}`,
			`pin:${StorePath.hash(appPath)}`
		]);
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
				setRoot(_token, name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			token: 'write-token',
			nixStore: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar(nar, path) {
				return fakeCompressedNar(nar, path, appDigest);
			},
			readCompressedNar() {
				return byteStream([Buffer.from('compressed nar')]);
			},
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
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

		const client: PushClient = {
			negotiate(_token, body) {
				return Promise.resolve({
					uploads: body.paths.map((path) => ({
						action: 'skip',
						storePathHash: path.storePathHash,
						narHash: path.narHash
					}))
				});
			},
			prepareUpload() {
				throw new UnexpectedPushClientCallError('prepareUpload');
			},
			uploadBlob() {
				throw new UnexpectedPushClientCallError('uploadBlob');
			},
			commit() {
				throw new UnexpectedPushClientCallError('commit');
			},
			setRoot(_token, name, body) {
				const expiresAt = expiries.at(call) ?? expiries.at(-1);
				call += 1;

				return Promise.resolve(rootSummary({ name, ...body }, expiresAt));
			}
		};

		await runPush([appPath, runtimePath], reporter(results), {
			client,
			token: 'write-token',
			ttlSeconds: 604_800,
			nixStore: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			}),
			createTemporaryDirectory() {
				return Promise.resolve('/tmp/cupboard-test');
			},
			removeTemporaryDirectory() {
				return Promise.resolve();
			}
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Reused blobs', value: '0' },
				{ label: 'Skipped', value: '2' },
				{ label: 'Uploaded', value: '0 B' },
				{ label: 'Pinned paths', value: '2' },
				{
					label: 'Pin expiry',
					value: 'expires 2026-01-15T00:00:00.000Z to 2026-01-15T00:00:05.000Z'
				}
			]
		]);
	});
});

class FakeNarArchive {
	iterations = 0;

	constructor(readonly digestValue: NarDigest) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		this.iterations += 1;
		await Promise.resolve();

		yield this.digestValue.narHash.digestBytes();
	}
}

function fakeCompressedNar(
	nar: PushNarArchive,
	path: string,
	narDigest: NarDigest
): Promise<CompressedAndHashedNarFile> {
	return drain(nar).then(
		() =>
			({
				compressed: new CompressedNarFile(path, {
					fileHash,
					fileSize: 456,
					compression: 'zstd'
				}),
				narDigest
			}) satisfies CompressedAndHashedNarFile
	);
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
		let done = false;

		while (!done) {
			const next = await reader.read();
			done = next.done;

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
	if (nar instanceof FakeNarArchive) {
		return nar.digestValue;
	}

	throw new UnexpectedNarArchiveError();
}

function digest(byte: number, narSize: number): NarDigest {
	return {
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, byte)),
		narSize
	};
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

function nixStore(paths: Record<string, NixValidPathInfo>): NixStoreClient {
	return {
		resolveClosure(storePaths) {
			const closure = new Set(storePaths);

			for (const storePath of storePaths) {
				for (const reference of paths[storePath]?.references ?? []) {
					closure.add(reference);
				}
			}

			return Promise.resolve(
				[...closure].map((storePath) => {
					const info = paths[storePath];

					if (info !== undefined) {
						return info;
					}

					throw new UnexpectedPathInfoRequestError(storePath);
				})
			);
		},
		queryPathInfo(storePath) {
			const info = paths[storePath];

			if (info !== undefined) {
				return Promise.resolve(info);
			}

			throw new UnexpectedPathInfoRequestError(storePath);
		}
	};
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

type SetRootFields = { readonly name: string } & RootSetBody;

interface SetRootCall {
	readonly token: AccessCredential;
	readonly fields: SetRootFields;
}

function skipClient(setRoots: SetRootCall[]): PushClient {
	return {
		negotiate(_token, body) {
			return Promise.resolve({
				uploads: body.paths.map((path) => ({
					action: 'skip',
					storePathHash: path.storePathHash,
					narHash: path.narHash
				}))
			});
		},
		prepareUpload() {
			throw new UnexpectedPushClientCallError('prepareUpload');
		},
		uploadBlob() {
			throw new UnexpectedPushClientCallError('uploadBlob');
		},
		commit() {
			throw new UnexpectedPushClientCallError('commit');
		},
		setRoot(token, name, body) {
			const fields = { name, ...body };
			setRoots.push({ token, fields });

			return Promise.resolve(rootSummary(fields));
		}
	};
}

function reporter(
	results: ResultRow[][],
	warnings: { label: string; value?: string }[] = []
): Reporter {
	return {
		phase(_label, body) {
			return Promise.resolve(
				body({
					fact(label, value) {
						void label;
						void value;
					}
				})
			);
		},
		result(rows) {
			results.push([...rows]);
		},
		warn(label, value) {
			warnings.push({ label, value });
		},
		info(message) {
			void message;
		}
	};
}

class UnexpectedPathInfoRequestError extends Error {
	constructor(public readonly storePath: string) {
		super(`Unexpected path info request: ${storePath}`);
		this.name = 'UnexpectedPathInfoRequestError';
	}
}

class UnexpectedPushClientCallError extends Error {
	constructor(public readonly method: keyof PushClient | 'compressNar') {
		super(`Unexpected push client call: ${method}`);
		this.name = 'UnexpectedPushClientCallError';
	}
}

class UnexpectedNarArchiveError extends Error {
	constructor() {
		super('Unexpected NAR archive');
		this.name = 'UnexpectedNarArchiveError';
	}
}
