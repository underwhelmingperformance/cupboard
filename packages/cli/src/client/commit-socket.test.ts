import type { CommitSessionFrame } from '@cupboard/protocol/upload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CommitSocketProtocolError,
	CupboardHttpError,
	UploadVerificationFailedError,
	UploadWaitTimeoutError
} from '../errors.ts';

import {
	FakeCommitSocket,
	FakeUpgradeFailure
} from './commit-socket.test-support.ts';
import {
	type CommitSessionTarget,
	type CommitSocket,
	runCommitSession
} from './commit-socket.ts';

function frame(value: CommitSessionFrame): string {
	return JSON.stringify(value);
}

function commitOp(uploadId: string): string {
	return JSON.stringify({ op: 'commit', uploadId });
}

const storePathHash = '0123456789abcdfghijklmnpqrsvwxyz';
const narHash = `sha256:${'1'.repeat(52)}`;
const path = '/cache/_default/commit';
// The session's jittered reconnect back-off never exceeds this cap, so advancing
// a fake clock by it fires any pending reconnect.
const maxBackoffMs = 5000;
const uploadId = 'upload-app';
const target: CommitSessionTarget = { uploadId, storePathHash, narHash };

type ErrorConstructor<T extends Error> = abstract new (
	...arguments_: never[]
) => T;

function expectError<T extends Error>(
	error: unknown,
	errorClass: ErrorConstructor<T>
): asserts error is T {
	expect(error).toBeInstanceOf(errorClass);
}

async function rejectedBy<T extends Error>(
	promise: Promise<unknown>,
	errorClass: ErrorConstructor<T>
): Promise<T> {
	let rejection: unknown;

	try {
		await promise;
	} catch (error) {
		rejection = error;
	}

	expectError(rejection, errorClass);

	return rejection;
}

interface SessionTestOptions {
	readonly wait?: boolean;
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	readonly maxReconnects?: number;
	readonly reconnectBackoffMs?: number;
}

// Hands the session a fresh socket per connection attempt, so a test can drop
// one and drive the reconnect onto the next.
function openSessionOver(
	sockets: readonly FakeCommitSocket[],
	options: SessionTestOptions = {}
): ReturnType<typeof runCommitSession> {
	let attempt = 0;
	const connect = (): CommitSocket => {
		const socket = sockets[attempt];
		attempt += 1;

		if (socket === undefined) {
			throw new Error(
				`no socket scripted for connection attempt ${String(attempt)}`
			);
		}

		return socket;
	};

	return runCommitSession(
		connect,
		new URL(`wss://cupboard.test${path}`),
		{},
		{
			path,
			wait: options.wait ?? true,
			timeoutSeconds: options.timeoutSeconds ?? 600,
			signal: options.signal,
			keepaliveMs: options.keepaliveMs,
			maxReconnects: options.maxReconnects,
			reconnectBackoffMs: options.reconnectBackoffMs
		}
	);
}

function openSession(
	socket: FakeCommitSocket,
	options: SessionTestOptions = {}
): ReturnType<typeof runCommitSession> {
	return openSessionOver([socket], options);
}

