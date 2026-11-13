import {
	type CommitSessionFrame,
	type CommitSessionRequestInput,
	sessionIdSchema,
	type UploadId,
	type UploadPathMetadata
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import { pendingUploads } from '../db/schema.ts';
import {
	closeSessionAndWait,
	type CommitConversation,
	currentServer,
	expectSingleUploadDecision,
	initialise,
	markUploadPendingVerification,
	namedCache,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	putTestCache,
	resetTestServer,
	uploadMetadata,
	verifiableNar,
	verifyCurrentTenant
} from '../test-support.ts';

// Returns the frames that the session receives before the server answers a
// barrier message. A socket delivers frames in the order that the server sent
// them, so the list contains every frame sent before the server handled the
// barrier.
async function framesBeforeBarrier(
	session: CommitConversation
): Promise<object[]> {
	session.socket.send(JSON.stringify({ op: 'test-barrier' }));
	const frames: object[] = [];

	for (;;) {
		const frame = await session.nextFrame();

		if (frame.ev === 'unsupported' && frame.op === 'test-barrier') {
			return frames;
		}

		frames.push(frameFacts(frame));
	}
}

// Error frames are compared without their message text.
function frameFacts(frame: CommitSessionFrame): object {
	if (frame.ev !== 'error') {
		return frame;
	}

	return { ev: frame.ev, uploadId: frame.uploadId, status: frame.status };
}

function sessionRequest(
	op: 'subscribe' | 'subscribe-identity' | 'commit' | 'commit-batch',
	uploadId: UploadId,
	metadata: UploadPathMetadata
): CommitSessionRequestInput {
	const entry = {
		uploadId,
		storePathHash: metadata.storePathHash,
		narHash: metadata.narHash
	};

	switch (op) {
		case 'subscribe': {
			return { op, uploadIds: [uploadId] };
		}
		case 'subscribe-identity': {
			return { op, entries: [entry] };
		}
		case 'commit': {
			return { op, uploadId };
		}
		case 'commit-batch': {
			return { op, commits: [entry] };
		}
	}
}

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

		await verifyCurrentTenant();

		secondSession.socket.send(JSON.stringify({ op: 'test-barrier' }));
		const afterVerification = await secondSession.nextFrame();
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
			afterVerification
		}).toStrictEqual({
			uploadGone: true,
			afterVerification: { ev: 'unsupported', op: 'test-barrier' }
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

		await verifyCurrentTenant();
		const verdict = await second.nextFrame();
		second.socket.close();
		first.socket.close();

		expect(verdict).toStrictEqual({
			ev: 'verdict',
			uploadId: upload.uploadId,
			status: 'servable'
		});
	});

	it.each([
		{ op: 'commit' as const, status: StatusCodes.BAD_REQUEST },
		{ op: 'commit-batch' as const, status: StatusCodes.BAD_REQUEST },
		{ op: 'subscribe' as const, status: StatusCodes.NOT_FOUND },
		{ op: 'subscribe-identity' as const, status: StatusCodes.NOT_FOUND }
	])(
		'keeps the verdict with the subscribed session after $op from a session of another cache',
		async ({ op, status }) => {
			const token = await initialise();
			const other = namedCache('other');
			await putTestCache(token, other);
			const nar = await verifiableNar('session-other-cache');
			const metadata = uploadMetadata({
				name: 'other-cache',
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const { uploadId, r2Key } = expectSingleUploadDecision(
				await negotiateUploads(token, [metadata]),
				metadata
			);
			await putNarBytes(r2Key, nar);
			await markUploadPendingVerification(uploadId);

			const sessions: CommitConversation[] = [];

			try {
				const owner = await openCommitSession(token);
				sessions.push(owner);
				const intruder = await openCommitSession(token, other);
				sessions.push(intruder);

				owner.send({ op: 'subscribe', uploadIds: [uploadId] });
				const replay = await owner.nextFrame();
				intruder.send(sessionRequest(op, uploadId, metadata));
				const refusal = frameFacts(await intruder.nextFrame());

				await verifyCurrentTenant();

				expect({
					replay,
					refusal,
					owner: await framesBeforeBarrier(owner),
					intruder: await framesBeforeBarrier(intruder)
				}).toStrictEqual({
					replay: {
						ev: 'deferred',
						uploadId,
						storePathHash: metadata.storePathHash,
						narHash: metadata.narHash
					},
					refusal: { ev: 'error', uploadId, status },
					owner: [{ ev: 'verdict', uploadId, status: 'servable' }],
					intruder: []
				});
			} finally {
				await Promise.all(
					sessions.map((session) => closeSessionAndWait(session.socket))
				);
			}
		}
	);
});
