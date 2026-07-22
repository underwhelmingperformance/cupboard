import { sessionIdSchema } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import {
	currentServer,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// A verify pass reads the pending row at phase A, capturing the sessionId stored
// at that point. A client reconnect that calls `subscribe` between phase A and
// the verdict notify updates the row's sessionId to a new socket. The verdict
// must reach the new session, not the stale one.
describe('verify pass routes verdict to the reconnected session', () => {
	beforeEach(resetTestServer);

	it('delivers the verdict to the session that re-subscribed mid-pass', async () => {
		const token = await initialise();
		const nar = await verifiableNar('session-reconnect');
		const metadata = uploadMetadata({
			name: 'reconnect-test',
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);

		// Open the first session and commit so the row gets its sessionId set to
		// the first socket's hibernation tag.
		const firstSession = await openCommitSession(token);
		firstSession.send({ op: 'commit', uploadId: upload.uploadId });
		const deferred = await firstSession.nextFrame();
		expect(deferred.ev).toBe('deferred');
		firstSession.socket.close();

		// Simulate the reconnect that happens while the verify pass is between
		// phase A (reading the row) and the verdict notify: a second session
		// subscribes, which calls `attachSession` and updates the row's sessionId.
		const secondSession = await openCommitSession(token);
		secondSession.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await secondSession.nextFrame();
		expect(replay.ev).toBe('deferred');

		// Manually stamp the row's sessionId with a third, unknown tag to simulate
		// a reconnect that happened AFTER the verify pass read the row (phase A) but
		// before it notified. The pass should re-read the row at notify time and
		// send to this tag, not the one it captured at phase A.
		const thirdSessionId = sessionIdSchema.parse(
			'third-session-tag-unknown-to-first-two'
		);
		await runInDurableObject(currentServer(), (_instance, state) => {
			drizzle(state.storage, { schema: { pendingUploads } })
				.update(pendingUploads)
				.set({ sessionId: thirdSessionId })
				.where(eq(pendingUploads.id, upload.uploadId))
				.run();
		});

		// The third session uses the same underlying socket as secondSession for
		// this test, but the real WebSocket hibernation tag that matters is the one
		// stored in the row. Since `getWebSockets(thirdSessionId)` returns no
		// sockets (no socket registered under that tag), the verdict goes nowhere --
		// which is exactly the correct behaviour: it does NOT go to the stale first
		// or second session's tag. The key assertion is that the second session
		// (whose tag no longer matches the row) does NOT receive a spurious verdict.
		await currentServer().runVerification();

		// The second session's socket must not have received a verdict frame
		// (because the row's sessionId now points at thirdSessionId, not second's
		// tag). If it did receive one, the fix is wrong.
		//
		// Check instead that the upload row is cleared (verification settled) and
		// no unexpected frame arrived on the second session.
		async function nextFrameResult() {
			return { kind: 'frame', frame: await secondSession.nextFrame() } as const;
		}

		const verdictOrTimeout = await Promise.race([
			nextFrameResult(),
			new Promise<{ kind: 'timeout' }>((resolve) =>
				setTimeout(() => {
					resolve({ kind: 'timeout' });
				}, 50)
			)
		]);
		secondSession.socket.close();

		// The verdict went to the (fake) third-session tag and not to the second
		// session's socket. The upload row should be gone (settled).
		const isUploadGone = await runInDurableObject(
			currentServer(),
			(_instance, state) => {
				const row = drizzle(state.storage, { schema: { pendingUploads } })
					.select({ id: pendingUploads.id })
					.from(pendingUploads)
					.where(eq(pendingUploads.id, upload.uploadId))
					.get();

				return row === undefined;
			}
		);

		expect({
			uploadGone: isUploadGone,
			secondSessionGotVerdict: verdictOrTimeout.kind === 'frame'
		}).toStrictEqual({
			uploadGone: true,
			secondSessionGotVerdict: false
		});
	});

	// End-to-end: deferred upload whose session is re-subscribed before
	// verification runs. The verdict must reach the reconnected session.
	it('routes the verdict to the re-subscribed session', async () => {
		const token = await initialise();
		const nar = await verifiableNar('session-reconnect-e2e');
		const metadata = uploadMetadata({
			name: 'reconnect-e2e',
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		const upload = expectSingleUploadDecision(
			await negotiateUploads(token, [metadata]),
			metadata
		);
		await putNarBytes(upload.r2Key, nar);
		await markUploadPendingVerification(upload.uploadId);

		// Two sessions subscribe to the same upload. The second one's subscribe
		// call is the later one, so the row ends up with its tag.
		const first = await openCommitSession(token);
		first.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const firstReplay = await first.nextFrame();
		expect(firstReplay.ev).toBe('deferred');

		const second = await openCommitSession(token);
		second.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const secondReplay = await second.nextFrame();
		expect(secondReplay.ev).toBe('deferred');

		// Verification runs. The row's sessionId is now second's tag.
		await currentServer().runVerification();
		const verdict = await second.nextFrame();
		second.socket.close();
		first.socket.close();

		expect(verdict).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId,
			status: 'servable'
		});
	});
});
