import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { uploadNegotiateResponseSchema } from '@cupboard/protocol/upload';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
	type BatchStore,
	BuildOutputBatcher
} from '../../packages/cli/src/build-push/batching.ts';
import { NarArchive } from '../../packages/cli/src/nix/nar.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import { NixDaemonStoreClient } from '../../packages/nix/src/nix-daemon.ts';
import { temporaryRoot } from '../support/filesystem.ts';
import { DivertedNixDaemon, NixStore } from '../support/nix.ts';

const isDaemonSocketPresent = existsSync('/nix/var/nix/daemon-socket/socket');
const isCompilerPresent = spawnSync('cc', ['--version']).status === 0;

// A batch flush's session takes a temporary root per path before it reads
// anything, and the root lives exactly as long as the session's daemon
// connection. Temporary roots exist only behind a daemon, macOS cannot build
// into a diverted (`local?root=`) store, and collecting the host store
// discards real data, so this suite starts a dedicated
// `nix-daemon --store 'local?root=<tmp>'` and runs on Linux, where the CI
// end-to-end job provides real Nix.
describe.skipIf(
	process.platform !== 'linux' || !isDaemonSocketPresent || !isCompilerPresent
)('build-push temporary roots under collection', () => {
	let workspace: string;
	let store: NixStore;
	let daemon: DivertedNixDaemon;
	let client: NixDaemonStoreClient;
	let batchStore: BatchStore;
	let sequence = 0;

	beforeAll(async () => {
		// The store root and daemon socket sit under a symlink-free temporary
		// root: Nix refuses a store whose parent path traverses a symlink.
		workspace = await mkdtemp(path.join(temporaryRoot, 'cupboard-gc-e2e-'));
		const storeRoot = path.join(workspace, 'store');
		store = await NixStore.chroot(storeRoot, path.join(workspace, 'nix-home'));
		daemon = await DivertedNixDaemon.start({
			root: storeRoot,
			home: path.join(workspace, 'daemon-home'),
			socketPath: path.join(workspace, 'daemon.sock')
		});
		client = new NixDaemonStoreClient({ socketPath: daemon.socketPath });
		batchStore = {
			withConnection: (use) => client.withConnection(use)
		};
	}, 120_000);

	afterAll(async () => {
		await daemon.stop();
		await rm(workspace, { recursive: true, force: true });
	});

	// Adds a fresh unique file to the diverted store. `nix-store --add`
	// registers no root, so the path is collectable until something pins it.
	async function addPath(): Promise<StorePathString> {
		sequence += 1;
		const sources = path.join(workspace, 'sources');
		await mkdir(sources, { recursive: true });
		const file = path.join(sources, `f-${String(sequence)}.txt`);
		await writeFile(file, `cupboard gc e2e ${randomUUID()}\n`);

		return storePathSchema.parse(await store.add(file));
	}

	interface RecordedBatches {
		readonly negotiated: (readonly string[])[];
		readonly committed: string[];
	}

	function batchPushClient(
		record: RecordedBatches,
		hooks: { readonly onUploadNar?: () => Promise<void> } = {}
	): PushClient {
		return {
			preview: () =>
				Promise.reject(new Error('preview is not part of a batch flush')),
			negotiate(body) {
				record.negotiated.push(body.paths.map((entry) => entry.storePath));

				return Promise.resolve(
					uploadNegotiateResponseSchema.parse({
						uploads: body.paths.map((entry) => ({
							action: 'upload',
							storePathHash: entry.storePathHash,
							narHash: entry.narHash,
							uploadId: `upload-${entry.storePathHash}`,
							r2Key: `nar/${entry.storePathHash}.nar.zst`,
							expiresAt: '2099-01-01T00:00:00.000Z'
						}))
					})
				);
			},
			async uploadNar(_r2Key, body) {
				await hooks.onUploadNar?.();

				for await (const chunk of body) {
					void chunk;
				}
			},
			commit(target) {
				record.committed.push(target.storePathHash);

				return Promise.resolve({
					storePathHash: target.storePathHash,
					narHash: target.narHash,
					status: 'committed',
					settled: Promise.resolve()
				});
			},
			setRoot: () =>
				Promise.reject(new Error('setRoot is not part of a batch flush'))
		};
	}

	// The batcher's default NAR reader opens the logical store path, which for
	// a diverted store lives under the store root; the file content and modes
	// are identical, so the archive digests to the recorded NAR hash.
	const physicalNarArchive = (storePath: string): NarArchive =>
		new NarArchive(store.physicalPath(storePath));

	it('protects a queued path across a concurrent collection until its batch completes', async () => {
		const storePath = await addPath();
		const physical = store.physicalPath(storePath);
		const uploadStarted = Promise.withResolvers<boolean>();
		const uploadRelease = Promise.withResolvers<boolean>();
		const record: RecordedBatches = { negotiated: [], committed: [] };
		const batcher = new BuildOutputBatcher({
			store: batchStore,
			client: batchPushClient(record, {
				onUploadNar: async () => {
					uploadStarted.resolve(true);
					await uploadRelease.promise;
				}
			}),
			createNarArchive: physicalNarArchive
		});

		batcher.enqueue(storePath);
		const drained = batcher.drain();

		// The flush has taken its temporary root and is mid-upload; a full
		// collection now must leave the queued path alone.
		await uploadStarted.promise;
		await store.collectGarbage();
		const didSurviveCollection = existsSync(physical);

		uploadRelease.resolve(true);
		await drained;

		expect({
			didSurviveCollection,
			outcome: batcher.outcomes.get(storePath),
			candidates: batcher.candidates
		}).toStrictEqual({
			didSurviveCollection: true,
			outcome: { outcome: 'published', storePath },
			candidates: []
		});

		// The batch completed and its connection closed, which is the release:
		// nothing retains the path any more, so collection removes it. The
		// daemon drops the root as its per-connection child exits, which lags
		// the client's close, so the collection is repeated until the release
		// is visible.
		await expect
			.poll(
				async () => {
					await store.collectGarbage();

					return existsSync(physical);
				},
				{ interval: 500, timeout: 60_000 }
			)
			.toBe(false);
	});

	it('records a collected path as a typed outcome and publishes the rest of the batch', async () => {
		const vanished = await addPath();
		// Nothing roots the path, so the collection genuinely removes it from
		// the diverted store before the batch reads it.
		await store.collectGarbage();
		const survivor = await addPath();
		const record: RecordedBatches = { negotiated: [], committed: [] };
		const batcher = new BuildOutputBatcher({
			store: batchStore,
			client: batchPushClient(record),
			createNarArchive: physicalNarArchive
		});

		batcher.enqueue(vanished);
		batcher.enqueue(survivor);
		await batcher.drain();

		expect({
			vanishedRemoved: !existsSync(store.physicalPath(vanished)),
			vanishedOutcome: batcher.outcomes.get(vanished),
			survivorOutcome: batcher.outcomes.get(survivor),
			negotiated: record.negotiated,
			candidates: batcher.candidates
		}).toStrictEqual({
			vanishedRemoved: true,
			vanishedOutcome: { outcome: 'collected', storePath: vanished },
			survivorOutcome: { outcome: 'published', storePath: survivor },
			negotiated: [[survivor]],
			candidates: []
		});
	});
});
