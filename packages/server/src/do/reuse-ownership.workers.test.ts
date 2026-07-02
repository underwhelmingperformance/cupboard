import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { narObjectKey } from '../http/http.ts';
import {
	blobReferenceRows,
	commitPath,
	CommitSocketError,
	commitUploadRejection,
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

// A reuse commit binds a narinfo to bytes the tenant never re-proves, on the
// strength of its presence edge for the hash. With the edge credited back by a
// delete between negotiate and commit, the commit must fail towards re-upload
// rather than re-reference a hash the tenant no longer holds.
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

		// The refused commit leaves no residue, and a fresh negotiate offers an
		// upload: with no presence edge the reuse shortcut is gone, exactly what
		// the client needs to re-prove the bytes.
		expectSingleUploadDecision(await negotiateUploads(token, [second]), second);

		expect({
			error: { name: commitError.name, status: commitError.status },
			edges: await blobReferenceRows(),
			presence: await tenantBlobRows(),
			canonicalPresent:
				(await env.BLOBS.head(narObjectKey(nar.narHash))) !== null
		}).toStrictEqual({
			error: { name: 'CommitSocketError', status: StatusCodes.NOT_FOUND },
			edges: [],
			presence: [],
			canonicalPresent: true
		});
	});
});
