import { NarInfo } from '@cupboard/nix-store/narinfo';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	commitUpload,
	expectSingleUploadDecision,
	expectStats,
	initialise,
	narBytes,
	negotiateUploads,
	pushPath,
	putNarBytes,
	readStoredNarInfo,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

describe('concurrent writes', () => {
	beforeEach(resetTestServer);

	it('settles two concurrent commits of one path, both reporting success', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const first = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		const second = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);

		await putNarBytes(first.r2Key);
		await putNarBytes(second.r2Key);

		// Only one commit materialises the path. The other can report `committed` if
		// it waits for the shared verdict, or `already-present` if the first commit
		// settles before the second frame is processed. Both statuses are successful;
		// the final accounting must still contain one path and one blob charge.
		const settled = await Promise.all([
			commitUpload(token, first.uploadId),
			commitUpload(token, second.uploadId)
		]);
		const statuses = settled.map((outcome) => outcome.status);

		expect({
			paths: settled.map((outcome) => ({
				storePathHash: outcome.storePathHash,
				narHash: outcome.narHash
			})),
			allSettled: statuses.every(
				(status) => status === 'committed' || status === 'already-present'
			),
			anyCommitted: statuses.includes('committed')
		}).toStrictEqual({
			paths: [
				{ storePathHash: metadata.storePathHash, narHash: metadata.narHash },
				{ storePathHash: metadata.storePathHash, narHash: metadata.narHash }
			],
			allSettled: true,
			anyCommitted: true
		});

		const stored = await readStoredNarInfo(metadata.storePathHash);

		expect(NarInfo.parse(stored.body).narHash.toString()).toBe(
			metadata.narHash
		);
		await expectStats(token, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
	});

	it('settles four concurrent pushes of one path to a single committed row', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		await Promise.all(
			Array.from({ length: 4 }, () => pushPath(token, metadata))
		);

		const stored = await readStoredNarInfo(metadata.storePathHash);

		expect(NarInfo.parse(stored.body).narHash.toString()).toBe(
			metadata.narHash
		);
		await expectStats(token, {
			storePaths: 1,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
	});

	it('commits two distinct paths sharing one NAR to two rows and one blob', async () => {
		const token = await initialise();
		const first = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'first',
			storePathHash: 'a'.repeat(32)
		});
		const second = uploadMetadata({
			fileSize: narBytes.byteLength,
			name: 'second',
			storePathHash: 'b'.repeat(32)
		});

		await Promise.all([pushPath(token, first), pushPath(token, second)]);

		await expectStats(token, {
			storePaths: 2,
			narBlobs: 1,
			pendingUploads: 0,
			totalFileSize: narBytes.byteLength
		});
	});
});
