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
		attestations
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
});
