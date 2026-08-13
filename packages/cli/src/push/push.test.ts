import { createHash } from 'node:crypto';

import {
	Nix,
	type NixStoreKind,
	NixStorePathNotFoundError,
	type NixValidPathInfo
} from '@cupboard/nix';
import {
	graceSecondsSchema,
	rootNameSchema,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type { AttestationNegotiateRequest } from '@cupboard/protocol/attestations';
import type { ParsedBuildReceiptV3 } from '@cupboard/protocol/build';
import { pushSummaryResultKind } from '@cupboard/protocol/reports';
import {
	type RootSetBody,
	rootSetMaxTargets,
	type RootSetResponse
} from '@cupboard/protocol/retention';
import {
	type ParsedUploadPreviewResponse,
	type UploadNegotiateRequest,
	uploadNegotiateResponseSchema,
	type UploadPathMetadataFields,
	type UploadPreviewRequest,
	uploadPreviewResponseSchema
} from '@cupboard/protocol/upload';
import {
	formatBytes,
	type Reporter,
	type ResultPayload,
	type ResultRow
} from '@cupboard/reporter';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { CommitOptions, CommitTarget } from '../client/client.ts';
import { waitTimeoutSecondsSchema } from '../duration.ts';
import {
	AttestationDivergedPathError,
	AttestationSubjectNotPushedError,
	CupboardHttpError,
	PushIncompleteError,
	PushNarMetadataMismatchError,
	ReferenceUploadRequiredError,
	UploadGraceFactsUnsupportedError,
	UploadVerificationFailedError
} from '../errors.ts';
import { byteStream } from '../io/byte-stream.ts';
import type { NarUploadStream } from '../nix/blob.ts';
import { type NarDigest, NixSha256Hash } from '../nix/nar.ts';
import { prepareStorePathNegotiation } from '../nix/nix-store.ts';

import { PublicationCollection } from './publication.ts';
import {
	type PushClient,
	type PushDependencies,
	type PushNarArchive,
	RootTargetLimitError,
	runPush
} from './push.ts';

const rootName = (value: string) => rootNameSchema.parse(value);

function publication(
	targets: readonly string[],
	intermediatePaths?: readonly string[]
): PublicationCollection {
	return PublicationCollection.of({
		targets,
		...(intermediatePaths !== undefined && { intermediatePaths })
	});
}

const appPath = storePathSchema.parse(
	'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
);
const runtimePath = storePathSchema.parse(
	'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime'
);
const appDigest = digest(1, 123);
const runtimeDigest = digest(2, 234);
const compressedNarBytes = Buffer.from('compressed nar');

// The served metadata a reference entry resolves for `appPath`: the path
// fields negotiate carries plus the blob fields the served narinfo names.
function referenceMetadata(): UploadPathMetadataFields {
	return {
		storePathHash: StorePath.hash(appPath),
		storePath: appPath,
		narHash: appDigest.narHash.toString(),
		narSize: 123,
		references: [],
		fileHash: 'sha256:1123456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk',
		fileSize: 99,
		compression: 'zstd'
	};
}

function fallbackCommitResponse() {
	return {
		storePathHash: StorePath.hash(appPath),
		narHash: appDigest.narHash.value,
		status: 'committed' as const,
		settled: Promise.resolve()
	};
}

// The default `preview` a mutating-push fixture gets: mutating pushes never
// call it, so a call here means the flow under test regressed into calling
// preview instead of negotiate.
function unexpectedPreviewCall(): Promise<ParsedUploadPreviewResponse> {
	return Promise.reject(
		new Error('preview should not be called during a mutating push')
	);
}

// The `negotiate` twin a dry-run fixture gets: `--dry-run` never negotiates,
// so a call here means the flow under test regressed into negotiating
// instead of previewing.
function unexpectedNegotiateCall(): Promise<never> {
	return Promise.reject(
		new Error('negotiate should not be called during a dry run')
	);
}

// A dry run stages no bytes, commits nothing, and records no retention: these
// three stand in for a fixture's `uploadNar`/`commit`/`setRoot` so a call to
// any of them during `--dry-run` fails the test loudly.
function unexpectedUploadNarCall(): Promise<never> {
	return Promise.reject(
		new Error('uploadNar should not be called during a dry run')
	);
}

function unexpectedCommitCall(): Promise<never> {
	return Promise.reject(
		new Error('commit should not be called during a dry run')
	);
}

function unexpectedSetRootCall(): Promise<never> {
	return Promise.reject(
		new Error('setRoot should not be called during a dry run')
	);
}

describe('runPush', () => {
	it('refuses an oversized named root before resolving or uploading paths', async () => {
		const paths = Array.from(
			{ length: rootSetMaxTargets + 1 },
			(_, index) =>
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
		);

		await expect(
			runPush(publication(paths), reporter([]), {
				root: rootName('main'),
				nix: nixStore({}),
				client: {
					preview: unexpectedPreviewCall,
					negotiate: unexpectedNegotiateCall,
					uploadNar: unexpectedUploadNarCall,
					commit: unexpectedCommitCall,
					setRoot: unexpectedSetRootCall
				}
			})
		).rejects.toStrictEqual(
			new RootTargetLimitError(rootSetMaxTargets + 1, rootSetMaxTargets)
		);
	});

	it('uploads missing blobs and commits uploaded metadata', async () => {
		const negotiations: Omit<UploadNegotiateRequest, 'pushId'>[] = [];
		const uploads: {
			r2Key: string;
			body: Uint8Array;
		}[] = [];
		const commits: string[] = [];
		const results: ResultRow[][] = [];

		await runPush(publication([appPath]), reporter(results), {
			closure: true,
			client: {
				preview: unexpectedPreviewCall,
				negotiate(body) {
					negotiations.push(body);

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
				},
				async uploadNar(r2Key, body) {
					uploads.push({ r2Key, body: await collectReadableStream(body) });
				},
				commit(target) {
					commits.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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

	it('carries the run root into the negotiate request', async () => {
		const negotiations: Omit<UploadNegotiateRequest, 'pushId'>[] = [];

		await runPush(publication([appPath]), reporter([]), {
			runRoot: {
				name: rootName('ci/run-1'),
				ttlSeconds: ttlSecondsSchema.parse(3600)
			},
			client: {
				preview: unexpectedPreviewCall,
				negotiate(body) {
					negotiations.push(body);

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
							uploads: [
								{
									action: 'skip',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString()
								}
							]
						})
					);
				},
				uploadNar: unexpectedUploadNarCall,
				commit: unexpectedCommitCall,
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect(negotiations).toStrictEqual([
			{
				attachRoot: { name: 'ci/run-1', ttlSeconds: 3600 },
				paths: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						narHash: appDigest.narHash.toString(),
						narSize: 123,
						references: [],
						deriver: undefined,
						ca: undefined
					}
				]
			}
		]);
	});

	it('uploads NARs in parallel up to the limit', async () => {
		const limit = 2;
		const paths = ['1', '2', '3', '4'].map((n) =>
			storePathSchema.parse(
				`/nix/store/${n}123456789abcdfghijklmnpqrsvwxyz-p${n}`
			)
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

		await runPush(publication(paths), reporter([]), {
			uploadConcurrency: limit,
			client: {
				preview: unexpectedPreviewCall,
				negotiate: (body) =>
					Promise.resolve(
						uploadNegotiateResponseSchema.parse({
							uploads: body.paths.map((path) => ({
								action: 'upload',
								storePathHash: path.storePathHash,
								narHash: path.narHash,
								uploadId: `upload-${path.storePathHash}`,
								r2Key: `nar/${path.narHash}.nar.zst`,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}))
						})
					),
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
		const payloads: ResultPayload[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush(publication([appPath]), reporter([], [], payloads), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate() {
					negotiations += 1;
					const uploadId = negotiations === 1 ? 'commit-stale' : 'commit-fresh';

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
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
			commitAttempts,
			summary: payloads.at(-1)?.data
		}).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key, r2Key],
			commitAttempts: ['commit-stale', 'commit-fresh'],
			summary: {
				uploadedPaths: 1,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 28,
				failures: [],
				paths: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						outcome: 'committed'
					}
				]
			}
		});
	});

	it('re-negotiates and uploads when a reuse commit finds its blob gone', async () => {
		let negotiations = 0;
		const uploadedKeys: string[] = [];
		const commitAttempts: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush(publication([appPath]), reporter([]), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate() {
					negotiations += 1;

					// The first negotiate offers a reuse of a shared blob; by commit
					// time the blob was collected, so the re-negotiate (the tenant's
					// presence edge credited back) plans a fresh upload.
					if (negotiations === 1) {
						return Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: [
									{
										action: 'commit',
										storePathHash: StorePath.hash(appPath),
										narHash: appDigest.narHash.toString(),
										uploadId: 'reuse-gone'
									}
								]
							})
						);
					}

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
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
		const payloads: ResultPayload[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush(publication([appPath]), reporter([], [], payloads), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate() {
					negotiations += 1;

					// The first negotiate offers a reuse; the canonical object is
					// collected while the deferred commit awaits its verdict, so the
					// verify pass answers absent and the re-negotiate plans a fresh
					// upload.
					if (negotiations === 1) {
						return Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: [
									{
										action: 'commit',
										storePathHash: StorePath.hash(appPath),
										narHash: appDigest.narHash.toString(),
										uploadId: 'reuse-absent'
									}
								]
							})
						);
					}

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
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

		// The re-drive replaced the reuse with a real upload, so the summary
		// counts the work that actually happened.
		expect({
			negotiations,
			uploadedKeys,
			commitAttempts,
			summary: payloads.at(-1)?.data
		}).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key],
			commitAttempts: ['reuse-absent', 'upload-fresh'],
			summary: {
				uploadedPaths: 1,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 14,
				failures: [],
				paths: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						outcome: 'committed'
					}
				]
			}
		});
	});

	it('re-negotiates when a deferred verdict settles absent in the wait phase', async () => {
		let negotiations = 0;
		const uploadedKeys: string[] = [];
		const commitAttempts: string[] = [];
		const payloads: ResultPayload[] = [];
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

		await runPush(publication([appPath]), reporter([], [], payloads), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate() {
					negotiations += 1;

					// The re-negotiate finds the path already in the store, so the
					// re-drive needs no fresh upload.
					if (negotiations === 1) {
						return Promise.resolve(
							uploadNegotiateResponseSchema.parse({
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
							})
						);
					}

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
							uploads: [
								{
									action: 'skip',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString()
								}
							]
						})
					);
				},
				async uploadNar(key, body) {
					await collectReadableStream(body);
					uploadedKeys.push(key);
				},
				commit(target) {
					commitAttempts.push(target.uploadId);

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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
		expect({
			negotiations,
			uploadedKeys,
			commitAttempts,
			summary: payloads.at(-1)?.data
		}).toStrictEqual({
			negotiations: 2,
			uploadedKeys: [r2Key],
			commitAttempts: ['upload-defer'],
			summary: {
				uploadedPaths: 0,
				reusedBlobs: 0,
				skipped: 1,
				uploadedBytes: 14,
				failures: [],
				paths: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						outcome: 'already-present'
					}
				]
			}
		});
		await absentObserved;
	});

	it('with --dry-run, previews without negotiating, uploading or committing', async () => {
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];
		const previews: UploadPreviewRequest[] = [];

		await runPush(publication([appPath]), reporter(results), {
			closure: true,
			dryRun: true,
			client: {
				negotiate: unexpectedNegotiateCall,
				preview(body) {
					previews.push(body);

					return Promise.resolve(
						uploadPreviewResponseSchema.parse({
							uploads: [
								{
									action: 'upload',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString()
								},
								{
									action: 'skip',
									storePathHash: StorePath.hash(runtimePath),
									narHash: runtimeDigest.narHash.toString()
								}
							]
						})
					);
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

		expect({ clientCalls, previews, results }).toStrictEqual({
			clientCalls: [],
			previews: [
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
			],
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

		await runPush(publication([appPath]), reporter(results, warnings), {
			wait: false,
			client: {
				preview: unexpectedPreviewCall,
				negotiate(body) {
					clientCalls.push({
						method: 'negotiate',
						paths: body.paths.map((path) => path.storePath)
					});

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
				},
				async uploadNar(_r2Key, body) {
					clientCalls.push({ method: 'uploadNar' });
					await collectReadableStream(body);
				},
				commit() {
					clientCalls.push({ method: 'commit' });

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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

		await runPush(publication([appPath]), reporter(results), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate(body) {
					clientCalls.push({
						method: 'negotiate',
						paths: body.paths.map((path) => path.storePath)
					});

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
							uploads: [
								{
									action: 'commit',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									uploadId: 'reuse-app'
								}
							]
						})
					);
				},
				uploadNar() {
					clientCalls.push({ method: 'uploadNar' });

					return Promise.resolve();
				},
				commit(target) {
					clientCalls.push({ method: 'commit', uploadId: target.uploadId });

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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

		await runPush(publication([appPath]), reporter(results), {
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

		await runPush(publication([appPath]), reporter([]), {
			client: {
				preview: unexpectedPreviewCall,
				...deferredUpload([]),
				commit() {
					return Promise.resolve({
						storePathHash: appHash,
						narHash: appDigest.narHash.value,
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

		await runPush(publication([appPath]), reporter(results), {
			closure: true,
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

		await runPush(publication([appPath]), reporter(results), {
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
				await runPush(publication([appPath]), reporter([]), {
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

		await runPush(publication([appPath]), reporter(results, warnings), {
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
				await runPush(publication([appPath]), reporter([]), {
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

		await runPush(publication([appPath]), reporter([]), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate: () =>
					Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					),
				uploadNar: async (_r2Key, body) => {
					await collectReadableStream(body);
				},
				commit: () =>
					Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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
				preview: unexpectedPreviewCall,
				negotiate(body) {
					clientCalls.push({
						method: 'negotiate',
						paths: body.paths.map((path) => path.storePath)
					});

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
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
				await runPush(publication([appPath]), reporter([], warnings), options);
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

		await runPush(publication([appPath]), reporter(results), {
			client: skipClient(roots, clientCalls),
			root: rootName('main'),
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

	it('resolves metadata for exactly the publication entries by default', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const nixCalls: NixCall[] = [];

		await runPush(publication([appPath]), reporter([]), {
			client: skipClient(roots, clientCalls),
			root: rootName('main'),
			nix: nixStore(
				{
					[appPath]: pathInfo(appPath, appDigest, [runtimePath]),
					[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
				},
				nixCalls
			)
		});

		expect({ nixCalls, clientCalls, roots }).toStrictEqual({
			nixCalls: [{ method: 'queryValidPathsInfo', paths: [appPath] }],
			clientCalls: [
				{ method: 'negotiate', paths: [appPath] },
				{ method: 'setRoot', fields: { name: 'main', targets: [appPath] } }
			],
			roots: [{ fields: { name: 'main', targets: [appPath] } }]
		});
	});

	it('publishes the complete realised closure with --closure', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const nixCalls: NixCall[] = [];

		await runPush(publication([appPath]), reporter([]), {
			closure: true,
			client: skipClient(roots, clientCalls),
			root: rootName('main'),
			nix: nixStore(
				{
					[appPath]: pathInfo(appPath, appDigest, [runtimePath]),
					[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
				},
				nixCalls
			)
		});

		expect({ nixCalls, clientCalls, roots }).toStrictEqual({
			nixCalls: [{ method: 'resolveClosure', paths: [appPath] }],
			clientCalls: [
				{ method: 'negotiate', paths: [appPath, runtimePath] },
				{ method: 'setRoot', fields: { name: 'main', targets: [appPath] } }
			],
			roots: [{ fields: { name: 'main', targets: [appPath] } }]
		});
	});

	it('publishes declared intermediates without naming them in the root', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush(publication([appPath], [runtimePath]), reporter(results), {
			client: skipClient(roots, clientCalls),
			root: rootName('main'),
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			})
		});

		expect({ clientCalls, roots, results }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath, runtimePath] },
				{ method: 'setRoot', fields: { name: 'main', targets: [appPath] } }
			],
			roots: [{ fields: { name: 'main', targets: [appPath] } }],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '2' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Root', value: 'main' },
					{ label: 'Root expiry', value: 'permanent' }
				]
			]
		});
	});

	it('pins only the declared targets when no root is given', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];

		await runPush(publication([appPath], [runtimePath]), reporter([]), {
			client: skipClient(roots, clientCalls),
			nix: nixStore({
				[appPath]: pathInfo(appPath, appDigest, []),
				[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
			})
		});

		expect({ clientCalls, roots }).toStrictEqual({
			clientCalls: [
				{ method: 'negotiate', paths: [appPath, runtimePath] },
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
					fields: { name: `pin:${StorePath.hash(appPath)}`, targets: [appPath] }
				}
			]
		});
	});

	it('publishes a reference entry commit-only, without the store or a NAR read', async () => {
		const nixCalls: NixCall[] = [];
		const roots: SetRootCall[] = [];
		const negotiations: Omit<UploadNegotiateRequest, 'pushId'>[] = [];
		const commits: string[] = [];
		const fetched: string[] = [];
		let narReads = 0;

		await runPush(
			PublicationCollection.of({ targets: [], referencePaths: [appPath] }),
			reporter([]),
			{
				referenceSource: {
					url: new URL('https://cache.example.workers.dev/t/acme')
				},
				fetchReferenceMetadata: (source, storePathHash) => {
					fetched.push(`${source.url.href} ${storePathHash}`);

					return Promise.resolve(referenceMetadata());
				},
				client: {
					preview: unexpectedPreviewCall,
					negotiate(body) {
						negotiations.push(body);

						return Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: [
									{
										action: 'commit',
										storePathHash: StorePath.hash(appPath),
										narHash: appDigest.narHash.toString(),
										uploadId: 'reuse-app'
									}
								]
							})
						);
					},
					uploadNar: unexpectedUploadNarCall,
					commit(target) {
						commits.push(target.uploadId);

						return Promise.resolve(fallbackCommitResponse());
					},
					setRoot(name, body) {
						roots.push({ fields: { name, ...body } });

						return Promise.resolve(rootSummary({ name, ...body }));
					}
				} satisfies PushClient,
				createNarArchive: () => {
					narReads += 1;

					return new FakeNarArchive(appDigest);
				},
				nix: nixStore({}, nixCalls)
			}
		);

		expect({
			nixCalls,
			fetched,
			negotiations,
			commits,
			narReads,
			roots
		}).toStrictEqual({
			nixCalls: [],
			fetched: [
				`https://cache.example.workers.dev/t/acme ${StorePath.hash(appPath)}`
			],
			negotiations: [
				{
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							narHash: appDigest.narHash.toString(),
							narSize: 123,
							references: []
						}
					]
				}
			],
			commits: ['reuse-app'],
			narReads: 0,
			roots: [
				{
					fields: { name: `pin:${StorePath.hash(appPath)}`, targets: [appPath] }
				}
			]
		});
	});

	it('reports an upload demanded for a reference entry as a typed per-path failure', async () => {
		const payloads: ResultPayload[] = [];
		const uploadDemand = new ReferenceUploadRequiredError(appPath);
		let narReads = 0;

		let error: unknown;
		try {
			await runPush(
				PublicationCollection.of({ targets: [], referencePaths: [appPath] }),
				reporter([], [], payloads),
				{
					referenceSource: {
						url: new URL('https://cache.example.workers.dev/t/acme')
					},
					fetchReferenceMetadata: () => Promise.resolve(referenceMetadata()),
					client: {
						preview: unexpectedPreviewCall,
						negotiate: () =>
							Promise.resolve(
								uploadNegotiateResponseSchema.parse({
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
								})
							),
						uploadNar: unexpectedUploadNarCall,
						commit: unexpectedCommitCall,
						setRoot: unexpectedSetRootCall
					} satisfies PushClient,
					createNarArchive: () => {
						narReads += 1;

						return new FakeNarArchive(appDigest);
					},
					nix: nixStore({})
				}
			);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(PushIncompleteError);

		const summary = payloads.find(
			(payload) => payload.kind === pushSummaryResultKind
		);

		expect({ narReads, data: summary?.data }).toStrictEqual({
			narReads: 0,
			data: {
				uploadedPaths: 1,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 0,
				failures: [
					{
						storePathHash: StorePath.hash(appPath),
						storePath: appPath,
						stage: 'upload',
						reason: uploadDemand.message
					}
				],
				paths: []
			}
		});
	});

	it.each([
		{
			name: 'records an intermediate vanished at resolution as collected',
			input: { targets: [appPath], intermediatePaths: [runtimePath] },
			expected: {
				errorClass: undefined,
				clientCalls: [
					{ method: 'negotiate', paths: [appPath] },
					{ method: 'setRoot', fields: { name: 'main', targets: [appPath] } }
				],
				data: {
					uploadedPaths: 0,
					reusedBlobs: 0,
					skipped: 1,
					uploadedBytes: 0,
					failures: [],
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							outcome: 'already-present'
						},
						{
							storePathHash: StorePath.hash(runtimePath),
							storePath: runtimePath,
							outcome: 'collected'
						}
					]
				}
			}
		},
		{
			name: 'fails the run for a target vanished at resolution',
			input: { targets: [appPath, runtimePath] },
			expected: {
				errorClass: PushIncompleteError,
				clientCalls: [{ method: 'negotiate', paths: [appPath] }],
				data: {
					uploadedPaths: 0,
					reusedBlobs: 0,
					skipped: 1,
					uploadedBytes: 0,
					failures: [
						{
							storePathHash: StorePath.hash(runtimePath),
							storePath: runtimePath,
							stage: 'resolve',
							reason: new NixStorePathNotFoundError(runtimePath).message
						}
					],
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							outcome: 'already-present'
						}
					]
				}
			}
		}
	])('$name', async ({ input, expected }) => {
		const clientCalls: unknown[] = [];
		const payloads: ResultPayload[] = [];

		let error: unknown;
		try {
			await runPush(
				PublicationCollection.of(input),
				reporter([], [], payloads),
				{
					client: skipClient([], clientCalls),
					root: rootName('main'),
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
				}
			);
		} catch (error_: unknown) {
			error = error_;
		}

		const summary = payloads.find(
			(payload) => payload.kind === pushSummaryResultKind
		);

		expect({
			errorClass: error?.constructor,
			clientCalls,
			data: summary?.data
		}).toStrictEqual({
			errorClass: expected.errorClass,
			clientCalls: expected.clientCalls,
			data: expected.data
		});
	});

	it.each([
		{
			name: 'records an intermediate vanished at its NAR read as collected',
			input: { targets: [appPath], intermediatePaths: [runtimePath] },
			expected: {
				errorClass: undefined,
				roots: [{ fields: { name: 'main', targets: [appPath] } }],
				data: {
					uploadedPaths: 0,
					reusedBlobs: 0,
					skipped: 1,
					uploadedBytes: 0,
					failures: [],
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							outcome: 'already-present'
						},
						{
							storePathHash: StorePath.hash(runtimePath),
							storePath: runtimePath,
							outcome: 'collected'
						}
					]
				}
			}
		},
		{
			name: 'fails the run for a target vanished at its NAR read',
			input: { targets: [appPath, runtimePath] },
			expected: {
				errorClass: PushIncompleteError,
				roots: [],
				data: {
					uploadedPaths: 1,
					reusedBlobs: 0,
					skipped: 1,
					uploadedBytes: 0,
					failures: [
						{
							storePathHash: StorePath.hash(runtimePath),
							storePath: runtimePath,
							stage: 'upload',
							reason: new NixStorePathNotFoundError(runtimePath).message
						}
					],
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							outcome: 'already-present'
						}
					]
				}
			}
		}
	])('$name', async ({ input, expected }) => {
		const roots: SetRootCall[] = [];
		const payloads: ResultPayload[] = [];
		const vanished = new NixStorePathNotFoundError(runtimePath);

		let error: unknown;
		try {
			await runPush(
				PublicationCollection.of(input),
				reporter([], [], payloads),
				{
					client: {
						preview: unexpectedPreviewCall,
						negotiate: (body) =>
							Promise.resolve(
								uploadNegotiateResponseSchema.parse({
									uploads: body.paths.map((path) =>
										path.storePath === runtimePath
											? {
													action: 'upload',
													storePathHash: path.storePathHash,
													narHash: path.narHash,
													uploadId: 'upload-runtime',
													r2Key: `nar/${runtimeDigest.narHash.toString()}.nar.zst`,
													expiresAt: '2026-05-18T12:00:00.000Z'
												}
											: {
													action: 'skip',
													storePathHash: path.storePathHash,
													narHash: path.narHash
												}
									)
								})
							),
						uploadNar: unexpectedUploadNarCall,
						commit: unexpectedCommitCall,
						setRoot(name, body) {
							roots.push({ fields: { name, ...body } });

							return Promise.resolve(rootSummary({ name, ...body }));
						}
					} satisfies PushClient,
					root: rootName('main'),
					createNarArchive: (storePath) => {
						if (storePath === runtimePath) {
							throw vanished;
						}

						return new FakeNarArchive(appDigest);
					},
					compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar)),
					nix: nixStore({
						[appPath]: pathInfo(appPath, appDigest, []),
						[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
					})
				}
			);
		} catch (error_: unknown) {
			error = error_;
		}

		const summary = payloads.find(
			(payload) => payload.kind === pushSummaryResultKind
		);

		expect({
			errorClass: error?.constructor,
			roots,
			data: summary?.data
		}).toStrictEqual({
			errorClass: expected.errorClass,
			roots: expected.roots,
			data: expected.data
		});
	});

	it('streams NAR bytes through an ssh-ng store client, never the filesystem reader', async () => {
		const narReads: string[] = [];
		const fsReads: string[] = [];
		const uploads: { readonly r2Key: string; readonly body: Uint8Array }[] = [];
		const commits: string[] = [];
		const r2Key = `nar/${appDigest.narHash.toString()}.nar.zst`;

		await runPush(publication([appPath]), reporter([]), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate: (body) =>
					Promise.resolve(
						uploadNegotiateResponseSchema.parse({
							uploads: body.paths.map((path) => ({
								action: 'upload',
								storePathHash: path.storePathHash,
								narHash: path.narHash,
								uploadId: 'upload-app',
								r2Key,
								expiresAt: '2026-05-18T12:00:00.000Z'
							}))
						})
					),
				async uploadNar(key, body) {
					uploads.push({ r2Key: key, body: await collectReadableStream(body) });
				},
				commit(target) {
					commits.push(target.uploadId);

					return Promise.resolve(fallbackCommitResponse());
				},
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			root: rootName('main'),
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }, [], {
				storeKind: 'ssh-ng',
				narFromPath: (storePath) => {
					narReads.push(storePath);

					return narBytes(appDigest);
				}
			}),
			createNarArchive: (storePath) => {
				fsReads.push(storePath);

				return new FakeNarArchive(appDigest);
			},
			compressNar: (nar) => fakeNarUpload(nar, appDigest)
		});

		expect({
			narReads,
			fsReads,
			commits,
			uploads: uploads.map((upload) => ({
				r2Key: upload.r2Key,
				body: Buffer.from(upload.body).toString()
			}))
		}).toStrictEqual({
			narReads: [appPath],
			fsReads: [],
			commits: ['upload-app'],
			uploads: [{ r2Key, body: compressedNarBytes.toString() }]
		});
	});

	it.each(['local-filesystem', 'daemon'] as const)(
		'reads NAR bytes from the filesystem for a %s store',
		async (storeKind) => {
			const narReads: string[] = [];
			const fsReads: string[] = [];
			const commits: string[] = [];

			await runPush(publication([appPath]), reporter([]), {
				client: {
					preview: unexpectedPreviewCall,
					negotiate: (body) =>
						Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: body.paths.map((path) => ({
									action: 'upload',
									storePathHash: path.storePathHash,
									narHash: path.narHash,
									uploadId: 'upload-app',
									r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
									expiresAt: '2026-05-18T12:00:00.000Z'
								}))
							})
						),
					uploadNar: () => Promise.resolve(),
					commit(target) {
						commits.push(target.uploadId);

						return Promise.resolve(fallbackCommitResponse());
					},
					setRoot: (name, body) =>
						Promise.resolve(rootSummary({ name, ...body }))
				} satisfies PushClient,
				root: rootName('main'),
				nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }, [], {
					storeKind,
					narFromPath: (storePath) => {
						narReads.push(storePath);

						return narBytes(appDigest);
					}
				}),
				createNarArchive: (storePath) => {
					fsReads.push(storePath);

					return new FakeNarArchive(appDigest);
				},
				compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
			});

			expect({ narReads, fsReads, commits }).toStrictEqual({
				narReads: [],
				fsReads: [appPath],
				commits: ['upload-app']
			});
		}
	);

	it('still verifies streamed NAR metadata for an ssh-ng store', async () => {
		const payloads: ResultPayload[] = [];
		const mismatch = new PushNarMetadataMismatchError(
			appPath,
			appDigest.narHash.toString(),
			runtimeDigest.narHash.toString(),
			appDigest.narSize,
			runtimeDigest.narSize
		);

		let error: unknown;
		try {
			await runPush(publication([appPath]), reporter([], [], payloads), {
				client: {
					preview: unexpectedPreviewCall,
					negotiate: (body) =>
						Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: body.paths.map((path) => ({
									action: 'upload',
									storePathHash: path.storePathHash,
									narHash: path.narHash,
									uploadId: 'upload-app',
									r2Key: `nar/${appDigest.narHash.toString()}.nar.zst`,
									expiresAt: '2026-05-18T12:00:00.000Z'
								}))
							})
						),
					uploadNar: () => Promise.resolve(),
					commit: unexpectedCommitCall,
					setRoot: unexpectedSetRootCall
				} satisfies PushClient,
				root: rootName('main'),
				nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }, [], {
					storeKind: 'ssh-ng',
					narFromPath: () => narBytes(appDigest)
				}),
				// The streamed bytes digest to the runtime NAR, so verification
				// must refuse the upload.
				compressNar: (nar) => fakeNarUpload(nar, runtimeDigest)
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(PushIncompleteError);

		const summary = payloads.find(
			(payload) => payload.kind === pushSummaryResultKind
		);

		expect(summary?.data).toStrictEqual({
			uploadedPaths: 1,
			reusedBlobs: 0,
			skipped: 0,
			uploadedBytes: 0,
			failures: [
				{
					storePathHash: StorePath.hash(appPath),
					storePath: appPath,
					stage: 'upload',
					reason: mismatch.message
				}
			],
			paths: []
		});
	});

	it('sets an expiring channel with --root and --ttl', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush(publication([appPath]), reporter(results), {
			client: skipClient(roots, clientCalls),
			root: rootName('main'),
			ttlSeconds: ttlSecondsSchema.parse(1_209_600),
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
						value: 'expires 2026-01-15 00:00 UTC'
					}
				]
			]
		});
	});

	it('pins each pushed path when no root is given', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];

		await runPush(publication([appPath, runtimePath]), reporter(results), {
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

		await runPush(publication([appPath]), reporter(results), {
			client: skipClient(roots, clientCalls),
			ttlSeconds: ttlSecondsSchema.parse(604_800),
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
					{ label: 'Pin expiry', value: 'expires 2026-01-15 00:00 UTC' }
				]
			]
		});
	});

	it('with --no-retain, records no root or pin and reports the unretained row', async () => {
		const roots: SetRootCall[] = [];
		const clientCalls: unknown[] = [];
		const results: ResultRow[][] = [];
		const warns: { label: string; value?: string }[] = [];

		await runPush(publication([appPath]), reporter(results, warns), {
			client: skipClient(roots, clientCalls),
			retain: false,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		// An unretained push renders its per-path grace rows even when nothing
		// matched, and warns: grace is the only thing that would keep the paths.
		expect({ clientCalls, roots, results, warns }).toStrictEqual({
			clientCalls: [{ method: 'negotiate', paths: [appPath] }],
			roots: [],
			results: [
				[
					{ label: 'Uploaded paths', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '0 B' },
					{ label: 'Retention', value: 'none (--no-retain)' },
					{
						label: StorePath.hash(appPath),
						value: 'no retention grace policy matched'
					}
				]
			],
			warns: [
				{
					label: 'unretained',
					value:
						'no retention grace policy matched these paths; nothing retains them and the next collection can remove them'
				}
			]
		});
	});

	it('caps the per-path rows for a closure larger than the row limit', async () => {
		const storePaths = Array.from({ length: 22 }, (_, index) =>
			storePathSchema.parse(
				`/nix/store/${String(index).padStart(32, '0')}-path-${String(index)}`
			)
		);
		const results: ResultRow[][] = [];
		const store = nixStore(
			Object.fromEntries(
				storePaths.map((storePath) => [
					storePath,
					pathInfo(storePath, appDigest, [])
				])
			)
		);

		await runPush(publication(storePaths), reporter(results, []), {
			client: skipClient([], []),
			retain: false,
			nix: store
		});

		expect(results).toStrictEqual([
			[
				{ label: 'Uploaded paths', value: '0' },
				{ label: 'Already cached', value: '0' },
				{ label: 'Skipped', value: '22' },
				{ label: 'Bytes uploaded', value: '0 B' },
				{ label: 'Retention', value: 'none (--no-retain)' },
				...storePaths.slice(0, 20).map((storePath) => ({
					label: StorePath.hash(storePath),
					value: 'no retention grace policy matched'
				})),
				{
					label: '…',
					value: '2 more path(s); the full list is in the JSON output'
				}
			]
		]);
	});

	it.each([
		{ name: 'a named root', options: { root: rootName('main') } },
		{ name: 'implicit pins', options: {} },
		{
			name: '--no-retain',
			options: { retain: false }
		}
	])(
		'keeps the retention choice out of the negotiate body for $name',
		async ({ options }) => {
			const bodies: Omit<UploadNegotiateRequest, 'pushId'>[] = [];

			await runPush(publication([appPath]), reporter([]), {
				...options,
				client: {
					...skipClient([], []),
					negotiate(body) {
						bodies.push(body);

						return Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: body.paths.map((path) => ({
									action: 'skip',
									storePathHash: path.storePathHash,
									narHash: path.narHash
								}))
							})
						);
					}
				},
				nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
			});

			expect(bodies).toStrictEqual([
				{
					paths: [prepareStorePathNegotiation(pathInfo(appPath, appDigest, []))]
				}
			]);
		}
	);

	it('with --no-retain --dry-run, reports the unretained row without a plan RPC', async () => {
		const results: ResultRow[][] = [];
		const previews: UploadPreviewRequest[] = [];

		await runPush(publication([appPath]), reporter(results), {
			dryRun: true,
			retain: false,
			client: {
				negotiate: unexpectedNegotiateCall,
				preview(body) {
					previews.push(body);

					return Promise.resolve(
						uploadPreviewResponseSchema.parse({
							uploads: [
								{
									action: 'skip',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString()
								}
							]
						})
					);
				},
				uploadNar: unexpectedUploadNarCall,
				commit: unexpectedCommitCall,
				setRoot: unexpectedSetRootCall
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ previews, results }).toStrictEqual({
			previews: [
				{
					paths: [
						{
							storePathHash: StorePath.hash(appPath),
							storePath: appPath,
							narHash: appDigest.narHash.toString(),
							narSize: 123,
							references: [],
							deriver: undefined,
							ca: undefined
						}
					]
				}
			],
			results: [
				[
					{ label: 'Would upload', value: '0' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Retention', value: 'none (--no-retain)' },
					{
						label: StorePath.hash(appPath),
						value: 'no retention grace policy matched'
					}
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

			await runPush(publication([appPath]), reporter(results), {
				...(wait !== undefined && { wait }),
				retain: false,
				client: {
					preview: unexpectedPreviewCall,
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
						{ label: 'Retention', value: 'none (--no-retain)' },
						{
							label: StorePath.hash(appPath),
							value: 'no retention grace policy matched'
						}
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

		await runPush(publication([appPath]), reporter([]), dependencies);
		await runPush(publication([appPath]), reporter([]), dependencies);

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

		await runPush(publication([appPath]), reporter([]), {
			client: {
				preview: unexpectedPreviewCall,
				negotiate() {
					events.push('negotiate');

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					);
				},
				async uploadNar(_r2Key, body) {
					events.push('uploadNar');
					await collectReadableStream(body);
				},
				commit() {
					events.push('commit');

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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
		const expiries = ['2026-01-15T00:00:00.000Z', '2026-01-16T00:00:00.000Z'];
		let call = 0;
		const results: ResultRow[][] = [];
		const clientCalls: unknown[] = [];

		const client: PushClient = {
			preview: unexpectedPreviewCall,
			negotiate(body) {
				clientCalls.push({
					method: 'negotiate',
					paths: body.paths.map((path) => path.storePath)
				});

				return Promise.resolve(
					uploadNegotiateResponseSchema.parse({
						uploads: body.paths.map((path) => ({
							action: 'skip',
							storePathHash: path.storePathHash,
							narHash: path.narHash
						}))
					})
				);
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

		await runPush(publication([appPath, runtimePath]), reporter(results), {
			client,
			ttlSeconds: ttlSecondsSchema.parse(604_800),
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
						value: 'expires 2026-01-15 00:00 UTC to 2026-01-16 00:00 UTC'
					}
				]
			]
		});
	});

	it('parks the commit for a deferred upload, then records retention', async () => {
		const events: string[] = [];
		const commitOptions: CommitOptions[] = [];

		await runPush(publication([appPath]), reporter([]), {
			wait: true,
			waitTimeoutSeconds: waitTimeoutSecondsSchema.parse(30),
			client: {
				preview: unexpectedPreviewCall,
				...deferredUpload(events),
				commit(_uploadId, options) {
					events.push('commit');
					commitOptions.push(options);

					// The client parks on the commit socket and settles once the
					// verification verdict arrives.
					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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
				preview: unexpectedPreviewCall,
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
				await runPush(publication([appPath]), reporter([], warnings), options);
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
				preview: unexpectedPreviewCall,
				...deferredUpload(events),
				commit() {
					events.push('commit');

					return Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
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
				await runPush(publication([appPath]), reporter([], warnings), options);
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
				preview: unexpectedPreviewCall,
				negotiate: () =>
					Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					),
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
						narHash: appDigest.narHash.value,
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
				await runPush(
					publication([appPath, runtimePath]),
					reporter([]),
					options
				);
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

	it('reports a kept-until fact and an unmatched path together, in rows and JSON data', async () => {
		const results: ResultRow[][] = [];
		const payloads: ResultPayload[] = [];

		await runPush(
			publication([appPath, runtimePath]),
			reporter(results, [], payloads),
			{
				client: {
					preview: unexpectedPreviewCall,
					negotiate: (body) =>
						Promise.resolve(
							uploadNegotiateResponseSchema.parse({
								uploads: body.paths.map((path) =>
									path.storePathHash === StorePath.hash(appPath)
										? {
												action: 'skip',
												storePathHash: path.storePathHash,
												narHash: path.narHash,
												grace: { retainUntil: '2026-02-01T00:00:00.000Z' }
											}
										: {
												action: 'upload',
												storePathHash: path.storePathHash,
												narHash: path.narHash,
												uploadId: `upload-${path.storePathHash}`,
												r2Key: `nar/${path.narHash}.nar.zst`,
												expiresAt: '2026-05-18T12:00:00.000Z'
											}
								)
							})
						),
					async uploadNar(_r2Key, body) {
						await collectReadableStream(body);
					},
					commit: () =>
						Promise.resolve({
							storePathHash: StorePath.hash(runtimePath),
							narHash: runtimeDigest.narHash.value,
							status: 'committed',
							settled: Promise.resolve()
						}),
					setRoot: (name, body) =>
						Promise.resolve(rootSummary({ name, ...body }))
				} satisfies PushClient,
				nix: nixStore({
					[appPath]: pathInfo(appPath, appDigest, []),
					[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
				}),
				createNarArchive: () => new FakeNarArchive(runtimeDigest),
				compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
			}
		);

		const appHash = StorePath.hash(appPath);
		const runtimeHash = StorePath.hash(runtimePath);

		expect({ results, data: payloads.at(-1)?.data }).toStrictEqual({
			results: [
				[
					{ label: 'Uploaded paths', value: '1' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '1' },
					{ label: 'Bytes uploaded', value: '14 B' },
					{ label: 'Pinned paths', value: '2' },
					{ label: 'Pin expiry', value: 'permanent' },
					{ label: appHash, value: 'kept until 2026-02-01 00:00 UTC' },
					{ label: runtimeHash, value: 'no retention grace policy matched' }
				]
			],
			data: {
				uploadedPaths: 1,
				reusedBlobs: 0,
				skipped: 1,
				uploadedBytes: 14,
				failures: [],
				paths: [
					{
						storePathHash: appHash,
						storePath: appPath,
						outcome: 'already-present',
						grace: { retainUntil: '2026-02-01T00:00:00.000Z' }
					},
					{
						storePathHash: runtimeHash,
						storePath: runtimePath,
						outcome: 'committed'
					}
				]
			}
		});
	});

	it('reports a pending grace fact when --no-wait leaves a deferred upload unresolved', async () => {
		const results: ResultRow[][] = [];
		const payloads: ResultPayload[] = [];

		await runPush(publication([appPath]), reporter(results, [], payloads), {
			wait: false,
			client: {
				preview: unexpectedPreviewCall,
				negotiate: () =>
					Promise.resolve(
						uploadNegotiateResponseSchema.parse({
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
						})
					),
				async uploadNar(_r2Key, body) {
					await collectReadableStream(body);
				},
				commit: () =>
					Promise.resolve({
						storePathHash: StorePath.hash(appPath),
						narHash: appDigest.narHash.value,
						status: 'pending',
						settled: Promise.resolve(),
						grace: { graceSeconds: graceSecondsSchema.parse(900) }
					}),
				setRoot: (name, body) => Promise.resolve(rootSummary({ name, ...body }))
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) }),
			createNarArchive: () => new FakeNarArchive(appDigest),
			compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar))
		});

		const appHash = StorePath.hash(appPath);

		expect({ results, data: payloads.at(-1)?.data }).toStrictEqual({
			results: [
				[
					{ label: 'Uploaded paths', value: '1' },
					{ label: 'Already cached', value: '0' },
					{ label: 'Skipped', value: '0' },
					{ label: 'Bytes uploaded', value: '14 B' },
					{ label: 'Pinned paths', value: '1' },
					{ label: 'Pin expiry', value: 'permanent' },
					{ label: appHash, value: 'pending (grace 900s)' }
				]
			],
			data: {
				uploadedPaths: 1,
				reusedBlobs: 0,
				skipped: 0,
				uploadedBytes: 14,
				failures: [],
				paths: [
					{
						storePathHash: appHash,
						storePath: appPath,
						outcome: 'pending',
						grace: { graceSeconds: 900 }
					}
				]
			}
		});
	});

	it('falls back to legacy reporting for a retained push when the server does not acknowledge grace facts', async () => {
		const probes: string[] = [];
		const bodies: UploadNegotiateRequest[] = [];
		const commitTargets: CommitTarget[] = [];

		await runPush(publication([appPath]), reporter([]), {
			client: {
				...skipClient([], []),
				probeUploadGraceFacts(kind) {
					probes.push(kind);

					return Promise.resolve(false);
				},
				hasUploadGraceFacts: () => false,
				negotiate(body) {
					bodies.push({ pushId: 'push-1', ...body });

					return Promise.resolve(
						uploadNegotiateResponseSchema.parse({
							uploads: [
								{
									action: 'commit',
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									uploadId: 'reuse-app'
								}
							]
						})
					);
				},
				commit(target) {
					commitTargets.push(target);

					return Promise.resolve(fallbackCommitResponse());
				}
			},
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ probes, bodies, commitTargets }).toStrictEqual({
			probes: [],
			bodies: [
				{
					pushId: 'push-1',
					paths: [prepareStorePathNegotiation(pathInfo(appPath, appDigest, []))]
				}
			],
			commitTargets: [
				{
					uploadId: 'reuse-app',
					storePathHash: StorePath.hash(appPath),
					narHash: appDigest.narHash.toString()
				}
			]
		});
	});

	it('refuses an unretained push before negotiating real paths when grace facts are unsupported', async () => {
		const probes: string[] = [];

		const pushed = runPush(publication([appPath]), reporter([]), {
			retain: false,
			client: {
				...skipClient([], []),
				probeUploadGraceFacts(kind) {
					probes.push(kind);

					return Promise.resolve(false);
				},
				negotiate: unexpectedNegotiateCall
			},
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		await expect(pushed).rejects.toBeInstanceOf(
			UploadGraceFactsUnsupportedError
		);

		expect(probes).toStrictEqual(['negotiate']);
	});

	it('refuses an unretained dry run before previewing real paths when grace facts are unsupported', async () => {
		const probes: string[] = [];

		const previewed = runPush(publication([appPath]), reporter([]), {
			dryRun: true,
			retain: false,
			client: {
				...skipClient([], []),
				probeUploadGraceFacts(kind) {
					probes.push(kind);

					return Promise.resolve(false);
				},
				preview: unexpectedPreviewCall
			},
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		await expect(previewed).rejects.toBeInstanceOf(
			UploadGraceFactsUnsupportedError
		);

		expect(probes).toStrictEqual(['preview']);
	});

	// A contract-defined NOT_FOUND is the preview procedure itself refusing,
	// not a missing route, so it is no evidence the server predates preview.
	it('surfaces a contract-defined preview NOT_FOUND unchanged', async () => {
		const outcome = await (async () => {
			try {
				await runPush(publication([appPath]), reporter([]), {
					dryRun: true,
					client: {
						negotiate: unexpectedNegotiateCall,
						preview: () =>
							Promise.reject(new ORPCError('NOT_FOUND', { defined: true })),
						uploadNar: unexpectedUploadNarCall,
						commit: unexpectedCommitCall,
						setRoot: unexpectedSetRootCall
					} satisfies PushClient,
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
				});

				return { pushed: true };
			} catch (error_: unknown) {
				return {
					isOrpcError: error_ instanceof ORPCError,
					isWrapped: error_ instanceof UploadGraceFactsUnsupportedError
				};
			}
		})();

		expect(outcome).toStrictEqual({ isOrpcError: true, isWrapped: false });
	});

	it('wraps a 404 from preview as UploadGraceFactsUnsupportedError when the empty-closure probe 404s too', async () => {
		const previewBodies: UploadPreviewRequest[] = [];

		const outcome = await (async () => {
			try {
				await runPush(publication([appPath]), reporter([]), {
					dryRun: true,
					client: {
						negotiate: unexpectedNegotiateCall,
						preview(body) {
							previewBodies.push(body);

							return Promise.reject(new ORPCError('NOT_FOUND'));
						},
						uploadNar: unexpectedUploadNarCall,
						commit: unexpectedCommitCall,
						setRoot: unexpectedSetRootCall
					} satisfies PushClient,
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
				});

				return { pushed: true };
			} catch (error_: unknown) {
				const error = z
					.instanceof(UploadGraceFactsUnsupportedError)
					.parse(error_);

				return {
					error: {
						name: error.name,
						causeIsOrpcError: error.cause instanceof ORPCError
					}
				};
			}
		})();

		expect({
			outcome,
			probePaths: previewBodies.map((body) => body.paths.length)
		}).toStrictEqual({
			outcome: {
				error: {
					name: UploadGraceFactsUnsupportedError.name,
					causeIsOrpcError: true
				}
			},
			probePaths: [1, 0]
		});
	});

	it('propagates the original preview 404 when the empty-closure probe answers', async () => {
		const previewBodies: UploadPreviewRequest[] = [];

		const outcome = await (async () => {
			try {
				await runPush(publication([appPath]), reporter([]), {
					dryRun: true,
					client: {
						negotiate: unexpectedNegotiateCall,
						preview(body) {
							previewBodies.push(body);

							if (body.paths.length === 0) {
								return Promise.resolve({ uploads: [] });
							}

							return Promise.reject(new ORPCError('NOT_FOUND'));
						},
						uploadNar: unexpectedUploadNarCall,
						commit: unexpectedCommitCall,
						setRoot: unexpectedSetRootCall
					} satisfies PushClient,
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
				});

				return { pushed: true };
			} catch (error_: unknown) {
				return {
					isOrpcError: error_ instanceof ORPCError,
					isWrapped: error_ instanceof UploadGraceFactsUnsupportedError
				};
			}
		})();

		expect({
			outcome,
			probePaths: previewBodies.map((body) => body.paths.length)
		}).toStrictEqual({
			outcome: { isOrpcError: true, isWrapped: false },
			probePaths: [1, 0]
		});
	});

	// An unknown tenant answers a routing-level 404 on every route, preview
	// and its empty-closure probe alike, so the too-old diagnosis only stands
	// once the tenant proves it answers at all.
	it.each([
		['does not answer', (): Promise<boolean> => Promise.resolve(false)],
		['probe fails', (): Promise<boolean> => Promise.reject(new Error('down'))]
	])(
		'propagates the original preview 404 when the tenant %s',
		async (_case, tenantServes) => {
			const outcome = await (async () => {
				try {
					await runPush(publication([appPath]), reporter([]), {
						dryRun: true,
						client: {
							negotiate: unexpectedNegotiateCall,
							preview: () => Promise.reject(new ORPCError('NOT_FOUND')),
							tenantServes,
							uploadNar: unexpectedUploadNarCall,
							commit: unexpectedCommitCall,
							setRoot: unexpectedSetRootCall
						} satisfies PushClient,
						nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
					});

					return { pushed: true };
				} catch (error_: unknown) {
					return {
						isOrpcError: error_ instanceof ORPCError,
						isWrapped: error_ instanceof UploadGraceFactsUnsupportedError
					};
				}
			})();

			expect(outcome).toStrictEqual({ isOrpcError: true, isWrapped: false });
		}
	);

	it('diagnoses server-too-old when the tenant answers but preview is missing', async () => {
		const outcome = await (async () => {
			try {
				await runPush(publication([appPath]), reporter([]), {
					dryRun: true,
					client: {
						negotiate: unexpectedNegotiateCall,
						preview: () => Promise.reject(new ORPCError('NOT_FOUND')),
						tenantServes: () => Promise.resolve(true),
						uploadNar: unexpectedUploadNarCall,
						commit: unexpectedCommitCall,
						setRoot: unexpectedSetRootCall
					} satisfies PushClient,
					nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
				});

				return { pushed: true };
			} catch (error_: unknown) {
				return {
					isWrapped: error_ instanceof UploadGraceFactsUnsupportedError
				};
			}
		})();

		expect(outcome).toStrictEqual({ isWrapped: true });
	});

	it('with --dry-run --no-retain, reports the policy a skip would extend without the unretained warning', async () => {
		const results: ResultRow[][] = [];
		const warns: { label: string; value?: string }[] = [];

		await runPush(publication([appPath]), reporter(results, warns), {
			dryRun: true,
			retain: false,
			client: {
				negotiate: unexpectedNegotiateCall,
				preview: () =>
					Promise.resolve(
						uploadPreviewResponseSchema.parse({
							uploads: [
								{
									action: 'skip' as const,
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									grace: { graceSeconds: 86_400 }
								}
							]
						})
					),
				uploadNar: unexpectedUploadNarCall,
				commit: unexpectedCommitCall,
				setRoot: unexpectedSetRootCall
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ warns, pathRows: results[0]?.slice(-1) }).toStrictEqual({
			warns: [],
			pathRows: [
				{
					label: StorePath.hash(appPath),
					value: 'a push would extend its grace 86,400s'
				}
			]
		});
	});

	it('with --dry-run --no-retain, names a matched zero-grace policy in the row and the warning', async () => {
		const results: ResultRow[][] = [];
		const warns: { label: string; value?: string }[] = [];

		await runPush(publication([appPath]), reporter(results, warns), {
			dryRun: true,
			retain: false,
			client: {
				negotiate: unexpectedNegotiateCall,
				preview: () =>
					Promise.resolve(
						uploadPreviewResponseSchema.parse({
							uploads: [
								{
									action: 'skip' as const,
									storePathHash: StorePath.hash(appPath),
									narHash: appDigest.narHash.toString(),
									grace: { graceSeconds: 0 }
								}
							]
						})
					),
				uploadNar: unexpectedUploadNarCall,
				commit: unexpectedCommitCall,
				setRoot: unexpectedSetRootCall
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect({ warns, pathRows: results[0]?.slice(-1) }).toStrictEqual({
			warns: [
				{
					label: 'unretained',
					value:
						'a zero-grace retention policy matched these paths; nothing retains them and the next collection can remove them'
				}
			],
			pathRows: [
				{
					label: StorePath.hash(appPath),
					value: 'matched a zero-grace policy; nothing retains it'
				}
			]
		});
	});

	it('with --dry-run, warns when the cache holds a different NAR for a skipped path', async () => {
		const cacheDigest = digest(9, 999);
		const warns: { label: string; value?: string }[] = [];

		await runPush(publication([appPath]), reporter([], warns), {
			dryRun: true,
			client: {
				negotiate: unexpectedNegotiateCall,
				preview: () =>
					Promise.resolve(
						uploadPreviewResponseSchema.parse({
							uploads: [
								{
									action: 'skip' as const,
									storePathHash: StorePath.hash(appPath),
									narHash: cacheDigest.narHash.toString()
								}
							]
						})
					),
				uploadNar: unexpectedUploadNarCall,
				commit: unexpectedCommitCall,
				setRoot: unexpectedSetRootCall
			} satisfies PushClient,
			nix: nixStore({ [appPath]: pathInfo(appPath, appDigest, []) })
		});

		expect(warns).toStrictEqual([
			{
				label: 'divergent',
				value:
					`${StorePath.basename(appPath)}: local NAR ` +
					`${appDigest.narHash.toString()} differs from the cached copy ` +
					`${cacheDigest.narHash.toString()}; the cache keeps its copy`
			}
		]);
	});
});

// A push whose target is uploaded and committed while its intermediate is
// already served, so both are servable and only the target is a subject.
function receiptPush(
	appInfo: NixValidPathInfo,
	dependencies: Pick<
		PushDependencies,
		'buildStore' | 'alreadyHeld' | 'claimable' | 'verifiedDerivations'
	>
): Promise<ParsedBuildReceiptV3 | undefined> {
	return runPush(publication([appPath], [runtimePath]), reporter([]), {
		retain: false,
		client: {
			preview: unexpectedPreviewCall,
			negotiate: () =>
				Promise.resolve(
					uploadNegotiateResponseSchema.parse({
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
					})
				),
			uploadNar: () => Promise.resolve(),
			commit: () => Promise.resolve(fallbackCommitResponse()),
			setRoot: unexpectedSetRootCall
		} satisfies PushClient,
		nix: nixStore({
			[appPath]: appInfo,
			[runtimePath]: pathInfo(runtimePath, runtimeDigest, [])
		}),
		createNarArchive: () => new FakeNarArchive(appDigest),
		compressNar: (nar) => fakeNarUpload(nar, digestForNar(nar)),
		...dependencies
	});
}

describe('the build receipt a push writes', () => {
	const appDrv = '/nix/store/8123456789abcdfghijklmnpqrsvwxyz-app.drv';
	const buildStore = 'ssh-ng://builder.example';

	it('records each published target the build store holds a deriver for', async () => {
		const receipt = await receiptPush(
			pathInfo(appPath, appDigest, [], appDrv),
			{ buildStore }
		);

		expect(receipt).toStrictEqual({
			version: 3,
			paths: [appPath, runtimePath],
			subjects: [
				{
					storePath: appPath,
					narHash: appDigest.narHash.digestHex(),
					derivation: appDrv,
					buildStore,
					verification: 'build-store'
				}
			],
			uploaded: [appPath]
		});
	});

	it('claims an output a local rebuild reproduced during this run', async () => {
		// A builder realised it and the build store copied it back, so the store
		// holds it without the mark it gives its own; the rebuild is what
		// establishes it.
		const receipt = await receiptPush(
			{ ...pathInfo(appPath, appDigest, [], appDrv), ultimate: false },
			{ buildStore, verifiedDerivations: [appDrv] }
		);

		expect(receipt).toStrictEqual({
			version: 3,
			paths: [appPath, runtimePath],
			subjects: [
				{
					storePath: appPath,
					narHash: appDigest.narHash.digestHex(),
					derivation: appDrv,
					buildStore,
					verification: 'verified-rebuild'
				}
			],
			uploaded: [appPath]
		});
	});

	it.each([
		{
			case: 'a target with no deriver',
			appInfo: pathInfo(appPath, appDigest, []),
			dependencies: { buildStore }
		},
		{
			case: 'a target the build store substituted',
			appInfo: {
				...pathInfo(appPath, appDigest, [], appDrv),
				ultimate: false
			},
			dependencies: { buildStore }
		},
		{
			case: 'an output a builder realised that no rebuild reproduced',
			appInfo: {
				...pathInfo(appPath, appDigest, [], appDrv),
				ultimate: false
			},
			dependencies: { buildStore, verifiedDerivations: [] }
		},
		{
			case: 'a path the build store already held',
			appInfo: pathInfo(appPath, appDigest, [], appDrv),
			dependencies: { buildStore, alreadyHeld: [appPath] }
		},
		{
			case: 'a path this run never resolved before it built',
			appInfo: pathInfo(appPath, appDigest, [], appDrv),
			dependencies: { buildStore, claimable: [runtimePath] }
		}
	])(
		'publishes $case without claiming it as a subject',
		async ({ appInfo, dependencies }) => {
			const receipt = await receiptPush(appInfo, dependencies);

			expect(receipt).toStrictEqual({
				version: 3,
				paths: [appPath, runtimePath],
				subjects: [],
				uploaded: [appPath]
			});
		}
	);

	it('writes no receipt when the push names no build store', async () => {
		const receipt = await receiptPush(
			pathInfo(appPath, appDigest, [], appDrv),
			{}
		);

		expect(receipt).toBeUndefined();
	});
});

function deferredUpload(
	events: string[]
): Pick<PushClient, 'negotiate' | 'uploadNar' | 'commit'> {
	return {
		negotiate() {
			events.push('negotiate');

			return Promise.resolve(
				uploadNegotiateResponseSchema.parse({
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
				})
			);
		},
		async uploadNar(_r2Key, body) {
			events.push('uploadNar');
			await collectReadableStream(body);
		},
		commit() {
			events.push('commit');

			return Promise.resolve({
				storePathHash: StorePath.hash(appPath),
				narHash: appDigest.narHash.value,
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

// The NAR serialisation a fake store client streams for a path: one chunk
// carrying the digest's bytes, the way FakeNarArchive yields them.
async function* narBytes(digestValue: NarDigest): AsyncIterable<Uint8Array> {
	await Promise.resolve();

	yield digestValue.narHash.digestBytes();
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
	storePath: StorePathString,
	narDigest: NarDigest,
	references: readonly StorePathString[],
	deriver?: string
): NixValidPathInfo {
	return {
		storePath,
		narHash: narDigest.narHash,
		narSize: narDigest.narSize,
		references,
		signatures: [],
		ultimate: true,
		...(deriver !== undefined && { deriver })
	};
}

function knownPathInfo(
	paths: Record<string, NixValidPathInfo>,
	storePath: StorePathString
): NixValidPathInfo {
	return z
		.custom<NixValidPathInfo>((value) => value !== undefined)
		.parse(paths[storePath]);
}

interface NixCall {
	readonly method: 'resolveClosure' | 'queryValidPathsInfo';
	readonly paths: readonly string[];
}

function nixStore(
	paths: Record<string, NixValidPathInfo>,
	calls: NixCall[] = [],
	options: {
		readonly storeKind?: NixStoreKind;
		readonly narFromPath?: (
			storePath: StorePathString
		) => AsyncIterable<Uint8Array>;
	} = {}
): Nix {
	const store = {
		resolveClosure(storePaths: readonly StorePathString[]) {
			calls.push({ method: 'resolveClosure', paths: storePaths });

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
		queryPathInfo: (storePath: StorePathString) =>
			Promise.resolve(knownPathInfo(paths, storePath)),
		queryPathsInfo: (storePaths: readonly StorePathString[]) =>
			Promise.resolve(
				storePaths.map((storePath) => knownPathInfo(paths, storePath))
			),
		queryValidPathsInfo: (storePaths: readonly StorePathString[]) => {
			calls.push({ method: 'queryValidPathsInfo', paths: storePaths });

			return Promise.resolve(
				storePaths
					.filter((storePath) => paths[storePath] !== undefined)
					.map((storePath) => knownPathInfo(paths, storePath))
			);
		},
		queryValidPaths: (storePaths: readonly StorePathString[]) =>
			Promise.resolve(
				storePaths.filter((storePath) => paths[storePath] !== undefined)
			),
		querySubstitutablePaths: () => Promise.resolve([]),
		querySubstitutablePathInfos: () => Promise.resolve([]),
		queryDerivationOutputPaths: () => Promise.resolve([]),
		queryMissing: () =>
			Promise.resolve({
				willBuild: [],
				willSubstitute: [],
				unknown: [],
				downloadSize: 0,
				narSize: 0
			}),
		readDerivation: (drvPath: StorePathString): Promise<string> => {
			throw new Error(`No derivation is modelled for ${drvPath}`);
		},
		narFromPath:
			options.narFromPath ??
			((storePath: StorePathString): AsyncIterable<Uint8Array> => {
				throw new Error(`No NAR stream is modelled for ${storePath}`);
			}),
		buildPathsWithResults: () => Promise.resolve([])
	};

	return Nix.forStore(store, {
		storeDirectory: storeDirectorySchema.parse('/nix/store'),
		realpath: (path) => path,
		...(options.storeKind !== undefined && { storeKind: options.storeKind })
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
		preview: unexpectedPreviewCall,
		negotiate(body) {
			clientCalls.push({
				method: 'negotiate',
				paths: body.paths.map((path) => path.storePath)
			});

			return Promise.resolve(
				uploadNegotiateResponseSchema.parse({
					uploads: body.paths.map((path) => ({
						action: 'skip',
						storePathHash: path.storePathHash,
						narHash: path.narHash
					}))
				})
			);
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

			return Promise.resolve(
				uploadNegotiateResponseSchema.parse({
					uploads: body.paths.map((path) => ({
						action: 'skip' as const,
						storePathHash: path.storePathHash,
						narHash: cacheNarHash
					}))
				})
			);
		}
	};
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
			payloads.push(payload);
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
