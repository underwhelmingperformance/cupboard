import {
	commitBatchMaxEntries,
	type CommitSessionFrame
} from '@cupboard/protocol/upload';
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
import type { AdvertisedCapabilities } from './commit-socket.ts';
import {
	type CommitOutcome,
	type CommitSessionTarget,
	type CommitSocket,
	parseCapabilities,
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
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	readonly maxReconnects?: number;
	readonly reconnectBackoffMs?: number;
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
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
			timeoutSeconds: options.timeoutSeconds ?? 600,
			signal: options.signal,
			keepaliveMs: options.keepaliveMs,
			maxReconnects: options.maxReconnects,
			reconnectBackoffMs: options.reconnectBackoffMs,
			onCapabilities: options.onCapabilities
		}
	);
}

function openSession(
	socket: FakeCommitSocket,
	options: SessionTestOptions = {}
): ReturnType<typeof runCommitSession> {
	return openSessionOver([socket], options);
}

// The commit ack without its `settled` promise, so a test can assert the prompt
// disposition structurally.
async function ackOf(
	commit: Promise<CommitOutcome>
): Promise<Omit<CommitOutcome, 'settled'>> {
	const { storePathHash, narHash, status } = await commit;

	return { storePathHash, narHash, status };
}

// The verdict promise a commit ack carries.
async function settledOf(commit: Promise<CommitOutcome>): Promise<void> {
	const outcome = await commit;

	return outcome.settled;
}

