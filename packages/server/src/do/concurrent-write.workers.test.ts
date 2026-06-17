import { NarInfo } from '@cupboard/nix/narinfo';
import type { ParsedUploadPathMetadata } from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
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
	uploadBlobMetadata,
	uploadMetadata
} from '../test-support.ts';

async function prepare(
	token: string,
	uploadId: string,
	metadata: ParsedUploadPathMetadata
): Promise<void> {
	const response = await authorisedFetch(
		`/cache/_default/uploads/${uploadId}`,
		token,
		{
			body: JSON.stringify(uploadBlobMetadata(metadata)),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);

	expect(response.status).toBe(StatusCodes.OK);
}

describe('concurrent writes', () => {
	beforeEach(resetTestServer);

	it('settles two concurrent commits of one path, both reporting committed', async () => {
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

		await prepare(token, first.uploadId, metadata);
		await putNarBytes(first.r2Key);
		await prepare(token, second.uploadId, metadata);
		await putNarBytes(second.r2Key);

		// Both commits defer (neither sees a committed reference yet), so both park
		// on their sockets and hear the verdict of the single materialisation.
		const settled = await Promise.all([
			commitUpload(token, first.uploadId),
			commitUpload(token, second.uploadId)
		]);

		expect(settled).toStrictEqual([
			{
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'committed'
			},
			{
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'committed'
			}
		]);

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
