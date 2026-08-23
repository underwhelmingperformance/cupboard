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

// An inline reuse commit returns `settled` through the commit pipeline.
// `notifyUploadWaiters` must not send a `verdict` to that session first.
describe('inline reuse commit', () => {
	beforeEach(resetTestServer);

	it('sends settled as the first frame to the committing session', async () => {
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
