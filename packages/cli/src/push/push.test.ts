import { createHash } from 'node:crypto';

import { Nix, type NixValidPathInfo } from '@cupboard/nix';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { AttestationNegotiateRequest } from '@cupboard/protocol/attestations';
import type {
	RootSetBody,
	RootSetResponse
} from '@cupboard/protocol/retention';
import type { UploadNegotiateRequest } from '@cupboard/protocol/upload';
import { formatBytes, type Reporter, type ResultRow } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CommitOptions } from '../client/client.ts';
import {
	AttestationDivergedPathError,
	AttestationSubjectNotPushedError,
	CupboardHttpError,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	UploadVerificationFailedError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';
import type { NarUploadStream } from '../nix/blob.ts';
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
const compressedNarBytes = Buffer.from('compressed nar');

function fallbackCommitResponse() {
	return {
		storePathHash: StorePath.hash(appPath),
		narHash: appDigest.narHash.toString(),
		status: 'committed' as const,
		settled: Promise.resolve()
	};
}

describe('runPush', () => {
	it('uploads missing blobs and commits uploaded metadata', async () => {
		const negotiations: Omit<UploadNegotiateRequest, 'pushId'>[] = [];
		const uploads: {
			r2Key: string;
			body: Uint8Array;
		}[] = [];
		const commits: string[] = [];
		const results: ResultRow[][] = [];

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
				async uploadNar(r2Key, body) {
					uploads.push({ r2Key, body: await collectReadableStream(body) });
				},
				commit(target) {
					commits.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed',
						settled: Promise.resolve()
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
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
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
		expect(uploads).toStrictEqual([
			{
				r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
				body: compressedNarBytes
			}
		]);
		expect(commits).toStrictEqual(['upload-app']);
		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '1' },
				{ label: 'Already cached', value: '0' },
				{ label: 'Skipped', value: '1' },
				{ label: 'Bytes uploaded', value: '14 B' },
				{ label: 'Pinned paths', value: '1' },
				{ label: 'Pin expiry', value: 'permanent' }
			]
		]);
	});

	it('uploads NARs in parallel up to the limit', async () => {
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
		const { promise: gate, resolve: release }: PromiseWithResolvers<void> =
			Promise.withResolvers();
		const uploadedKeys: string[] = [];

		await runPush(paths, reporter([]), {
			uploadConcurrency: limit,
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
				async uploadNar(r2Key, body) {
					running += 1;
					peak = Math.max(peak, running);

					// Once a full batch is in flight, release the gate so the rest can
					// run; the peak then reveals how many uploaded at once.
					if (running >= limit) {
						release();
					}

					await gate;
					running -= 1;

					await collectReadableStream(body);
					uploadedKeys.push(r2Key);
				},
				commit: () => Promise.resolve(fallbackCommitResponse()),
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore(closure),
			createNarArchive: (storePath) =>
				new FakeNarArchive(knownDigest(digests, storePath)),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		expect({ peak, uploaded: uploadedKeys.length }).toStrictEqual({
			peak: limit,
			uploaded: paths.length
		});
	});

	it('re-negotiates and re-uploads when a commit slot expired', async () => {
		let negotiations = 0;
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
				async uploadNar(key, body) {
					await collectReadableStream(body);
					uploadedKeys.push(key);
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
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		expect({
			negotiations,
			uploadedKeys,
			commitAttempts
		}).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key, r2Key],
			commitAttempts: ['commit-stale', 'commit-fresh']
		});
	});

	it('re-negotiates and uploads when a reuse commit finds its blob gone', async () => {
		let negotiations = 0;
		const uploadedKeys: string[] = [];
		const commitAttempts: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
					negotiations += 1;

					// The first negotiate offers a reuse of a shared blob; by commit
					// time the blob was collected, so the re-negotiate (the tenant's
					// presence edge credited back) plans a fresh upload.
					if (negotiations === 1) {
						return Promise.resolve({
							uploads: [
								{
									action: 'commit',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									uploadId: 'reuse-gone'
								}
							]
						});
					}

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-fresh',
								r2Key,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				async uploadNar(key, body) {
					await collectReadableStream(body);
					uploadedKeys.push(key);
				},
				commit(target) {
					commitAttempts.push(target.uploadId);

					if (target.uploadId === 'reuse-gone') {
						return Promise.reject(
							new CupboardHttpError(
								'POST',
								'/commit',
								404,
								'Uploaded object not found'
							)
						);
					}

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		expect({
			negotiations,
			uploadedKeys,
			commitAttempts
		}).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key],
			commitAttempts: ['reuse-gone', 'upload-fresh']
		});
	});

	it('re-negotiates when a deferred commit settles absent', async () => {
		let negotiations = 0;
		const uploadedKeys: string[] = [];
		const commitAttempts: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
					negotiations += 1;

					// The first negotiate offers a reuse; the canonical object is
					// collected while the deferred commit awaits its verdict, so the
					// verify pass answers absent and the re-negotiate plans a fresh
					// upload.
					if (negotiations === 1) {
						return Promise.resolve({
							uploads: [
								{
									action: 'commit',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									uploadId: 'reuse-absent'
								}
							]
						});
					}

					return Promise.resolve({
						uploads: [
							{
								action: 'upload',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString(),
								uploadId: 'upload-fresh',
								r2Key,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				async uploadNar(key, body) {
					await collectReadableStream(body);
					uploadedKeys.push(key);
				},
				commit(target) {
					commitAttempts.push(target.uploadId);

					if (target.uploadId === 'reuse-absent') {
						return Promise.reject(
							new UploadVerificationFailedError('reuse-absent', 'absent')
						);
					}

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		expect({
			negotiations,
			uploadedKeys,
			commitAttempts
		}).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key],
			commitAttempts: ['reuse-absent', 'upload-fresh']
		});
	});

	it('re-negotiates when a deferred verdict settles absent in the wait phase', async () => {
		let negotiations = 0;
		const uploadedKeys: string[] = [];
		const commitAttempts: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		// The deferred verdict rejects `absent` on `settled`, not on the ack, so only
		// the wait phase's re-drive recovers it. Assert-and-observe the rejection so
		// it is never unhandled before the wait phase awaits it.
		const absentVerdict = Promise.reject(
			new UploadVerificationFailedError('upload-defer', 'absent')
		);
		const absentObserved = expect(absentVerdict).rejects.toBeInstanceOf(
			UploadVerificationFailedError
		);

		await runPush([appPath], reporter([]), {
			client: {
				negotiate() {
					negotiations += 1;

					// The re-negotiate finds the path already in the store, so the
					// re-drive needs no fresh upload.
					if (negotiations === 1) {
						return Promise.resolve({
							uploads: [
								{
									action: 'upload',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									uploadId: 'upload-defer',
									r2Key,
									expiresAt: '2026-05-18T12:00:00.000Z'
								}
							]
						});
					}

					return Promise.resolve({
						uploads: [
							{
								action: 'skip',
								storePathHash: StorePath.hash(appPath),
								narHash: appDigest.narHash.toString()
							}
						]
					});
				},
				async uploadNar(key, body) {
					await collectReadableStream(body);
					uploadedKeys.push(key);
				},
				commit(target) {
					commitAttempts.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'pending' as const,
						settled: absentVerdict
					});
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		// The push succeeds: the absent verdict re-negotiated and the store already
		// held the path, so no verification failure is reported.
		expect({ negotiations, uploadedKeys, commitAttempts }).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key],
			commitAttempts: ['upload-defer']
		});
		await absentObserved;
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
				uploadNar: () => {
					clientCalls.push({ method: 'uploadNar' });

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
			})
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

	it('with --no-wait, records retention over pending paths without waiting', async () => {
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
				async uploadNar(_r2Key, body) {
					clientCalls.push({ method: 'uploadNar' });
					await collectReadableStream(body);
				},
				commit() {
					clientCalls.push({ method: 'commit' });

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'pending',
						settled: Promise.resolve()
					});
				},
				setRoot() {
					clientCalls.push({ method: 'setRoot' });

					return Promise.resolve(rootSummary({ name: '', targets: [] }));
				}
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		expect({ clientCalls, results, warnings }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{ method: 'uploadNar' },
				{ method: 'commit' },
				{ method: 'setRoot' }
			],
			results: [
				[
					{ label: 'Uploaded paths', value: '1' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '0' },
					{ label: 'Bytes uploaded', value: '14 B' },
					{ label: 'Pinned paths', value: '1' },
					{ label: 'Pin expiry', value: 'permanent' }
				]
			],
			warnings: []
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
				uploadNar() {
					clientCalls.push({ method: 'uploadNar' });

					return Promise.resolve();
				},
				commit(target) {
					clientCalls.push({ method: 'commit', uploadId: target.uploadId });

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed',
						settled: Promise.resolve()
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
			compressNar(nar) {
				clientCalls.push({ method: 'compressNar' });

				return fakeNarUpload(nar, appDigest);
			}
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
		const negotiations: Omit<AttestationNegotiateRequest, 'pushId'>[] = [];
		const uploaded: {
			readonly r2Key: string;
			readonly body: Uint8Array;
		}[] = [];
		const attached: string[] = [];
		const readBundles: string[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];
		const bundle = sigstoreBundleBytes(narDigestHex(appDigest.narHash));
		const bundleDigest = sha256Hex(bundle);

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
				async uploadNar(r2Key, body) {
					uploaded.push({ r2Key, body: await collectReadableStream(body) });
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
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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
		expect(readBundles).toStrictEqual(['app.sigstore.json']);
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
				body: Buffer.from(bundle)
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

	it('attaches a deferred path’s attestation only after committing and waiting', async () => {
		// A deferred path has no committed narinfo row until its verdict settles, and
		// the server refuses an attestation attach on such a path. So the attach must
		// run after retention and the wait, not before: assert it follows `setRoot`.
		const events: string[] = [];
		const appHash = StorePath.hash(appPath);
		const bundle = sigstoreBundleBytes(narDigestHex(appDigest.narHash));
		const bundleDigest = sha256Hex(bundle);

		await runPush([appPath], reporter([]), {
			client: {
				...deferredUpload([]),
				commit() {
					return Promise.resolve({
						storePathHash: appHash,
						narHash: appDigest.narHash.toString(),
						status: 'pending' as const,
						settled: Promise.resolve()
					});
				},
				setRoot: (name, body) => {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				},
				negotiateAttestations() {
					return Promise.resolve({
						bundles: [
							{
								action: 'upload',
								storePathHash: appHash,
								digest: bundleDigest,
								uploadId: 'attestation-app',
								r2Key: 'staging/attestations/attestation-app',
								expiresAt: '2026-05-18T12:00:00.000Z'
							}
						]
					});
				},
				attachAttestation(uploadId) {
					events.push(`attach:${uploadId}`);

					return Promise.resolve({
						storePathHash: appHash,
						digest: bundleDigest,
						predicateType: 'https://slsa.dev/provenance/v1',
						status: 'attached'
					});
				}
			} satisfies PushClient,
			attestations: [{ path: 'app.sigstore.json' }],
			readAttestationBundle: () => Promise.resolve(bundle),
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		expect(events).toStrictEqual(['setRoot', 'attach:attestation-app']);
	});

	it('attaches a multi-subject bundle to every matching closure path', async () => {
		const roots: SetRootCall[] = [];
		const negotiations: Omit<AttestationNegotiateRequest, 'pushId'>[] = [];
		const uploaded: {
			readonly r2Key: string;
			readonly body: Uint8Array;
		}[] = [];
		const attached: string[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];
		const bundle = sigstoreBundleBytes([
			narDigestHex(appDigest.narHash),
			narDigestHex(runtimeDigest.narHash)
		]);
		const bundleDigest = sha256Hex(bundle);

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
				async uploadNar(r2Key, body) {
					uploaded.push({ r2Key, body: await collectReadableStream(body) });
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
			})
		});

		expect(negotiations).toStrictEqual([
			{
				bundles: [
					{ storePathHash: StorePath.hash(appPath), digest: bundleDigest },
					{ storePathHash: StorePath.hash(runtimePath), digest: bundleDigest }
				]
			}
		]);
		expect(attached).toStrictEqual(['attestation-app', 'attestation-runtime']);
		expect(uploaded).toStrictEqual([
			{
				r2Key: 'staging/attestations/attestation-app',
				body: Buffer.from(bundle)
			},
			{
				r2Key: 'staging/attestations/attestation-runtime',
				body: Buffer.from(bundle)
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
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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

		// The pushed path is valid and retained; attestations attach after the wait,
		// so a bad bundle rejects only after retention is recorded.
		expect({ outcome, clientCalls, readBundles }).toStrictEqual({
			outcome: {
				error: {
					name: AttestationSubjectNotPushedError.name,
					path: 'other.sigstore.json',
					subjectDigests: [narDigestHex(otherDigest.narHash)]
				}
			},
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
			readBundles: ['other.sigstore.json']
		});
	});

	it('warns when the cache holds a different NAR for a skipped path', async () => {
		const cacheDigest = digest(9, 999);
		const warnings: { label: string; value?: string }[] = [];
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		await runPush([appPath], reporter(results, warnings), {
			client: divergentSkipClient(
				cacheDigest.narHash.toString(),
				[],
				clientCalls
			),
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ clientCalls, warnings }).toStrictEqual({
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
			warnings: [
				{
					label: 'divergent',
					value:
						`${StorePath.basename(appPath)}: local NAR ` +
						`${appDigest.narHash.toString()} differs from the cached copy ` +
						`${cacheDigest.narHash.toString()}; the cache keeps its copy`
				}
			]
		});
	});

	it('rejects attaching an attestation for a path whose cached NAR differs', async () => {
		const cacheDigest = digest(9, 999);
		const bundle = sigstoreBundleBytes(narDigestHex(appDigest.narHash));
		const clientCalls: unknown[] = [];
		const attestationNegotiations: unknown[] = [];

		const outcome = await (async () => {
			try {
				await runPush([appPath], reporter([]), {
					client: {
						...divergentSkipClient(
							cacheDigest.narHash.toString(),
							[],
							clientCalls
						),
						negotiateAttestations(body) {
							attestationNegotiations.push(body);

							return Promise.resolve({ bundles: [] });
						}
					},
					attestations: [{ path: 'app.sigstore.json' }],
					readAttestationBundle: () => Promise.resolve(bundle),
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
				});
				return { pushed: true };
			} catch (error_: unknown) {
				const error = z.instanceof(AttestationDivergedPathError).parse(error_);

				return {
					error: {
						name: error.name,
						storePath: error.storePath,
						localNarHash: error.localNarHash,
						cacheNarHash: error.cacheNarHash
					}
				};
			}
		})();

		// The bundle describes the local bytes, which the cache does not hold, so
		// the attach can never succeed: fail before any attestation negotiation.
		expect({ outcome, attestationNegotiations }).toStrictEqual({
			outcome: {
				error: {
					name: AttestationDivergedPathError.name,
					storePath: appPath,
					localNarHash: appDigest.narHash.toString(),
					cacheNarHash: cacheDigest.narHash.toString()
				}
			},
			attestationNegotiations: []
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
				uploadNar: async (_r2Key, body) => {
					await collectReadableStream(body);
				},
				commit: () =>
					Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed',
						settled: Promise.resolve()
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
			compressNar: (nar) => fakeNarUpload(nar, appDigest)
		});

		expect(archives.map((archive) => archive.iterations)).toStrictEqual([1]);
	});

	it('records mismatched computed NAR metadata as a push failure', async () => {
		const clientCalls: unknown[] = [];
		const warnings: { label: string; value?: string }[] = [];
		const expectedPathInfo = pathInfo(appPath, appDigest, []);
		const actualDigest = digest(8, 999);
		const mismatch = new PushNarMetadataMismatchError(
			appPath,
			expectedPathInfo.narHash.toString(),
			actualDigest.narHash.toString(),
			expectedPathInfo.narSize,
			actualDigest.narSize
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
				async uploadNar(_r2Key, body) {
					clientCalls.push({ method: 'uploadNar' });
					await collectReadableStream(body);
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
			createNarArchive: () => new FakeNarArchive(actualDigest),
			compressNar: (nar) => fakeNarUpload(nar, actualDigest)
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

		expect({ outcome, clientCalls, warnings }).toStrictEqual({
			outcome: {
				error: {
					name: PushIncompleteError.name,
					failedPaths: [StorePath.basename(appPath)]
				}
			},
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{ method: 'uploadNar' }
			],
			warnings: [
				{
					label: 'upload failed',
					value: `${StorePath.basename(appPath)}: ${mismatch.message}`
				},
				{
					label: 'incomplete',
					value:
						'1 path(s) failed to commit; retention not recorded, re-run cupboard push to finish'
				}
			]
		});
	});

	it('sets a named channel to the pushed paths with --root', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(roots, clientCalls),
			root: 'main',
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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
			})
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
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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

	it('with --no-retain, records no root or pin and reports the unretained row', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush([appPath], reporter(results), {
			client: skipClient(roots, clientCalls),
			retain: false,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ clientCalls, roots, results }).toStrictEqual({
			clientCalls: [{ method: 'negotiate', paths: [appPath] }],
			roots: [],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Retention', value: 'none (--no-retain)' }
				]
			]
		});
	});

	it('with --no-retain --dry-run, reports the unretained row without a plan RPC', async () => {
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		await runPush([appPath], reporter(results), {
			dryRun: true,
			retain: false,
			client: skipClient([], clientCalls),
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ clientCalls, results }).toStrictEqual({
			clientCalls: [{ method: 'negotiate', paths: [appPath] }],
			results: [
				[
					{ label: 'Would upload', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Retention', value: 'none (--no-retain)' }
				]
			]
		});
	});

	it.each([
		{ name: 'the default wait', wait: undefined },
		{ name: '--no-wait', wait: false }
	])(
		'composes --no-retain with $name: no root is set either way',
		async ({ wait }) => {
			const events: string[] = [];

			const results: ResultRow[][] = [];

			await runPush([appPath], reporter(results), {
				...(wait !== undefined && { wait }),
				retain: false,
				client: {
					...deferredUpload(events),
					setRoot(name, body) {
						events.push('setRoot');

						return Promise.resolve(rootSummary({ name, ...body }));
					}
				} satisfies PushClient,
				...deferredDependencies()
			});

			expect({ events, results }).toStrictEqual({
				events: ['negotiate', 'uploadNar', 'commit'],
				results: [
					[
						{ label: 'Uploaded paths', value: '1' },
						{ label: 'Already cached', value: '0' },
						{ label: 'Skipped', value: '0' },
						{ label: 'Bytes uploaded', value: '14 B' },
						{ label: 'Retention', value: 'none (--no-retain)' }
					]
				]
			});
		}
	);

	it('derives a stable pin name when the same path is pushed again', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const dependencies = {
			client: skipClient(roots, clientCalls),
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
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
				async uploadNar(_r2Key, body) {
					events.push('uploadNar');
					await collectReadableStream(body);
				},
				commit() {
					events.push('commit');

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed',
						settled: Promise.resolve()
					});
				},
				setRoot(name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, appDigest)
		});

		expect(events).toStrictEqual([
			'negotiate',
			'uploadNar',
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
			uploadNar() {
				clientCalls.push({ method: 'uploadNar' });

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
			})
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
						status: 'committed',
						settled: Promise.resolve()
					});
				},
				setRoot(name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			...deferredDependencies()
		});

		expect({ events, commitOptions }).toStrictEqual({
			events: ['negotiate', 'uploadNar', 'commit', 'setRoot'],
			commitOptions: [{ timeoutSeconds: 30 }]
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
			...deferredDependencies()
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
			events: ['negotiate', 'uploadNar', 'commit']
		});

		expect(warnings).toStrictEqual([
			{
				label: 'commit failed',
				value: `${StorePath.basename(appPath)}: An uploaded NAR did not match the hash it declared. Re-run cupboard push to retry.`
			},
			{
				label: 'incomplete',
				value:
					'1 path(s) failed to commit; retention not recorded, re-run cupboard push to finish'
			}
		]);
	});

	it('records retention, then fails a deferred upload whose verdict fails', async () => {
		const warnings: { label: string; value?: string }[] = [];
		const events: string[] = [];

		// The deferred verdict fails after the ack. Assert its rejection, which also
		// observes it from creation so the gap before the wait phase awaits it never
		// surfaces an unhandled rejection.
		const failedVerdict = Promise.reject(
			new UploadVerificationFailedError('upload-app', 'mismatch')
		);
		const verdictFailed = expect(failedVerdict).rejects.toBeInstanceOf(
			UploadVerificationFailedError
		);

		const options = {
			client: {
				...deferredUpload(events),
				commit() {
					events.push('commit');

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'pending' as const,
						settled: failedVerdict
					});
				},
				setRoot(name, body) {
					events.push('setRoot');

					return Promise.resolve(rootSummary({ name, ...body }));
				}
			} satisfies PushClient,
			...deferredDependencies()
		} satisfies PushDependencies;

		const outcome = await (async () => {
			try {
				await runPush([appPath], reporter([], warnings), options);
				return { pushed: true };
			} catch (error_: unknown) {
				expect(error_).toBeInstanceOf(PushIncompleteError);

				if (error_ instanceof PushIncompleteError) {
					return {
						error: { name: error_.name, failedPaths: error_.failedPaths }
					};
				}

				return { pushed: true };
			}
		})();

		// Retention is recorded before the wait, so the failed verdict does not undo
		// it (the server prunes the failed target); the push still fails loudly.
		expect({ outcome, events }).toStrictEqual({
			outcome: {
				error: {
					name: PushIncompleteError.name,
					failedPaths: [StorePath.basename(appPath)]
				}
			},
			events: ['negotiate', 'uploadNar', 'commit', 'setRoot']
		});

		expect(warnings).toStrictEqual([
			{
				label: 'verification failed',
				value: `${StorePath.basename(appPath)}: An uploaded NAR did not match the hash it declared. Re-run cupboard push to retry.`
			}
		]);
		await verdictFailed;
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
				async uploadNar(r2Key, body) {
					await collectReadableStream(body);

					if (r2Key.includes(runtimeDigest.narHash.toString())) {
						throw new Error('boom');
					}

					uploaded.push(r2Key);
				},
				commit(target) {
					committed.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.toString(),
						status: 'committed',
						settled: Promise.resolve()
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
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
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
): Pick<PushClient, 'negotiate' | 'uploadNar' | 'commit'> {
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
		async uploadNar(_r2Key, body) {
			events.push('uploadNar');
			await collectReadableStream(body);
		},
		commit() {
			events.push('commit');

			return Promise.resolve({
				storePathHash: StorePath.hash(appPath),
				narHash: appDigest.narHash.toString(),
				status: 'pending' as const,
				settled: Promise.resolve()
			});
		}
	};
}

