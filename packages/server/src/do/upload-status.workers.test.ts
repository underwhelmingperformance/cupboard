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

// A deferred upload's status is derived from the durable per-upload verdict: it
// reports `pending` while the background pass works and retains the terminal
// `mismatch` and `over-quota` verdicts. A settled upload leaves no residue, so
// its status reads `absent` and servability is observed at the narinfo itself.

// Stages a deferred upload (negotiate, upload, mark pending) and returns its
// uploadId, the state every fresh upload reaches before the background pass
// runs.
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

	it('reports pending, then clears the settled upload once the path serves', async () => {
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
		expect(
			await uploadStatus(
				uploadIdSchema.parse('00000000-0000-0000-0000-000000000000')
			)
		).toBe('absent');
	});
});
