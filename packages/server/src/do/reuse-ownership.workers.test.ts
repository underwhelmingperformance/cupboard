import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	blobReferenceRows,
	commitPath,
	CommitSocketError,
	commitUploadRejection,
	currentNarObjectKey,
	deletePath,
	expectSingleCommitDecision,
	expectSingleUploadDecision,
	initialise,
	negotiateUploads,
	resetTestServer,
	tenantBlobRows,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

function expectCommitSocketError(
	error: unknown
): asserts error is CommitSocketError {
	expect(error).toBeInstanceOf(CommitSocketError);
}

// A reuse commit relies on the tenant's existing presence edge instead of
// uploading the bytes again. If deletion removes that edge after negotiation,
// commit must fail so the client negotiates a fresh upload.
describe('reuse commit ownership', () => {
	beforeEach(resetTestServer);

	it('fails a reuse whose presence edge was credited back', async () => {
		const token = await initialise();
		const nar = await verifiableNar('reuse-ownership');
		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		const second = uploadMetadata({
			name: 'second',
			storePathHash: 'b'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});
		const reuse = expectSingleCommitDecision(
			await negotiateUploads(token, [second]),
			second
		);

		// The delete retires the tenant's only reference to the hash, crediting
		// the presence edge back. The canonical object survives on the reaper's
		// grace, so the reuse's blob probe alone would still pass.
		await deletePath(token, first.storePathHash);

		const commitError = await commitUploadRejection(token, reuse.uploadId);

		expectCommitSocketError(commitError);

		expectSingleUploadDecision(await negotiateUploads(token, [second]), second);

		expect({
			error: { name: commitError.name, status: commitError.status },
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			canonicalPresent:
				(await env.BLOBS.head(await currentNarObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			error: { name: 'CommitSocketError', status: StatusCodes.NOT_FOUND },
			edges: [],
			presence: [],
			canonicalPresent: true
		});
	});
});
