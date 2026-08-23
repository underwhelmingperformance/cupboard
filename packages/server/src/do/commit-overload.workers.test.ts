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

// Keep this exact Cloudflare D1 text aligned with `transient.ts`, which must
// identify this overload condition from the error message.
const d1OverloadText =
	'D1_ERROR: D1 DB is overloaded. Too many requests queued.';

describe('commit socket overload handling', () => {
	beforeEach(resetTestServer);

	it('sends a 503 error frame when D1 rejects the commit as overloaded', async () => {
		const token = await initialise();
		const path = uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 });
		const negotiated = await negotiateUploads(token, [path]);
		const decision = negotiated.uploads[0];

		if (decision?.action !== 'upload') {
			throw new Error('expected an upload decision');
		}

		const { uploadId, r2Key } = decision;
		await putNarBytes(r2Key);

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

// The test environment configures a lower ceiling than production so the suite
// can reach it with a small number of sockets.
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

	// The server cannot pace a session that did not negotiate credit, so it uses
	// a lower limit for those sessions. A credited session remains admissible at
	// that limit because the server controls its send budget.
	it('applies the lower uncredited limit without refusing a credited session', async () => {
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
