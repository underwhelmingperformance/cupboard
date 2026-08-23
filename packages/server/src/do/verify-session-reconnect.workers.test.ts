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

// Verification can await after reading a pending row. A concurrent `subscribe`
// can update `sessionId` during those awaits, so notification must re-read the
// row and use the current session.
describe('verification sends verdicts only to the current session', () => {
	beforeEach(resetTestServer);

	it("does not send a verdict to the previous session after the pending row's session id changes", async () => {
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

		const firstSession = await openCommitSession(token);
		firstSession.send({ op: 'commit', uploadId: upload.uploadId });
		const deferred = await firstSession.nextFrame();
		expect(deferred.ev).toBe('deferred');
		firstSession.socket.close();

		const secondSession = await openCommitSession(token);
		secondSession.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const replay = await secondSession.nextFrame();
		expect(replay.ev).toBe('deferred');

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

		await currentServer().runVerification();

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

		const first = await openCommitSession(token);
		first.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const firstReplay = await first.nextFrame();
		expect(firstReplay.ev).toBe('deferred');

		const second = await openCommitSession(token);
		second.send({ op: 'subscribe', uploadIds: [upload.uploadId] });
		const secondReplay = await second.nextFrame();
		expect(secondReplay.ev).toBe('deferred');

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
