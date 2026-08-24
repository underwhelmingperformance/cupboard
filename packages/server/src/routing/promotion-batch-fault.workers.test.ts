import { rootLogger } from '@cupboard/logger';
import { isoTimestamp } from '@cupboard/protocol/scalars';
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

describe('promotion after a transient D1 batch failure', () => {
	beforeEach(resetTestServer);

	it('settles a fresh and a reuse claim after one batch rejection', async () => {
		const token = await initialise();

		const fresh = await deferFreshUpload(
			token,
			'batch-retry-fresh',
			'a'.repeat(32)
		);
		const reuse = await deferReuseUpload(
			token,
			'batch-retry-reuse',
			'b'.repeat(32),
			'c'.repeat(32)
		);

		// The claim pin uses the first batch. Fail the first promotion batch so
		// both claims must use the retry.
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchCallCount = 0;
		const batchSpy = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation((...arguments_) => {
				batchCallCount += 1;

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

// A persistent D1 read fault can occur after R2 promotion has completed. The
// claim must remain pending and lose its lease so the next pass can finish it
// from the durable `blob_state` row.
describe('promotion followed by a persistent D1 fault', () => {
	beforeEach(resetTestServer);

	it('leaves the claim immediately retryable when all batch attempts reject', async () => {
		const token = await initialise();

		const fresh = await deferFreshUpload(
			token,
			'batch-fallback-fresh',
			'1'.repeat(32)
		);

		// The pin batch is call 1. Calls 2-4 read the stored blob metadata after
		// promotion, including the per-row fallback after prefetch fails.
		const originalBatch = env.CUPBOARD_DB.batch.bind(env.CUPBOARD_DB);
		let batchCallCount = 0;
		const batchSpy = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockImplementation((...arguments_) => {
				batchCallCount += 1;

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
			freshVerdict: 'pending',
			blobState: [{ narHash: fresh.metadata.narHash }]
		});

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		expect(await pendingUploadVerdict(fresh.uploadId)).toBeUndefined();
	});
});

// A verification claim must clear an armed reaper timer before decoding. The
// reaper must not delete the canonical object while verification is in flight.
describe('reaper pin for claimed hashes', () => {
	beforeEach(resetTestServer);

	it('clears delete_after on armed blob_state rows before any decode', async () => {
		const token = await initialise();
		const reuse = await deferReuseUpload(
			token,
			'pin-reuse',
			'4'.repeat(32),
			'5'.repeat(32)
		);

		const armedUntil = new Date(testBase.getTime() + 5000);
		await armBlobReaperTimer(
			reuse.narHash as Parameters<typeof armBlobReaperTimer>[0],
			isoTimestamp(armedUntil)
		);

		const beforePass = await blobStateArmTimes();

		await verifyTenant(rootLogger(), env, currentServerTenant(), 10);

		const afterPass = await blobStateArmTimes();

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
