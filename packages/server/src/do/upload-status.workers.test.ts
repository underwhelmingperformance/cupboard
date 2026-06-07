import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearBlobStorage,
	currentServer,
	deleteTestBase,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	prepareUpload,
	provisionFixtureTenant,
	putNarBytes,
	resetTestServer,
	uploadMetadata,
	uploadStatus,
	verifiableNar
} from '../test-support.ts';

// `push --wait` polls a deferred upload's status by its uploadId. The status is
// derived from the durable per-upload verdict, so it reports `pending` while the
// background pass works and then the terminal `servable`, `mismatch` or `over-quota`.

// Stages a deferred upload (negotiate, prepare, upload, mark pending) and returns
// its uploadId, the state a too-large-to-verify-inline upload reaches before the
// background pass runs.
async function stageDeferred(nar: {
	readonly narHash: string;
	readonly narSize: number;
	readonly fileHash: string;
	readonly narBytes: Uint8Array;
}): Promise<string> {
	const metadata = uploadMetadata({
		storePathHash: 'a'.repeat(32),
		references: [],
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	const token = await initialise();
	const upload = expectSingleUploadDecision(
		await negotiateUploads(token, [metadata]),
		metadata
	);

	await prepareUpload(token, upload, metadata);
	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);

	return upload.uploadId;
}

describe('deferred upload status', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(deleteTestBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reports pending then servable across the background pass', async () => {
		const nar = await verifiableNar('status-servable');
		const uploadId = await stageDeferred(nar);

		const whilePending = await uploadStatus(uploadId);
		await currentServer().runVerification();
		const afterVerify = await uploadStatus(uploadId);

		expect({ whilePending, afterVerify }).toStrictEqual({
			whilePending: 'pending',
			afterVerify: 'servable'
		});
	});

	it('reports mismatch when the background NAR-hash check fails', async () => {
		const good = await verifiableNar('status-good');
		const wrong = await verifiableNar('status-wrong');
		// Bytes whose checksum matches the declared fileHash but which decompress to a
		// different NAR than the declared hash: a background mismatch.
		const uploadId = await stageDeferred({
			narHash: good.narHash,
			narSize: good.narSize,
			fileHash: wrong.fileHash,
			narBytes: wrong.narBytes
		});

		await currentServer().runVerification();

		expect(await uploadStatus(uploadId)).toBe('mismatch');
	});

	it('reports over-quota when the canonical size exceeds the quota', async () => {
		const nar = await verifiableNar('status-over');
		const uploadId = await stageDeferred(nar);
		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength - 1 });

		await currentServer().runVerification();

		expect(await uploadStatus(uploadId)).toBe('over-quota');
	});

	it('reports absent for an unknown upload', async () => {
		expect(await uploadStatus('00000000-0000-0000-0000-000000000000')).toBe(
			'absent'
		);
	});
});