describe('runCommitSession', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('settles a commit on a settled frame and leaves the socket open', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'already-present'
		});
		expect(socket.closed).toBe(false);

		session.close();
		expect(socket.closed).toBe(true);
	});

	it('settles each commit by its upload id over one socket', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const first = session.commit({
			uploadId: 'upload-a',
			storePathHash,
			narHash
		});
		const second = session.commit({
			uploadId: 'upload-b',
			storePathHash,
			narHash
		});

		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId: 'upload-b',
				response: { storePathHash, narHash, status: 'committed' }
			})
		);
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId: 'upload-a', storePathHash, narHash })
		);
		socket.emit(
			'message',
			frame({ ev: 'verdict', uploadId: 'upload-a', status: 'servable' })
		);

		await expect(second).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(first).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.sent).toStrictEqual([
			commitOp('upload-a'),
			commitOp('upload-b')
		]);
	});

	it('reports a deferred upload as pending without waiting when wait is off', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { wait: false });
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
	});

	it('parks a deferred upload and settles committed on a servable verdict', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);
		socket.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
	});

	it('settles committed on a servable verdict that arrives before the deferred frame', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		// Verification settled the upload before its deferred frame, so the verdict
		// races ahead. The client settles from the target's known identity.
		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
	});

	it.each(['mismatch', 'over-quota', 'absent'] as const)(
		'rejects a parked upload on a %s verdict',
		async (status) => {
			const socket = new FakeCommitSocket();
			const session = openSession(socket);
			const settled = session.commit(target);

			socket.emit('open');
			socket.emit(
				'message',
				frame({ ev: 'deferred', uploadId, storePathHash, narHash })
			);
			socket.emit('message', frame({ ev: 'verdict', uploadId, status }));

			const error = await rejectedBy(settled, UploadVerificationFailedError);

			expect({
				name: error.name,
				uploadId: error.uploadId,
				status: error.status
			}).toStrictEqual({
				name: 'UploadVerificationFailedError',
				uploadId,
				status
			});
		}
	);

	it('rejects an error frame with the HTTP error it mirrors', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'error', uploadId, status: 507, message: 'over quota' })
		);

		const error = await rejectedBy(settled, CupboardHttpError);

		expect({
			name: error.name,
			method: error.method,
			path: error.path,
			status: error.status,
			body: error.body
		}).toStrictEqual({
			name: 'CupboardHttpError',
			method: 'GET',
			path,
			status: 507,
			body: 'over quota'
		});
	});

	it('fails every commit when the upgrade is refused', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);
		const refusal = new FakeUpgradeFailure(401);

		socket.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Missing bearer token'));
		refusal.emit('end');

		const error = await rejectedBy(settled, CupboardHttpError);

		expect({
			name: error.name,
			method: error.method,
			path: error.path,
			status: error.status,
			body: error.body
		}).toStrictEqual({
			name: 'CupboardHttpError',
			method: 'GET',
			path,
			status: 401,
			body: 'Missing bearer token'
		});
	});

	it('fails every outstanding commit when a drop exhausts the reconnect budget', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { maxReconnects: 0 });
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit('close', 1006);

		const error = await rejectedBy(settled, CommitSocketProtocolError);

		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});

	it('reconnects after a drop and resumes a parked upload by subscribing', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit(target);

		first.emit('open');
		first.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);

		// The socket drops while the upload is parked for its verdict.
		first.emit('close', 1006);
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The reconnect resumes the acked id with a subscribe, and the replayed
		// verdict settles it over the new socket.
		second.emit('open');
		second.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [commitOp(uploadId)],
			second: [JSON.stringify({ op: 'subscribe', uploadIds: [uploadId] })]
		});
	});

	it('reconnects after a drop and re-commits an un-acked upload', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit(target);

		// The socket drops before any frame, so the commit op may never have landed.
		first.emit('open');
		first.emit('close', 1006);
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The reconnect re-sends the commit, which settles over the new socket.
		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [commitOp(uploadId)],
			second: [commitOp(uploadId)]
		});
	});

	it('rejects an unparseable frame as a protocol error', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit('message', 'not json');

		const error = await rejectedBy(settled, CommitSocketProtocolError);

		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});

	it('times out a parked upload after the wait deadline', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { timeoutSeconds: 30 });
		const settled = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);
		const rejection = rejectedBy(settled, UploadWaitTimeoutError);
		await vi.advanceTimersByTimeAsync(30_000);

		const error = await rejection;
		expect({
			name: error.name,
			pending: error.pending,
			timeoutSeconds: error.timeoutSeconds
		}).toStrictEqual({
			name: 'UploadWaitTimeoutError',
			pending: 1,
			timeoutSeconds: 30
		});
	});

	it('keeps the socket alive with pings and ignores the pong replies', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { keepaliveMs: 1000 });
		const settled = session.commit(target);

		socket.emit('open');
		await vi.advanceTimersByTimeAsync(2000);
		socket.emit('message', 'pong');
		socket.emit('message', 'pong');
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.sent).toStrictEqual([commitOp(uploadId), 'ping', 'ping']);
	});

	it('rejects and closes the socket when the signal aborts', async () => {
		const socket = new FakeCommitSocket();
		const controller = new AbortController();
		const session = openSession(socket, { signal: controller.signal });
		const settled = session.commit(target);

		controller.abort();

		const error = await rejectedBy(settled, Error);

		expect({
			error: { name: error.name },
			socketClosed: socket.closed
		}).toStrictEqual({
			error: { name: 'AbortError' },
			socketClosed: true
		});
	});
});
