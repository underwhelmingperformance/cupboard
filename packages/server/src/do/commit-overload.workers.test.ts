import { atWarningOrAbove, startCapture } from '@cupboard/logger/testing';
import { commitAcceptCapabilitiesHeader } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	d1AccountThrottleMessage,
	d1QueueOverloadMessage
} from '../db/transient.test-support.ts';
import { SharedFactsUnavailableError } from '../errors.ts';
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
	defaultCache,
	initialise,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const stringMatcher: unknown = expect.any(String);

// A typed error keeps its own response when a D1 overload is in its cause
// chain, and the overload log record is not written.
const rejections = [
	{
		name: 'the D1 queue overload',
		error: new Error(d1QueueOverloadMessage),
		message: 'Database is temporarily overloaded',
		isLogged: true
	},
	{
		name: 'the D1 account throttle',
		error: new Error(d1AccountThrottleMessage),
		message: 'Database is temporarily overloaded',
		isLogged: true
	},
	{
		name: 'a typed error that has the D1 account throttle as its cause',
		error: new SharedFactsUnavailableError(new Error(d1AccountThrottleMessage)),
		message: 'Cache facts are temporarily unavailable',
		isLogged: false
	}
];

describe('commit socket overload handling', () => {
	beforeEach(resetTestServer);

	it.each(rejections)(
		'sends a 503 error frame when the commit is rejected with $name',
		async ({ error, message, isLogged }) => {
			const token = await initialise();
			const path = uploadMetadata({
				storePathHash: 'a'.repeat(32),
				fileSize: 1
			});
			const negotiated = await negotiateUploads(token, [path]);
			const decision = negotiated.uploads[0];

			if (decision?.action !== 'upload') {
				throw new Error('expected an upload decision');
			}

			const { uploadId, r2Key } = decision;
			await putNarBytes(r2Key);

			const batchSpy = vi
				.spyOn(env.CUPBOARD_DB, 'batch')
				.mockRejectedValue(error);
			const capture = startCapture();

			try {
				const session = await openCommitSession(token);
				session.send({ op: 'commit', uploadId });
				const frame = await session.nextFrame();
				session.socket.close();

				expect({
					frame,
					logged: atWarningOrAbove(capture.logs)
				}).toStrictEqual({
					frame: {
						ev: 'error',
						uploadId,
						status: StatusCodes.SERVICE_UNAVAILABLE,
						message
					},
					logged: isLogged
						? [
								{
									level: 'warning',
									category: ['cupboard'],
									message: 'request refused: database overloaded',
									properties: {
										cache: {
											access: 'public',
											generation: 1,
											id: 1,
											scope: { kind: 'default' }
										},
										op: 'commit',
										sessionId: stringMatcher,
										uploadId,
										error
									}
								}
							]
						: []
				});
			} finally {
				capture.stop();
				batchSpy.mockRestore();
			}
		}
	);
});

async function openSessions(
	token: string,
	count: number,
	accepted?: string
): Promise<CommitConversation[]> {
	const sessions: CommitConversation[] = [];

	for (let index = 0; index < count; index += 1) {
		sessions.push(await openCommitSession(token, defaultCache(), accepted));
	}

	return sessions;
}

function closeAll(sessions: readonly CommitConversation[]): void {
	for (const session of sessions) {
		session.socket.close();
	}
}

function attemptUpgrade(token: string, accepted?: string): Promise<Response> {
	return authorisedFetch('/commit', token, {
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
			defaultCache(),
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