function deferredDependencies() {
	return {
		nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
		createNarArchive: () => new FakeNarArchive(appDigest),
		compressNar: (nar: PushNarArchive) => fakeNarUpload(nar, appDigest)
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

function fakeNarUpload(
	nar: PushNarArchive,
	narDigest: NarDigest,
	body: Uint8Array = compressedNarBytes
): NarUploadStream {
	return {
		body: new ReadableStream<Uint8Array>({
			async start(controller) {
				await drain(nar);
				controller.enqueue(body);
				controller.close();
			}
		}),
		digest: () => narDigest
	};
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
		signatures: [],
		ultimate: true
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
		uploadNar() {
			clientCalls.push({ method: 'uploadNar' });

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

// A cache that already holds every negotiated path, but with a NAR hash other
// than the one the client computed locally: the two sides realised the same
// store path with different bytes.
function divergentSkipClient(
	cacheNarHash: string,
	roots: SetRootCall[],
	clientCalls: unknown[]
): PushClient {
	return {
		...skipClient(roots, clientCalls),
		negotiate(body) {
			clientCalls.push({
				method: 'negotiate',
				paths: body.paths.map((path) => path.storePath)
			});

			return Promise.resolve({
				uploads: body.paths.map((path) => ({
					action: 'skip' as const,
					storePathHash: path.storePathHash,
					narHash: cacheNarHash
				}))
			});
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
