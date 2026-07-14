import { rootLogger } from '@cupboard/logger';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import { narObjectKey } from '../http/http.ts';
import {
	commitPath,
	currentServer,
	expectSingleCommitDecision,
	initialise,
	negotiateUploads,
	resetTestServer,
	seedReservedNarInfo,
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

// A push that dies between reserving a narinfo row and materialising it, whose
// upload row is then reaped, leaves the path reserved by a dead saga. A retry
// must not park on the verification pass for a heal it can perform itself: it
// reclaims the dead reservation and commits afresh.
describe('dead reservation reclaim at commit', () => {
	beforeEach(resetTestServer);

	it('commits a path whose reservation has no live upload behind it', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reservation-reclaim');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		// The retried path: a reuse of the canonical blob.
		const retried = uploadMetadata({
			name: 'retried',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const doomed = expectSingleCommitDecision(
			await negotiateUploads(token, [retried]),
			retried
		);

		// The first commit attempt reserves the row and dies at the charge, the
		// shape of a push interrupted mid-saga.
		await runInDurableObject(currentServer(), async (instance) => {
			const pipeline = pipelineFor(instance.context);
			const realD1 = instance.context.d1;

			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: {
					select: realD1.select.bind(realD1),
					update: realD1.update.bind(realD1),
					delete: realD1.delete.bind(realD1),
					insert: realD1.insert.bind(realD1),
					batch: () => Promise.reject(new Error('simulated charge outage'))
				}
			});

			let didFail = false;

			try {
				await pipeline.commit(rootLogger(), '', doomed.uploadId);
			} catch {
				didFail = true;
			}

			Object.defineProperty(instance.context, 'd1', {
				configurable: true,
				value: realD1
			});

			expect(didFail).toBe(true);

			// The interrupted saga's upload row is reaped, exactly as the expiry
			// sweep does, leaving the reservation with nothing live behind it.
			instance.context.db
				.delete(schema.pendingUploads)
				.where(eq(schema.pendingUploads.id, doomed.uploadId))
				.run();
		});

		// The retry negotiates and commits the same path afresh. It must settle
		// synchronously by reclaiming the dead reservation, not defer onto the
		// verification pass.
		const fresh = expectSingleCommitDecision(
			await negotiateUploads(token, [retried]),
			retried
		);
		const outcome = await runInDurableObject(currentServer(), (instance) =>
			pipelineFor(instance.context).commit(rootLogger(), '', fresh.uploadId)
		);

		expect(outcome).toStrictEqual({
			kind: 'settled',
			response: {
				storePathHash: retried.storePathHash,
				narHash: retried.narHash,
				status: 'committed'
			}
		});
	});
});

// The `mine` outcome from `reserveNarInfoRow` arises when the narinfo row
// already exists with matching content (same narHash, narSize, storePath,
// references). This happens for a reuse commit that replays before its
// original has finished. The commit must proceed through materialise
// using the existing generation, not call `concedeToWinner`.
describe('reuse commit handles mine outcome from reserveNarInfoRow', () => {
	beforeEach(resetTestServer);

	it('settles a reuse commit whose narinfo row was already reserved by the same upload', async () => {
		const token = await initialise();
		const nar = await verifiableNar('mine-outcome');

		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		// A second path reuses the same canonical blob.
		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		// Plant a narinfo reservation for the second path with the same content,
		// as if this upload's original commit attempt reserved the row and then
		// stalled before materialising. On the replay, `reserveNarInfoRow` sees
		// the row with matching fields and returns `mine`.
		await seedReservedNarInfo(second);

		const outcome = await runInDurableObject(currentServer(), (instance) =>
			pipelineFor(instance.context).commit(rootLogger(), '', reuse.uploadId)
		);

		// Must settle as committed (materialised from the existing reservation),
		// not return `already-present` as if it conceded to a different winner.
		expect(outcome).toStrictEqual({
			kind: 'settled',
			response: {
				storePathHash: second.storePathHash,
				narHash: second.narHash,
				status: 'committed'
			}
		});
	});
});

// `concedeToWinner` is reached when a concurrent commit won the narinfo
// reservation. If that winner has not yet materialised (no D1 blobReference
// edge), `committedNarInfoRow` returns undefined; `already-present` would
// assert a servable path nothing serves. The concede must answer `deferred`
// and leave the upload row intact for the verify pass to settle.
describe('concedeToWinner defers when no committed winner exists', () => {
	beforeEach(resetTestServer);

	it('returns deferred when the winning narinfo reservation has not yet materialised', async () => {
		const token = await initialise();
		const nar = await verifiableNar('concede-no-winner');

		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		// Commit the first path so its canonical blob is in R2.
		await commitPath(token, first, nar);

		// A second path reuses the same canonical blob.
		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		// Call `concedeToWinner` directly with the reuse upload's metadata and
		// the canonical staging key. No D1 `blobReference` edge exists for the
		// second path yet, so `committedNarInfoRow` returns undefined and the
		// call must return `deferred`, not `already-present`.
		const outcome = await runInDurableObject(currentServer(), (instance) =>
			pipelineFor(instance.context).concedeToWinner(
				'',
				reuse.uploadId,
				second,
				narObjectKey(second.narHash)
			)
		);

		// The winner has not materialised: must defer, not answer already-present.
		expect(outcome).toStrictEqual({
			kind: 'deferred',
			storePathHash: second.storePathHash,
			narHash: second.narHash
		});
	});
});