describe('runCommitSession', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('acks a commit on a settled frame and leaves the socket open', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'already-present'
		});
		await expect(settledOf(commit)).resolves.toBeUndefined();
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

		await expect(ackOf(second)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(ackOf(first)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
		await expect(settledOf(first)).resolves.toBeUndefined();
		await expect(settledOf(second)).resolves.toBeUndefined();
		expect(socket.sent).toStrictEqual([
			commitOp('upload-a'),
			commitOp('upload-b')
		]);
	});

	it('acks a deferred upload as pending on its deferred frame', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const ack = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);

		await expect(ackOf(ack)).resolves.toStrictEqual({
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

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();
	});

	it('acks committed on a servable verdict that arrives before the deferred frame', async () => {
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

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();
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

			await expect(ackOf(settled)).resolves.toStrictEqual({
				storePathHash,
				narHash,
				status: 'pending'
			});
			const error = await rejectedBy(
				settledOf(settled),
				UploadVerificationFailedError
			);

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

	it.each([503, 429])(
		'retries a %i error frame and resolves the entry on a subsequent settled frame',
		async (retryStatus) => {
			const socket = new FakeCommitSocket();
			const session = openSession(socket);
			const commit = session.commit(target);

			socket.emit('open');
			socket.emit(
				'message',
				frame({
					ev: 'error',
					uploadId,
					status: retryStatus,
					message: 'overloaded'
				})
			);

			// The entry must not have resolved or rejected yet — it is waiting for the retry.
			let hasResolved = false;
			let hasRejected = false;
			void commit.then(
				() => {
					hasResolved = true;
				},
				() => {
					hasRejected = true;
				}
			);
			await Promise.resolve();
			expect({ hasResolved, hasRejected }).toStrictEqual({
				hasResolved: false,
				hasRejected: false
			});

			// Advance past the retry delay, then deliver a settled frame.
			await vi.advanceTimersByTimeAsync(5000);
			socket.emit(
				'message',
				frame({
					ev: 'settled',
					uploadId,
					response: { storePathHash, narHash, status: 'committed' }
				})
			);

			await expect(ackOf(commit)).resolves.toStrictEqual({
				storePathHash,
				narHash,
				status: 'committed'
			});
		}
	);

	it('fails the entry after exhausting retries on repeated retryable error frames', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		// Register the rejection handler before driving any frames so the rejection
		// is caught even when it fires synchronously inside advanceTimersByTimeAsync.
		const rejection = rejectedBy(commit, CupboardHttpError);

		socket.emit('open');

		// Send one more error frame than the retry cap; the last one terminates.
		// maxEntryRetries = 3, so 4 total error frames exhaust the budget.
		for (let index = 0; index < 4; index += 1) {
			socket.emit(
				'message',
				frame({ ev: 'error', uploadId, status: 503, message: 'overloaded' })
			);
			await vi.advanceTimersByTimeAsync(5000);
		}

		const error = await rejection;

		expect({
			name: error.name,
			status: error.status
		}).toStrictEqual({
			name: 'CupboardHttpError',
			status: 503
		});
	});

	it('treats a non-retryable error frame status as terminal with no retry', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'error', uploadId, status: 404, message: 'unknown upload' })
		);

		const error = await rejectedBy(commit, CupboardHttpError);

		expect({
			name: error.name,
			status: error.status,
			sentAfterError: socket.sent.length
		}).toStrictEqual({
			name: 'CupboardHttpError',
			status: 404,
			// The session sent one commit op on open; no retry op after the terminal error.
			sentAfterError: 1
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
		socket.emit('close', 1006, '');

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
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The reconnect resumes the acked id with a subscribe, and the replayed
		// verdict settles it over the new socket.
		second.emit('open');
		second.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();
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
		first.emit('close', 1006, '');
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

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();
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
		const outcome = await settled;
		const rejection = rejectedBy(outcome.settled, UploadWaitTimeoutError);
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

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();
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

function targetFor(id: string): CommitSessionTarget {
	return { uploadId: id, storePathHash, narHash };
}

function batchOp(ids: readonly string[]): string {
	return JSON.stringify({
		op: 'commit-batch',
		commits: ids.map((id) => ({ uploadId: id, storePathHash, narHash }))
	});
}

// The server's side of an accepting upgrade that offers the batch op.
function advertiseBatch(socket: FakeCommitSocket): void {
	socket.emit('upgrade', {
		headers: { 'x-cupboard-commit-capabilities': 'commit-batch' }
	});
}

function settleBoth(socket: FakeCommitSocket, ids: readonly string[]): void {
	for (const id of ids) {
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId: id,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);
	}
}

// The 101's capabilities header switches the session onto the batched op: the
// server offered it, so commits coalesce into `commit-batch` messages carrying
// each path's identity. Without the advertisement (every case above) the
// session speaks per-id `commit` ops.
describe('batched commit ops', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('replays registered commits as one batch op when advertised', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const first = session.commit(targetFor('upload-a'));
		const second = session.commit(targetFor('upload-b'));

		advertiseBatch(socket);
		socket.emit('open');
		settleBoth(socket, ['upload-a', 'upload-b']);

		await expect(ackOf(first)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(ackOf(second)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.sent).toStrictEqual([batchOp(['upload-a', 'upload-b'])]);
	});

	it('coalesces commits issued on an open socket into one batch op', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);

		advertiseBatch(socket);
		socket.emit('open');

		const first = session.commit(targetFor('upload-a'));
		const second = session.commit(targetFor('upload-b'));
		// The coalescing flush runs on a microtask.
		await Promise.resolve();

		settleBoth(socket, ['upload-a', 'upload-b']);

		await expect(ackOf(first)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(ackOf(second)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.sent).toStrictEqual([batchOp(['upload-a', 'upload-b'])]);
	});

	it('splits a burst past the batch cap into bounded ops', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const ids = Array.from(
			{ length: commitBatchMaxEntries + 1 },
			(_ignored, index) => `upload-${String(index)}`
		);

		advertiseBatch(socket);
		socket.emit('open');

		const commits = ids.map((id) => session.commit(targetFor(id)));
		await Promise.resolve();
		settleBoth(socket, ids);
		await Promise.all(commits);

		expect(socket.sent).toStrictEqual([
			batchOp(ids.slice(0, commitBatchMaxEntries)),
			batchOp(ids.slice(commitBatchMaxEntries))
		]);
	});

	it('re-sends an un-acked id as a batch op on reconnect', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit(target);

		// The socket drops before any frame, so the op may never have landed.
		advertiseBatch(first);
		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The reconnect re-sends the commit with its identity, which the server
		// resolves even when the row settled and cleared before the drop.
		advertiseBatch(second);
		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'already-present'
		});
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [batchOp([uploadId])],
			second: [batchOp([uploadId])]
		});
	});

	it('speaks per-id ops to a connection that advertised nothing', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		// An upgrade response with no capabilities header: an older server.
		socket.emit('upgrade', { headers: {} });
		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.sent).toStrictEqual([commitOp(uploadId)]);
	});

	it('fails the session when the server rejects an op it advertised', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		advertiseBatch(socket);
		socket.emit('open');
		socket.emit('message', frame({ ev: 'unsupported', op: 'commit-batch' }));

		await rejectedBy(commit, CommitSocketProtocolError);
		expect(socket.closed).toBe(true);
	});

	it('replays per-id ops when reconnecting onto a socket that does not advertise batch', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit(target);

		advertiseBatch(first);
		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Second socket does not advertise commit-batch, so replay speaks per-id ops.
		second.emit('upgrade', { headers: {} });
		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [batchOp([uploadId])],
			second: [commitOp(uploadId)]
		});
	});
});

