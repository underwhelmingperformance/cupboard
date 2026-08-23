import { startCapture } from '@cupboard/logger/testing';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearBlobStorage,
	initialise,
	negotiateUploads,
	resetTestServer,
	runGcResult,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// A push credential is scoped to `staging/<pushId>/`, so a client may write keys
// beneath it that it never negotiated. The negotiated keys have pending rows the
// reaper owns; reconciliation reclaims the rest once they age past the upload
// grace. The harness fakes `Date` at a fixed epoch but R2 stamps
// `R2Object.uploaded` from the real wall clock, so these tests read the real time
// back from a probe object and move the garbage collector's clock relative to it.

const uploadGraceMs = 15 * 60 * 1000;

async function realUploadInstant(): Promise<number> {
	await env.BLOBS.put('probe/now', new Uint8Array([0]));
	const head = await env.BLOBS.head('probe/now');
	await env.BLOBS.delete('probe/now');

	if (head === null) {
		throw new Error('probe object vanished');
	}

	return head.uploaded.getTime();
}

describe('orphan staging reconciliation', () => {
	beforeEach(async () => {
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reclaims an un-negotiated staging object and spares the negotiated one', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		const token = await initialise();
		const nar = await verifiableNar('orphan-tracked');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});

		const negotiation = await negotiateUploads(token, [metadata]);
		const decision = negotiation.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision for a fresh nar');
		}

		const trackedKey = decision.r2Key;
		const pushPrefix = trackedKey.slice(0, trackedKey.lastIndexOf('/') + 1);
		const orphanKey = `${pushPrefix}un-negotiated.nar.zst`;

		await env.BLOBS.put(trackedKey, nar.narBytes);
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			trackedPresent: (await env.BLOBS.head(trackedKey)) !== null,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({
			orphanStagingDeleted: 1,
			trackedPresent: true,
			orphanPresent: false
		});
	});

	it('spares an untracked staging object still within the upload grace', async () => {
		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + 60_000));

		const orphanKey = 'staging/recent-push/recent.nar.zst';
		await env.BLOBS.put(orphanKey, new Uint8Array([1, 2, 3]));

		const result = await runGcResult();

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			orphanPresent: (await env.BLOBS.head(orphanKey)) !== null
		}).toStrictEqual({ orphanStagingDeleted: 0, orphanPresent: true });
	});

	it('caps the reclaim per run and leaves the overflow for the next run', async () => {
		const perRunCap = 1000;
		const total = perRunCap + 1;

		const realNow = await realUploadInstant();
		vi.setSystemTime(new Date(realNow + uploadGraceMs + 5 * 60 * 1000));

		await Promise.all(
			Array.from({ length: total }, (_unused, index) =>
				env.BLOBS.put(
					`staging/flood/${String(index)}.nar.zst`,
					new Uint8Array([1])
				)
			)
		);

		const capture = startCapture();

		let result;
		try {
			result = await runGcResult();
		} finally {
			capture.stop();
		}

		const remaining = await env.BLOBS.list({ prefix: 'staging/flood/' });

		expect({
			orphanStagingDeleted: result.orphanStagingDeleted,
			remaining: remaining.objects.length,
			warnedAboutCap: capture.logs.some(
				(entry) =>
					entry.message === 'orphan staging reclaim hit the per-run cap'
			)
		}).toStrictEqual({
			orphanStagingDeleted: perRunCap,
			remaining: total - perRunCap,
			warnedAboutCap: true
		});
	});
});
