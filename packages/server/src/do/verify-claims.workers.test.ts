import { byCodeUnit } from '@cupboard/nix-store/store-path';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narObjectKey, verifyClaimLeaseMs } from '../http/http.ts';
import {
	commitPath,
	currentServer,
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

import { UploadStateService } from './upload-state-service.ts';
import { type PendingVerification } from './verification-service.ts';

// Claims come back in upload-id order (the scan's cursor), so the expected
// prefix is the deferred uploads sorted by id.
function claimOrder(
	uploads: readonly {
		uploadId: string;
		r2Key: string;
		metadata: { narHash: PendingVerification['narHash']; narSize: number };
	}[]
): PendingVerification[] {
	return uploads
		.toSorted((left, right) => byCodeUnit(left.uploadId, right.uploadId))
		.map((upload) => ({
			uploadId: upload.uploadId,
			r2Key: upload.r2Key,
			narHash: upload.metadata.narHash,
			narSize: upload.metadata.narSize,
			reuse: false
		}));
}

// A claim is a bounded chunk of the pending backlog: a row cap and a
// cumulative byte cap over the fresh rows, with `truncated` telling the
// consumer to chain another pass for what was left behind.
describe('claiming a verification batch', () => {
	beforeEach(resetTestServer);

	it('cuts the claim at the byte cap and reports the truncation', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'byte-cap-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'byte-cap-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'byte-cap-c', 'c'.repeat(32))
		];
		const ordered = claimOrder(uploads);
		const capForTwo = ordered
			.slice(0, 2)
			.reduce((total, claim) => total + claim.narSize, 0);

		const batch = await currentServer().claimVerificationBatch(10, capForTwo);

		expect(batch).toStrictEqual({
			claims: ordered.slice(0, 2),
			truncated: true
		});
	});

	it('claims a lone over-cap row rather than starving it', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'over-cap-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'over-cap-b', 'b'.repeat(32))
		];
		const ordered = claimOrder(uploads);

		const batch = await currentServer().claimVerificationBatch(10, 1);

		expect(batch).toStrictEqual({
			claims: ordered.slice(0, 1),
			truncated: true
		});
	});

	it('cuts the claim at the row cap', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'row-cap-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'row-cap-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'row-cap-c', 'c'.repeat(32))
		];
		const ordered = claimOrder(uploads);

		const batch = await currentServer().claimVerificationBatch(
			2,
			Number.MAX_SAFE_INTEGER
		);

		expect(batch).toStrictEqual({
			claims: ordered.slice(0, 2),
			truncated: true
		});
	});

	it('leases its claims against an overlapping pass', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'lease-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'lease-b', 'b'.repeat(32))
		];
		const ordered = claimOrder(uploads);

		// The first claim takes the whole backlog; a duplicate pass (the alarm
		// backstop's re-request, an overlapping cron) inside the lease window
		// must claim nothing rather than re-decode the same rows.
		const first = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);
		const duplicate = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		expect({ first, duplicate }).toStrictEqual({
			first: { claims: ordered, truncated: false },
			duplicate: { claims: [], truncated: false }
		});
	});

	it("frees a crashed pass's claims once the lease expires", async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(
			token,
			'lease-expiry',
			'a'.repeat(32)
		);
		const ordered = claimOrder([upload]);

		vi.useFakeTimers();

		try {
			vi.setSystemTime(testBase);

			const first = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs - 1));

			const fresh = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			vi.setSystemTime(new Date(testBase.getTime() + verifyClaimLeaseMs));

			const expired = await currentServer().claimVerificationBatch(
				10,
				Number.MAX_SAFE_INTEGER
			);

			expect({ first, fresh, expired }).toStrictEqual({
				first: { claims: ordered, truncated: false },
				fresh: { claims: [], truncated: false },
				expired: { claims: ordered, truncated: false }
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('leases only the rows the claim returned', async () => {
		const token = await initialise();
		const uploads = [
			await deferFreshUpload(token, 'scope-a', 'a'.repeat(32)),
			await deferFreshUpload(token, 'scope-b', 'b'.repeat(32)),
			await deferFreshUpload(token, 'scope-c', 'c'.repeat(32))
		];
		const ordered = claimOrder(uploads);
		const capForTwo = ordered
			.slice(0, 2)
			.reduce((total, claim) => total + claim.narSize, 0);

		// The byte cap cuts the third row (and the sentinel) out of the first
		// claim; they were not returned, so they stay unleased and the very next
		// claim picks them up.
		const first = await currentServer().claimVerificationBatch(10, capForTwo);
		const rest = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		expect({ first, rest }).toStrictEqual({
			first: { claims: ordered.slice(0, 2), truncated: true },
			rest: { claims: ordered.slice(2), truncated: false }
		});
	});

	it('keeps the cron pass off leased rows', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'cron-lease', 'a'.repeat(32));

		// The consumer holds the claim; the hourly cron crossing its pass must
		// leave the row alone rather than decode it a second time on the DO.
		await currentServer().claimVerificationBatch(10, Number.MAX_SAFE_INTEGER);
		await currentServer().runVerification();

		expect(await pendingUploadVerdict(upload.uploadId)).toBe('pending');
	});

	it('frees a re-driven row for the pass its client requests', async () => {
		const token = await initialise();
		const upload = await deferFreshUpload(token, 'redrive', 'a'.repeat(32));

		await currentServer().claimVerificationBatch(10, Number.MAX_SAFE_INTEGER);

		// A client re-driving its commit marks the row afresh; the dead pass's
		// lease must not make the re-drive's own verify pass wait it out.
		await runInDurableObject(currentServer(), (instance) => {
			new UploadStateService(instance.context).markUploadPending(
				upload.uploadId
			);
		});

		const reclaimed = await currentServer().claimVerificationBatch(
			10,
			Number.MAX_SAFE_INTEGER
		);

		expect(reclaimed).toStrictEqual({
			claims: claimOrder([upload]),
			truncated: false
		});
	});

	it('counts reuse rows as free against the byte cap', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-free');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		// Two more paths reuse the committed blob; deferring them leaves pending
		// rows pointing at the shared canonical key.
		const reuses = [];

		for (const storePathHash of ['b'.repeat(32), 'c'.repeat(32)]) {
			const metadata = uploadMetadata({
				name: `reuse-${storePathHash.slice(0, 1)}`,
				storePathHash,
				narHash: nar.narHash,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength,
				narSize: nar.narSize
			});
			const decision = expectSingleCommitDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);

			await markUploadPendingVerification(decision.uploadId);
			reuses.push({ uploadId: decision.uploadId });
		}

		// A byte cap of 1 admits every reuse row: they decode nothing.
		const batch = await currentServer().claimVerificationBatch(10, 1);

		expect(batch).toStrictEqual({
			claims: reuses
				.toSorted((left, right) => byCodeUnit(left.uploadId, right.uploadId))
				.map((reuse) => ({
					uploadId: reuse.uploadId,
					r2Key: narObjectKey(nar.narHash),
					narHash: nar.narHash,
					narSize: nar.narSize,
					reuse: true
				})),
			truncated: false
		});
	});
});