function subscribeIdentityOp(ids: readonly string[]): string {
	return JSON.stringify({
		op: 'subscribe-identity',
		entries: ids.map((id) => ({ uploadId: id, storePathHash, narHash }))
	});
}

// Emits an upgrade that advertises both commit-batch and subscribe-identity.
function advertiseBoth(socket: FakeCommitSocket): void {
	socket.emit('upgrade', {
		headers: {
			'x-cupboard-commit-capabilities':
				'commit-batch;max=100,subscribe-identity'
		}
	});
}

describe('subscribe-identity', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('replays acked ids via subscribe-identity when both tokens are advertised', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit(target);

		advertiseBoth(first);
		first.emit('open');
		first.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);

		// Socket drops while the upload is parked.
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Reconnect advertises both tokens: acked id replays via subscribe-identity.
		advertiseBoth(second);
		second.emit('open');
		second.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [batchOp([uploadId])],
			second: [subscribeIdentityOp([uploadId])]
		});
	});

	it('falls back to bare subscribe when only commit-batch is advertised', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit(target);

		advertiseBatch(first);
		first.emit('open');
		first.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);

		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Second connection only offers commit-batch, not subscribe-identity.
		advertiseBatch(second);
		second.emit('open');
		second.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await expect(settledOf(settled)).resolves.toBeUndefined();
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [batchOp([uploadId])],
			second: [JSON.stringify({ op: 'subscribe', uploadIds: [uploadId] })]
		});
	});

	it('settles an acked entry when a settled frame arrives for it', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		advertiseBoth(socket);
		socket.emit('open');
		// The deferred frame acks the entry.
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);
		// A settled/already-present frame arrives for the acked id.
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);

		await expect(ackOf(settled)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
		await expect(settledOf(settled)).resolves.toBeUndefined();

		session.close();
	});
});

describe('parseCapabilities', () => {
	it.each([
		['empty string', '', []],
		['bare token', 'commit-batch', [['commit-batch', {}]]],
		[
			'token with one attribute',
			'commit-batch;max=50',
			[['commit-batch', { max: '50' }]]
		],
		[
			'token with multiple attributes',
			'foo;a=1;b=2',
			[['foo', { a: '1', b: '2' }]]
		],
		[
			'two tokens comma-separated',
			'foo, commit-batch;max=50',
			[
				['foo', {}],
				['commit-batch', { max: '50' }]
			]
		],
		[
			'two tokens whitespace-separated',
			'foo commit-batch;max=50',
			[
				['foo', {}],
				['commit-batch', { max: '50' }]
			]
		],
		['attribute without value skipped', 'foo;novalue', [['foo', {}]]]
	] as const)('%s', (_label, header, expected) => {
		const result = parseCapabilities(header);
		expect([...result]).toStrictEqual(expected);
	});
});

