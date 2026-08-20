import { DEFAULT_CACHE, WIRE_DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { commitAcceptCapabilitiesHeader } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	commitSocketCeiling,
	maxUncreditedCommitSessions
} from '../policy/commit-sockets.ts';
import {
	authorisedFetch,
	type CommitConversation,
	commitCreditAccept,
	commitSessionFromResponse,
	currentServer,
	initialise,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

// The D1 overload text the binding injects when it sheds load. Only this test
// file and the detection helper in transient.ts ever reference this text; the
// detection helper is the single location that matches on message text.
const d1OverloadText =
	'D1_ERROR: D1 DB is overloaded. Too many requests queued.';

describe('commit socket overload handling', () => {
	beforeEach(resetTestServer);

	it('answers a commit whose D1 charge batch hits an overload with a 503 error frame', async () => {
		const token = await initialise();
		const path = uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 });
		const negotiated = await negotiateUploads(token, [path]);
		const decision = negotiated.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		const { uploadId, r2Key } = decision;
		await putNarBytes(r2Key);

		// Make every D1 batch call throw the overload message so the commit
		// pipeline's charge batch faults with the D1 signal.
		const batchSpy = vi
			.spyOn(env.CUPBOARD_DB, 'batch')
			.mockRejectedValue(new Error(d1OverloadText));

		try {
			const session = await openCommitSession(token);
			session.send({ op: 'commit', uploadId });
			const frame = await session.nextFrame();
			session.socket.close();

			expect(frame).toStrictEqual({
				ev: 'error',
				uploadId,
				status: StatusCodes.SERVICE_UNAVAILABLE,
				message: 'Database is temporarily overloaded'
			});
		} finally {
			batchSpy.mockRestore();
		}
	});
});

async function openSessions(
	token: string,
	count: number,
	accepted?: string
): Promise<CommitConversation[]> {
	const sessions: CommitConversation[] = [];

	for (let index = 0; index < count; index += 1) {
		sessions.push(await openCommitSession(token, DEFAULT_CACHE, accepted));
	}

	return sessions;
}

function closeAll(sessions: readonly CommitConversation[]): void {
	for (const session of sessions) {
		session.socket.close();
	}
}

function attemptUpgrade(token: string, accepted?: string): Promise<Response> {
	return authorisedFetch(`/cache/${WIRE_DEFAULT_CACHE}/commit`, token, {
		headers: {
			upgrade: 'websocket',
			...(accepted !== undefined && {
				[commitAcceptCapabilitiesHeader]: accepted
			})
		}
	});
}

async function liveSocketCount(): Promise<number> {
	return runInDurableObject(
		currentServer(),
		(_instance, state) => state.getWebSockets().length
	);
}

// The ceiling the test environment binds, well below the deployed one so a
// suite can reach it with a handful of sockets.
const ceiling = commitSocketCeiling(env);

describe('commit socket ceiling', () => {
	beforeEach(resetTestServer);

	it('accepts sessions up to the ceiling and refuses the next upgrade retryably', async () => {
		const token = await initialise();
		const sessions = await openSessions(token, ceiling, commitCreditAccept);

		const refused = await attemptUpgrade(token, commitCreditAccept);

		expect({
			accepted: sessions.length,
			status: refused.status,
			retryAfter: refused.headers.get('retry-after'),
			cacheControl: refused.headers.get('cache-control')
		}).toStrictEqual({
			accepted: ceiling,
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			cacheControl: 'no-store'
		});

		closeAll(sessions);
	});

	it('frees a place once a session closes', async () => {
		const token = await initialise();
		const [first, ...rest] = await openSessions(
			token,
			ceiling,
			commitCreditAccept
		);

		if (first === undefined) {
			throw new Error('expected an open session');
		}

		first.socket.close();
		await vi.waitFor(async () => {
			expect(await liveSocketCount()).toBe(ceiling - 1);
		});

		const reopened = await openCommitSession(
			token,
			DEFAULT_CACHE,
			commitCreditAccept
		);

		closeAll([reopened, ...rest]);
	});

	// A session that does not negotiate credit sends as fast as it likes, so the
	// tenant holds only a few of them at once; a credited session is still
	// admitted at that point, since the server paces it.
	it('admits fewer sessions that credit cannot pace', async () => {
		const token = await initialise();
		const unpaced = await openSessions(token, maxUncreditedCommitSessions);

		const refused = await attemptUpgrade(token);
		const credited = await attemptUpgrade(token, commitCreditAccept);
		const creditedSession = commitSessionFromResponse(credited);

		expect({
			opened: unpaced.length,
			refused: refused.status,
			retryAfter: refused.headers.get('retry-after'),
			credited: credited.status
		}).toStrictEqual({
			opened: maxUncreditedCommitSessions,
			refused: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			credited: StatusCodes.SWITCHING_PROTOCOLS
		});

		closeAll([creditedSession, ...unpaced]);
	});
});
