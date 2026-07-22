import { rootLogger } from '@cupboard/logger';
import type { UploadId } from '@cupboard/protocol/upload';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { verifyTenant } from '../routing/scheduled.ts';
import {
	armBlobReaperTimer,
	blobStateArmTimes,
	blobStateNarHashes,
	commitPath,
	currentServerTenant,
	deferFreshUpload,
	expectSingleCommitDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	pendingUploadVerdict,
	resetTestServer,
	testBase,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

const byNarHash = (a: string, b: string) => a.localeCompare(b);

// Sets up one committed path so a second path sharing its NAR hash arrives as a
// deferred reuse claim. Returns the reuse claim's uploadId and the shared
// narHash.
async function deferReuseUpload(
	token: string,
	firstSeed: string,
	firstStorePathHash: string,
	secondStorePathHash: string
): Promise<{ uploadId: UploadId; narHash: string }> {
	const nar = await verifiableNar(firstSeed);
	const first = uploadMetadata({
		name: firstSeed,
		storePathHash: firstStorePathHash,
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});

	await commitPath(token, first, nar);

	const second = uploadMetadata({
		name: 'second',
		storePathHash: secondStorePathHash,
		narHash: nar.narHash,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		narSize: nar.narSize
	});
	const reuse = expectSingleCommitDecision(
		await negotiateUploads(token, [second]),
		second
	);

	await markUploadPendingVerification(reuse.uploadId);

	return { uploadId: reuse.uploadId, narHash: nar.narHash };
}

// Promotion batch retry: the batch fails once then recovers. Both a fresh and a
// reuse claim must still settle in the same pass via the retry path.
describe('promotion batch: transient D1 fault recovers via retry', () => {
	beforeEach(resetTestServer);

	it('settles a fresh and a reuse claim after one batch rejection', async () => {
		const token = await initialise();

		const fresh = await deferFreshUpload(
			token,
			'batch-retry-fresh',
			// Valid Nix base32 chars only (no e, o, t, u).
			'a'.repeat(32)
		);
		const reuse = await deferReuseUpload(
			token,
			'batch-retry-reuse',
			'b'.repeat(32),
			'c'.repeat(32)
		);

		// The spy tracks every call to env.CUPBOARD_DB.batch. The first call is
		// the pin UPDATE (finding 1). Reject the second call (the first promotion
		// batch) and let the rest succeed to exercise the retry path.
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchCallCount = 0;
		const batchSpy = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation((...arguments_) => {
				batchCallCount += 1;

				// Call 1 is the pin UPDATE; call 2 is the first promotion batch.
				if (batchCallCount === 2) {
					return Promise.reject(new Error('simulated D1 transient fault'));
				}

				return originalBatch(...arguments_);
			});

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			batchSpy.mockRestore();
		}

		const blobState = await blobStateNarHashes();

		expect({
			freshVerdict: await pendingUploadVerdict(fresh.uploadId),
			reuseVerdict: await pendingUploadVerdict(reuse.uploadId),
			blobStateHashes: blobState.map((row) => row.narHash).toSorted(byNarHash)
		}).toStrictEqual({
			freshVerdict: undefined,
			reuseVerdict: undefined,
			blobStateHashes: [fresh.metadata.narHash, reuse.narHash].toSorted(
				byNarHash
			)
		});
	});
});

// Promotion batch per-statement fallback: persistent D1 failures exhaust retries.
// The batch is tested with one fresh claim: block all batch calls from the
// promotion batch, let the per-statement .run() go through (it bypasses batch),
// and confirm the claim settles via the fallback verdict path.
describe('promotion batch: persistent D1 fault falls back per-statement', () => {
	beforeEach(resetTestServer);

	it('settles a fresh claim when all batch attempts reject', async () => {
		const token = await initialise();

		const fresh = await deferFreshUpload(
			token,
			'batch-fallback-fresh',
			// Valid Nix base32 chars only (no e, o, t, u).
			'1'.repeat(32)
		);

		// The pin batch is call 1. Calls 2-4 are the 3 promotion batch retries for
		// the single fresh claim. Let call 1 and calls >= 5 through (DO settlement
		// and any later batches). The per-statement fallback calls .run() which
		// bypasses env.CUPBOARD_DB.batch entirely, so the upsert still lands.
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchCallCount = 0;
		const batchSpy = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation((...arguments_) => {
				batchCallCount += 1;

				// Block exactly the 3 promotion batch retries (calls 2, 3, 4).
				if (batchCallCount >= 2 && batchCallCount <= 4) {
					return Promise.reject(new Error('simulated persistent D1 fault'));
				}

				return originalBatch(...arguments_);
			});

		try {
			await verifyTenant(rootLogger(), env, currentServerTenant(), 10);
		} finally {
			batchSpy.mockRestore();
		}

		expect({
			freshVerdict: await pendingUploadVerdict(fresh.uploadId),
			blobState: await blobStateNarHashes()
		}).toStrictEqual({
			freshVerdict: undefined,
			blobState: [{ narHash: fresh.metadata.narHash }]
		});
	});
});

// Finding 1: the reaper pin. When a blob_state row has an armed grace timer at
// claim time, the pass clears it before decodes begin, so the reaper cannot
// delete the row and its canonical object while the pass is in flight.
describe('reaper pin: claimed hashes have their grace timers cleared up front', () => {
	beforeEach(resetTestServer);

	it('clears delete_after on armed blob_state rows before any decode', async () => {
		const token = await initialise();
		const reuse = await deferReuseUpload(
			token,
			'pin-reuse',
			// Valid Nix base32 chars only.
			'4'.repeat(32),
			'5'.repeat(32)
		);

		// Arm the reaper timer on the shared blob's existing row.
		await armBlobReaperTimer(
			reuse.narHash as Parameters<typeof armBlobReaperTimer>[0],
			new Date(testBase.getTime() + 5000).toISOString()
		);

		const beforePass = await blobStateArmTimes();

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		const afterPass = await blobStateArmTimes();

		// The pin cleared the timer before any decode ran, and the claim settled.
		expect({
			beforePassArmed: beforePass.some(
				(row) => row.narHash === reuse.narHash && row.deleteAfter !== undefined
			),
			afterPassArmed: afterPass.some(
				(row) => row.narHash === reuse.narHash && row.deleteAfter !== undefined
			),
			reuseVerdict: await pendingUploadVerdict(reuse.uploadId)
		}).toStrictEqual({
			beforePassArmed: true,
			afterPassArmed: false,
			reuseVerdict: undefined
		});
	});
});