describe('parameterised capability max', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('chunks at the advertised max when it is below the protocol bound', () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const ids = ['upload-a', 'upload-b', 'upload-c'];

		for (const id of ids) {
			void session.commit(targetFor(id));
		}

		socket.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=2' }
		});
		socket.emit('open');

		// 3 commits, max=2 → two batch ops
		expect(socket.sent).toStrictEqual([
			batchOp(['upload-a', 'upload-b']),
			batchOp(['upload-c'])
		]);

		session.close();
	});

	it('uses the protocol bound when the advertised max is larger', () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const ids = Array.from(
			{ length: commitBatchMaxEntries + 1 },
			(_ignored, index) => `upload-${String(index)}`
		);

		for (const id of ids) {
			void session.commit(targetFor(id));
		}

		// max=9999 is above the protocol bound, so the protocol bound wins.
		socket.emit('upgrade', {
			headers: {
				'x-cupboard-commit-capabilities': `commit-batch;max=${String(commitBatchMaxEntries + 100)}`
			}
		});
		socket.emit('open');

		expect(socket.sent).toStrictEqual([
			batchOp(ids.slice(0, commitBatchMaxEntries)),
			batchOp(ids.slice(commitBatchMaxEntries))
		]);

		session.close();
	});

	it.each([
		['non-numeric max', 'commit-batch;max=abc'],
		['zero max', 'commit-batch;max=0'],
		['negative max', 'commit-batch;max=-1']
	])('falls back to the protocol bound for %s', (_label, capHeader) => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const ids = Array.from(
			{ length: commitBatchMaxEntries + 1 },
			(_ignored, index) => `upload-${String(index)}`
		);

		for (const id of ids) {
			void session.commit(targetFor(id));
		}

		socket.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': capHeader }
		});
		socket.emit('open');

		expect(socket.sent).toStrictEqual([
			batchOp(ids.slice(0, commitBatchMaxEntries)),
			batchOp(ids.slice(commitBatchMaxEntries))
		]);

		session.close();
	});
});

describe('unknown frame ev tolerance', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('ignores a frame whose ev is unknown and settles on the next valid frame', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		socket.emit('open');
		socket.emit(
			'message',
			JSON.stringify({ ev: 'future-unknown-ev', data: 'x' })
		);
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		await expect(settledOf(commit)).resolves.toBeUndefined();
	});

	it('fails the session when a known ev frame does not match its schema', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		socket.emit('open');
		// 'settled' is a known ev but this frame is missing the required fields.
		socket.emit('message', JSON.stringify({ ev: 'settled', uploadId }));

		const error = await rejectedBy(commit, CommitSocketProtocolError);
		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});

	it('fails the session on non-JSON text', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

		socket.emit('open');
		socket.emit('message', 'not json at all');

		const error = await rejectedBy(commit, CommitSocketProtocolError);
		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});
});

