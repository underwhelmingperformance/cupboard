import { rootLogger } from '@cupboard/logger';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	commitPath,
	commitUpload,
	currentServer,
	expectSingleCommitDecision,
	initialise,
	negotiateUploads,
	openCommitSession,
	provisionFixtureTenant,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { CommitPipelineService } from './commit-pipeline-service.ts';
import { type ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { SigningKeysService } from './signing-keys-service.ts';
import { UploadStateService } from './upload-state-service.ts';

// The pipeline over a live instance's context, as the server itself builds it.
function pipelineFor(context: ServerContext): CommitPipelineService {
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestationCas = new AttestationCasService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);

	return new CommitPipelineService(
		context,
		new CacheAdminService(context, deletionQueue),
		new SigningKeysService(context),
		new UploadStateService(context),
		narInfoObjects
	);
}

// Concurrent settles share the materialise flush: a burst that has enqueued by
// the time a flush's gate turn comes lands in one batch, so a loaded push
// settles many paths per gate and per combined charge batch.
describe('batched commit settles', () => {
	beforeEach(resetTestServer);

	it('settles a synchronous burst in one combined charge batch', async () => {
		const token = await initialise();
		const nar = await verifiableNar('commit-batching');
		const paths = ['a', 'b', 'c', 'd', 'f', 'g'].map((letter, index) =>
			uploadMetadata({
				name: `batched-${String(index)}`,
				storePathHash: letter.repeat(32),
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			})
		);

		// The first path uploads the blob; the rest negotiate to reuse commits of
		// the now-canonical bytes and settle through the ordinary flow, so every
		// path ends committed with its own narinfo row.
		const [uploadPath, ...reusePaths] = paths;

		if (uploadPath === undefined) {
			throw new Error('the burst needs at least one path');
		}

		await commitPath(token, uploadPath, nar);

		for (const metadata of reusePaths) {
			const decision = expectSingleCommitDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			await commitUpload(token, decision.uploadId);
		}

		// Re-materialising a committed row at its own version is idempotent (the
		// conditional charge statements replay as no-ops), so the burst below is
		// the settle path with a known, already-reserved generation per path.
		const batches = vi.spyOn(env.CUPBOARD_DB, 'batch');

		try {
			const outcomes = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const pipeline = pipelineFor(instance.context);
					// One probe covers the burst: every path reuses the same canonical
					// blob, so the shared facts are identical.
					const [head, ...rest] = paths;

					if (head === undefined) {
						throw new Error('the burst needs at least one path');
					}

					const probe = await pipeline.probeMaterialisation(head);
					// The probe reads its shared facts in one batch of its own; discount
					// it so the count measures only the charge the flush settles.
					batches.mockClear();
					const rows = instance.context.db
						.select({
							storePathHash: schema.narInfos.storePathHash,
							generation: schema.narInfos.generation
						})
						.from(schema.narInfos)
						.all();
					const generations = new Map(
						rows.map((row) => [row.storePathHash, row.generation])
					);

					// Every request enqueues in the same tick, so the first flush's
					// gate callback takes them all.
					return Promise.all(
						[head, ...rest].map((metadata) => {
							const generation = generations.get(metadata.storePathHash);

							if (generation === undefined) {
								throw new Error('the committed path has no narinfo row');
							}

							return pipeline.materialiseBatched(rootLogger(), {
								cache: '',
								metadata,
								generation,
								probe,
								mustOwnBlob: true
							});
						})
					);
				}
			);

			expect({
				kinds: outcomes.map((outcome) => outcome.kind),
				chargeBatches: batches.mock.calls.length
			}).toStrictEqual({
				kinds: paths.map(() => 'materialised'),
				chargeBatches: 1
			});
		} finally {
			batches.mockRestore();
		}
	});

	it('reads a set of probe facts in two concurrent batches, then probes from memory', async () => {
		const token = await initialise();

		const paths = await Promise.all(
			['a', 'b', 'c'].map(async (letter, index) => {
				const nar = await verifiableNar(`prefetch-${letter}`);
				const metadata = uploadMetadata({
					name: `prefetch-${String(index)}`,
					storePathHash: letter.repeat(32),
					narHash: nar.narHash,
					fileHash: nar.fileHash,
					fileSize: nar.narBytes.byteLength,
					narSize: nar.narSize
				});
				await commitPath(token, metadata, nar);

				return metadata;
			})
		);

		const narHashes = paths.map((metadata) => metadata.narHash);
		const [head] = paths;

		if (head === undefined) {
			throw new Error('the set needs at least one path');
		}

		const counts = await runInDurableObject(
			currentServer(),
			async (instance) => {
				const pipeline = pipelineFor(instance.context);
				const batches = vi.spyOn(env.CUPBOARD_DB, 'batch');

				try {
					const prefetched =
						await pipeline.prefetchMaterialisationFacts(narHashes);
					const prefetchBatches = batches.mock.calls.length;

					// A probe handed the prefetched facts pays only its R2 head, no D1
					// batch of its own.
					batches.mockClear();
					await pipeline.probeMaterialisation(
						head,
						prefetched.get(head.narHash)
					);

					return {
						prefetchBatches,
						probeBatches: batches.mock.calls.length,
						facts: prefetched.size
					};
				} finally {
					batches.mockRestore();
				}
			}
		);

		expect(counts).toStrictEqual({
			prefetchBatches: 2,
			probeBatches: 0,
			facts: 3
		});
	});

	it('a commit-batch of reuse entries pays two prefetch D1 batches plus one charge flush, not one probe per entry', async () => {
		const token = await initialise();
		const nar = await verifiableNar('socket-prefetch');
		const paths = ['a', 'b', 'c'].map((letter, index) =>
			uploadMetadata({
				name: `socket-prefetch-${String(index)}`,
				storePathHash: letter.repeat(32),
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			})
		);
		const [first, ...rest] = paths;

		if (first === undefined) {
			throw new Error('the batch needs at least one path');
		}

		// Commit the first path so its canonical blob is in the CAS; the rest
		// negotiate as reuse commits sharing that blob.
		await commitPath(token, first, nar);

		const reuseEntries: {
			uploadId: string;
			metadata: (typeof rest)[number];
		}[] = [];

		for (const metadata of rest) {
			const decision = expectSingleCommitDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			reuseEntries.push({ uploadId: decision.uploadId, metadata });
		}

		// Spy on D1 batch calls. The commit-batch handler prefetches facts for the
		// whole message (2 D1 batches), each entry's probe reads from memory (0
		// per-entry D1 batches), and the shared materialise flush settles all entries
		// in one charge batch (1 D1 batch). Total: 3 batch calls regardless of the
		// number of entries.
		const batches = vi.spyOn(env.CUPBOARD_DB, 'batch');

		try {
			const session = await openCommitSession(token);
			session.send({
				op: 'commit-batch',
				commits: reuseEntries.map(({ uploadId, metadata }) => ({
					uploadId,
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}))
			});

			for (const _ of reuseEntries) {
				await session.nextFrame();
			}

			session.socket.close();

			expect(batches.mock.calls.length).toBe(3);
		} finally {
			batches.mockRestore();
		}
	});

	it('both entries of a batch sharing one narHash settle when quota fits exactly one blob charge', async () => {
		const nar = await verifiableNar('shared-hash-quota');

		// Commit the first path so the tenant owns the blob with bytes = fileSize.
		// Quota is then set to exactly fileSize, leaving no headroom for a second
		// charge. Paths B and C negotiate as reuse commits (the tenantBlob row
		// already exists), so the batch's prefetch reads isOwned=true for both and
		// the materialise flush skips the byte credit, so both settle with no
		// over-quota event.
		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength });
		const token = await initialise();

		const pathA = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			name: 'shared-hash-a',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const pathB = uploadMetadata({
			storePathHash: 'b'.repeat(32),
			name: 'shared-hash-b',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const pathC = uploadMetadata({
			storePathHash: 'c'.repeat(32),
			name: 'shared-hash-c',
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, pathA, nar);

		// B and C negotiate as reuse commits: the tenant already owns the blob, so
		// findReusableBlobs returns it for both.
		const decisionB = expectSingleCommitDecision(
			await negotiateUploads(token, [pathB]),
			pathB
		);
		const decisionC = expectSingleCommitDecision(
			await negotiateUploads(token, [pathC]),
			pathC
		);

		const session = await openCommitSession(token);
		session.send({
			op: 'commit-batch',
			commits: [
				{
					uploadId: decisionB.uploadId,
					storePathHash: pathB.storePathHash,
					narHash: pathB.narHash
				},
				{
					uploadId: decisionC.uploadId,
					storePathHash: pathC.storePathHash,
					narHash: pathC.narHash
				}
			]
		});

		const frames = [await session.nextFrame(), await session.nextFrame()];
		session.socket.close();

		expect(
			frames.map((f) => f.ev).toSorted((a, b) => a.localeCompare(b))
		).toStrictEqual(['settled', 'settled']);
	});
});
