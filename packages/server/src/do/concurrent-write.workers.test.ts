import { NarInfo } from '@cupboard/nix-store/narinfo';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	commitUpload,
	CommitVerdictError,
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

	it('reports one publisher for two concurrent commits of one path', async () => {
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

		const settled = await Promise.allSettled([
			commitUpload(token, first.uploadId),
			commitUpload(token, second.uploadId)
		]);
		const outcomes = settled.map((result) => {
			if (result.status === 'fulfilled') {
				return result.value;
			}
			expect(result.reason).toStrictEqual(new CommitVerdictError('absent'));
			return {
				storePathHash: metadata.storePathHash,
				narHash: metadata.narHash,
				status: 'already-present'
			};
		});
		expect({
			outcomes: outcomes.toSorted((left, right) =>
				left.status.localeCompare(right.status)
			),
			retry: await negotiateUploads(token, [metadata])
		}).toStrictEqual({
			outcomes: [
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
			],
			retry: {
				uploads: [
					{
						action: 'skip',
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					}
				]
			}
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

		const settled = await Promise.allSettled(
			Array.from({ length: 4 }, () => pushPath(token, metadata))
		);
		for (const result of settled) {
			if (result.status === 'rejected') {
				expect(result.reason).toStrictEqual(new CommitVerdictError('absent'));
			}
		}
		expect(await negotiateUploads(token, [metadata])).toStrictEqual({
			uploads: [
				{
					action: 'skip',
					storePathHash: metadata.storePathHash,
					narHash: metadata.narHash
				}
			]
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