describe('onCapabilities callback', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls onCapabilities with the parsed map on open', () => {
		const socket = new FakeCommitSocket();
		const calls: AdvertisedCapabilities[] = [];
		const session = openSession(socket, {
			onCapabilities: (caps) => {
				calls.push(caps);
			}
		});

		socket.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=50' }
		});
		socket.emit('open');

		expect(calls).toHaveLength(1);
		expect([...(calls[0]?.entries() ?? [])]).toStrictEqual([
			['commit-batch', { max: '50' }]
		]);

		session.close();
	});

	it('calls onCapabilities with an empty map when no header was sent', () => {
		const socket = new FakeCommitSocket();
		const calls: AdvertisedCapabilities[] = [];
		const session = openSession(socket, {
			onCapabilities: (caps) => {
				calls.push(caps);
			}
		});

		// Upgrade with no capabilities header.
		socket.emit('upgrade', { headers: {} });
		socket.emit('open');

		expect(calls).toHaveLength(1);
		expect([...(calls[0]?.entries() ?? [])]).toStrictEqual([]);

		session.close();
	});

	it('calls onCapabilities once per connection on reconnect', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const calls: AdvertisedCapabilities[] = [];
		const session = openSessionOver([first, second], {
			onCapabilities: (caps) => {
				calls.push(caps);
			}
		});

		advertiseBatch(first);
		first.emit('open');

		const commit = session.commit(target);
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('upgrade', { headers: {} });
		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await commit;

		expect(calls).toHaveLength(2);
		// First connection advertised commit-batch.
		expect([...(calls[0]?.entries() ?? [])]).toStrictEqual([
			['commit-batch', {}]
		]);
		// Second connection advertised nothing.
		expect([...(calls[1]?.entries() ?? [])]).toStrictEqual([]);
	});
});

describe('close code and reason', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fails the session immediately on close code 1002 with no reconnect', async () => {
		const first = new FakeCommitSocket();
		// A second socket would throw if the session tried to reconnect.
		const session = openSessionOver([first]);
		const commit = session.commit(target);

		first.emit('open');
		first.emit('close', 1002, 'invalid commit request');

		const error = await rejectedBy(commit, CommitSocketProtocolError);
		expect({
			name: error.name,
			path: error.path,
			closed: first.closed
		}).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path,
			closed: true
		});
	});

	it('reconnects on close code 1006', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const commit = session.commit(target);

		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
	});
});

describe('late commit after clean close', () => {
	it('rejects a commit issued after the server closes the socket with nothing outstanding', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);

		// Open and close with no outstanding commits: the server ended cleanly.
		socket.emit('open');
		socket.emit('close', 1000, '');

		// A commit issued now finds the session closed.
		const lateCommit = session.commit(target);
		const error = await rejectedBy(lateCommit, CommitSocketProtocolError);
		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});

	it('rejects a commit after explicit session close', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);

		socket.emit('open');
		session.close();

		const lateCommit = session.commit(target);
		const error = await rejectedBy(lateCommit, CommitSocketProtocolError);
		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});
});

describe('boundary conditions', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('replays exactly one op when the socket closes before the microtask flush', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);

		first.emit('open');
		const commit = session.commit(target);
		// Drop before the microtask flush; the coalescing flush sees no open
		// socket and sends nothing. The reconnect replays the entry once.
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		// Nothing reached the first socket (the flush ran after the close).
		// The second socket replayed exactly one op.
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [],
			second: [commitOp(uploadId)]
		});
	});

	it('rejects an outstanding commit when reconnects exhaust', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], { maxReconnects: 1 });

		// Register before the first connection so there is outstanding work when the
		// socket drops, keeping the session in the reconnect path rather than closing.
		const commit = session.commit(target);

		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Second socket replays, then drops. Reconnect budget is now zero.
		second.emit('open');
		second.emit('close', 1006, '');

		const error = await rejectedBy(commit, CommitSocketProtocolError);
		expect({ name: error.name, path: error.path }).toStrictEqual({
			name: 'CommitSocketProtocolError',
			path
		});
	});

	it('non-batching reconnect sends bare per-id ops', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const commit = session.commit(target);

		// Neither socket advertises commit-batch; bare commit ops are used
		// throughout. On a reconnect, the bare op re-sends to the server even
		// though the row may have settled and cleared before the drop; the server
		// answers with an error frame in that case. This asymmetry is inherent to
		// the non-batching path.
		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [commitOp(uploadId)],
			second: [commitOp(uploadId)]
		});
	});
});
