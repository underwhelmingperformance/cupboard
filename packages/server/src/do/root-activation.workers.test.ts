import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { narInfoObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	clearBlobStorage,
	deleteBlobState,
	expectSingleUploadDecision,
	initialise,
	listRoots,
	markUploadPendingVerification,
	narBytes,
	negotiateUploads,
	prepareUpload,
	pushPath,
	putNarBytes,
	resetTestServer,
	setRoot,
	testBase,
	uploadMetadata
} from '../test-support.ts';

// A retention root must never advertise a path that is not yet substitutable.
// Activation gates each target on the same predicate the read path serves on: the
// materialised narinfo R2 object exists, repairing a merely-lost object first. A
// pending or demoted target is rejected, and `present` reflects that same predicate.

describe('root activation gating', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(testBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('refuses to root a path whose upload is still pending verification', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await prepareUpload(token, upload, metadata);
		await putNarBytes(upload.r2Key);
		// Deferred to the background pass: staged and pending, never yet servable.
		await markUploadPendingVerification(upload.uploadId);

		const response = await authorisedFetch(
			'/cache/_default/roots/main',
			token,
			{
				body: JSON.stringify({ targets: [metadata.storePath] }),
				headers: { 'content-type': 'application/json' },
				method: 'PUT'
			}
		);
		const { roots } = await listRoots(token);

		expect({ status: response.status, roots }).toStrictEqual({
			status: StatusCodes.CONFLICT,
			roots: []
		});
	});

	it('accepts a root whose narinfo object is missing but repairable', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		// Lose only the materialised object: the row and the shared blob remain, so
		// the path is still servable once the object is re-materialised.
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		const summary = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});
		const repaired = await env.BLOBS.head(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);

		expect({
			targets: summary.targets,
			repaired: repaired !== null
		}).toStrictEqual({
			targets: [
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: true
				}
			],
			repaired: true
		});
	});

	it('reports present false for a rooted path whose blob was demoted', async () => {
		const token = await initialise();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(token, metadata);
		const original = await setRoot(token, {
			name: 'main',
			targets: [metadata.storePath]
		});

		// Demote: drop the shared fact and the materialised object, leaving the
		// narinfo row. The row exists, but the path is no longer servable.
		await deleteBlobState(metadata.narHash);
		await env.BLOBS.delete(
			narInfoObjectKey(fixtureTenant, metadata.storePathHash)
		);
		const { roots } = await listRoots(token);

		expect({
			whenRooted: original.targets,
			afterDemote: roots
		}).toStrictEqual({
			whenRooted: [
				{
					storePathHash: metadata.storePathHash,
					storePath: metadata.storePath,
					present: true
				}
			],
			afterDemote: [
				{
					name: 'main',
					expired: false,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					targets: [
						{
							storePathHash: metadata.storePathHash,
							storePath: metadata.storePath,
							present: false
						}
					]
				}
			]
		});
	});
});
