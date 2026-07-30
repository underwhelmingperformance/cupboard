import { WIRE_DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	authorisedFetch,
	type CommitConversation,
	currentServer,
	deferFreshUpload,
	initialise,
	negotiateUploads,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

import { maxCommitSessionsPerTenant } from './server.ts';

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
	count: number
): Promise<CommitConversation[]> {
	const sessions: CommitConversation[] = [];

	for (let index = 0; index < count; index += 1) {
		sessions.push(await openCommitSession(token));
	}

	return sessions;
}

function closeAll(sessions: readonly CommitConversation[]): void {
	for (const session of sessions) {
		session.socket.close();
	}
}

function attemptUpgrade(token: string): Promise<Response> {
	return authorisedFetch(`/cache/${WIRE_DEFAULT_CACHE}/commit`, token, {
		headers: { upgrade: 'websocket' }
	});
}

async function liveSocketCount(): Promise<number> {
	return runInDurableObject(
		currentServer(),
		(_instance, state) => state.getWebSockets().length
	);
}

describe('commit session cap', () => {
	beforeEach(resetTestServer);

	it('accepts sessions up to the cap and refuses the next upgrade retryably', async () => {
		const token = await initialise();
		const sessions = await openSessions(token, maxCommitSessionsPerTenant);

		const refused = await attemptUpgrade(token);

		expect({
			accepted: sessions.length,
			status: refused.status,
			retryAfter: refused.headers.get('retry-after'),
			cacheControl: refused.headers.get('cache-control')
		}).toStrictEqual({
			accepted: maxCommitSessionsPerTenant,
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5',
			cacheControl: 'no-store'
		});

		closeAll(sessions);
	});

	it('frees a slot once a session closes', async () => {
		const token = await initialise();
		const [first, ...rest] = await openSessions(
			token,
			maxCommitSessionsPerTenant
		);

		if (first === undefined) {
			throw new Error('expected an open session');
		}

		first.socket.close();
		await vi.waitFor(async () => {
			expect(await liveSocketCount()).toBe(maxCommitSessionsPerTenant - 1);
		});

		const reopened = await openCommitSession(token);

		closeAll([reopened, ...rest]);
	});

	it('counts a parked deferred session against the cap', async () => {
		const token = await initialise();
		const parked = await openCommitSession(token);
		const { uploadId } = await deferFreshUpload(
			token,
			'parked',
			'c'.repeat(32)
		);

		parked.send({ op: 'commit', uploadId });
		const frame = await parked.nextFrame();

		const others = await openSessions(token, maxCommitSessionsPerTenant - 1);
		const refused = await attemptUpgrade(token);

		expect({
			deferred: frame.ev,
			status: refused.status,
			retryAfter: refused.headers.get('retry-after')
		}).toStrictEqual({
			deferred: 'deferred',
			status: StatusCodes.SERVICE_UNAVAILABLE,
			retryAfter: '5'
		});

		closeAll([parked, ...others]);
	});
});
