import { beforeEach, describe, expect, it } from 'vitest';

import {
	commitPath,
	expectSingleCommitDecision,
	initialise,
	negotiateUploads,
	openCommitSession,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// An inline reuse commit must not send a spurious `verdict` frame to the
// committing session. The committing session receives `settled` via the normal
// commit-pipeline return path; if `notifyUploadWaiters` also fires toward the
// same socket, the session sees an unexpected extra frame.
describe('inline reuse commit does not spuriously notify the committing session', () => {
	beforeEach(resetTestServer);

	it('the committing session receives exactly a settled frame, not a preceding verdict', async () => {
		const token = await initialise();
		const nar = await verifiableNar('deferred-waiter-no-spurious');

		const first = uploadMetadata({
			name: 'first',
			storePathHash: 'a'.repeat(32),
			narHash: nar.narHash,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength,
			narSize: nar.narSize
		});

		await commitPath(token, first, nar);

		// A second store path reuses the same blob, so its commit runs inline.
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

		// Open a session and commit. The session must receive a `settled` frame
		// directly (no preceding `deferred`), because the inline commit path
		// materialises without deferring. A spurious `verdict` before `settled`
		// would appear here as the first frame.
		const session = await openCommitSession(token);
		session.send({ op: 'commit', uploadId: reuse.uploadId });
		const firstFrame = await session.nextFrame();
		session.socket.close();

		expect(firstFrame).toStrictEqual({
			ev: 'settled',
			uploadId: reuse.uploadId,
			response: {
				storePathHash: second.storePathHash,
				narHash: second.narHash,
				status: 'committed'
			}
		});
	});
});
