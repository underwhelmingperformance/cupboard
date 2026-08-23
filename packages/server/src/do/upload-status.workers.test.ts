import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type NixSha256HashString,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import { type UploadId, uploadIdSchema } from '@cupboard/protocol/upload';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	clearBlobStorage,
	currentServer,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	provisionFixtureTenant,
	putNarBytes,
	readStoredNarInfo,
	resetTestServer,
	testBase,
	uploadMetadata,
	uploadStatus,
	verifiableNar
} from '../test-support.ts';

async function stageDeferred(nar: {
	readonly narHash: NixSha256HashString;
	readonly narSize: number;
	readonly fileHash: NixSha256HashString;
	readonly narBytes: Uint8Array;
}): Promise<UploadId> {
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

	await putNarBytes(upload.r2Key, nar);
	await markUploadPendingVerification(upload.uploadId);

	return upload.uploadId;
}

describe('deferred upload status', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('reports pending during verification and absent after materialisation', async () => {
		const nar = await verifiableNar('status-servable');
		const uploadId = await stageDeferred(nar);

		const whilePending = await uploadStatus(uploadId);
		await currentServer().runVerification();
		const afterVerify = await uploadStatus(uploadId);
		const stored = await readStoredNarInfo(
			storePathHashSchema.parse('a'.repeat(32))
		);

		expect({
			whilePending,
			afterVerify,
			servedNarHash: NarInfo.parse(stored.body).narHash.toString()
		}).toStrictEqual({
			whilePending: 'pending',
			afterVerify: 'absent',
			servedNarHash: nar.narHash
		});
	});

	it('retains a mismatch after background NAR verification fails', async () => {
		const good = await verifiableNar('status-good');
		const wrong = await verifiableNar('status-wrong');
		// The compressed bytes pass file-hash integrity but decode to a different NAR.
		// This isolates the background NAR-hash check.
		const uploadId = await stageDeferred({
			narHash: good.narHash,
			narSize: good.narSize,
			fileHash: wrong.fileHash,
			narBytes: wrong.narBytes
		});

		await currentServer().runVerification();

		expect(await uploadStatus(uploadId)).toBe('mismatch');
	});

	it('retains over-quota when the canonical size exceeds the tenant quota', async () => {
		const nar = await verifiableNar('status-over');
		const uploadId = await stageDeferred(nar);
		await provisionFixtureTenant({ quotaBytes: nar.narBytes.byteLength - 1 });

		await currentServer().runVerification();

		expect(await uploadStatus(uploadId)).toBe('over-quota');
	});

	it('reports absent for an unknown upload', async () => {
		expect(
			await uploadStatus(
				uploadIdSchema.parse('00000000-0000-0000-0000-000000000000')
			)
		).toBe('absent');
	});
});
