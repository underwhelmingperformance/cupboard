import type { UploadPathMetadataFields } from '@cupboard/shared';
import { NarInfo } from '@cupboard/shared';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	authorisedFetch,
	commitUpload,
	expectStats,
	initialise,
	narBytes,
	negotiateUploads,
	pushPath,
	putNarBytes,
	readStoredNarInfo,
	resetTestServer,
	singleDecision,
	uploadBlobMetadata,
	uploadMetadata
} from './test-support.ts';

async function prepare(
	token: string,
	uploadId: string,
	metadata: UploadPathMetadataFields
): Promise<void> {
	const response = await authorisedFetch(`/uploads/${uploadId}`, token, {
		body: JSON.stringify(uploadBlobMetadata(metadata)),
		headers: { 'content-type': 'application/json' },
		method: 'PUT'
	});

	expect(response.status).toBe(StatusCodes.OK);
}

describe('concurrent writes', () => {
	beforeEach(resetTestServer);

	it('commits one of two concurrent commits and reports the other as already present', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });

		const first = singleDecision(await negotiateUploads(token, [metadata]));
		const second = singleDecision(await negotiateUploads(token, [metadata]));

		// No blob row exists during negotiation, so both are upload decisions.
		if (first.action !== 'upload' || second.action !== 'upload') {
			throw new Error('expected two upload decisions');
		}

		await prepare(token, first.uploadId, metadata);
		await putNarBytes(first.r2Key);
		await prepare(token, second.uploadId, metadata);

		const [a, b] = await Promise.all([
			commitUpload(token, first.uploadId),
			commitUpload(token, second.uploadId)
		]);

		expect(
			[a, b].toSorted((left, right) => left.status.localeCompare(right.status))
		).toStrictEqual([
			{
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			},
			{
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'committed'
			}
		]);

		const stored = await readStoredNarInfo(metadata.storePathHash);

		expect(NarInfo.parse(stored.body).narHash).toBe(metadata.narHash);
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

		expect(NarInfo.parse(stored.body).narHash).toBe(metadata.narHash);
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
