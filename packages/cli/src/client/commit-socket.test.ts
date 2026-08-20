import {
	nixSha256HashSchema,
	storePathHashSchema
} from '@cupboard/nix-store/scalars';
import {
	commitAuthenticationExpiredCloseCode,
	commitAuthenticationExpiredCloseReason,
	commitBatchMaxEntries,
	commitCapabilitiesValue,
	type CommitSessionFrame,
	uploadIdSchema
} from '@cupboard/protocol/upload';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	CommitCapacityTimeoutError,
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
	type CommitSocketCredentials,
	parseCapabilities,
	runCommitSession
} from './commit-socket.ts';
import type { BearerAttempt } from './credentials.ts';

function frame(value: CommitSessionFrame): string {
	return JSON.stringify(value);
}

function commitOp(uploadId: string): string {
	return JSON.stringify({ op: 'commit', uploadId });
}

const storePathHash = storePathHashSchema.parse(
	'0123456789abcdfghijklmnpqrsvwxyz'
);
const narHash = nixSha256HashSchema.parse(`sha256:${'1'.repeat(52)}`);
const path = '/cache/_default/commit';
// The session's jittered reconnect back-off never exceeds this cap, so advancing
// a fake clock by it fires any pending reconnect.
const maxBackoffMs = 5000;
// The longest delay a timer can hold; a runtime truncates a longer one to a
// millisecond, which is what the session's chained deadlines work around.
const maxTimerDelayMs = 2 ** 31 - 1;
// How long the session reads a refusal body before it gives up on the response
// and drops the connection, mirroring its own bound.
const drainTimeoutMs = 5000;
// The upgrade request the real client sends: it declares both optional ops on
// every connection, whatever the server turns out to support.
const creditDeclaringHeaders = {
	'x-cupboard-accept-capabilities': 'commit-batch,commit-credit'
};
const uploadId = uploadIdSchema.parse('upload-app');
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
	// The upgrade request headers, which are what the session declares to the
	// server. Empty unless a test declares a capability on the client's behalf.
	readonly headers?: Readonly<Record<string, string>>;
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	readonly maxReconnects?: number;
	readonly reconnectBackoffMs?: number;
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
	readonly onWaiting?: (isWaitingForCapacity: boolean) => void;
	// Collects the clock time of each connection, so a test can measure the
	// back-off the session waited before reopening.
	readonly connectedAt?: number[];
}

function fixedAttempt(
	headers: Readonly<Record<string, string>>
): BearerAttempt {
	return {
		headers,
		refreshAfterAuthenticationFailure: () => Promise.resolve(undefined)
	};
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
		options.connectedAt?.push(Date.now());

		if (socket === undefined) {
			throw new Error(
				`no socket scripted for connection attempt ${String(attempt)}`
			);
		}

		return socket;
	};
	const headers = options.headers ?? {};
	const credentials: CommitSocketCredentials = {
		initial: fixedAttempt(headers),
		authorise: () => Promise.resolve(fixedAttempt(headers))
	};

	return runCommitSession(
		connect,
		new URL(`wss://cupboard.test${path}`),
		credentials,
		{
			path,
			timeoutSeconds: options.timeoutSeconds ?? 600,
			signal: options.signal,
			keepaliveMs: options.keepaliveMs,
			maxReconnects: options.maxReconnects,
			reconnectBackoffMs: options.reconnectBackoffMs,
			onCapabilities: options.onCapabilities,
			onWaiting: options.onWaiting
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
			uploadId: uploadIdSchema.parse('upload-a'),
			storePathHash,
			narHash
		});
		const second = session.commit({
			uploadId: uploadIdSchema.parse('upload-b'),
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

			// The entry must not have resolved or rejected yet: it is waiting for the retry.
			let hasResolved = false;
			let hasRejected = false;
			void (async () => {
				try {
					await commit;
					hasResolved = true;
				} catch {
					hasRejected = true;
				}
			})();
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

	// Below 500, only a rate limit is about timing; any other status refuses
	// this request itself. A token the cache will not accept and a route it does
	// not serve both read the same on the next dial, so the session gives up at
	// once.
	it.each([
		{ status: 401, body: 'Missing bearer token' },
		{ status: 404, body: 'No such cache' }
	])(
		'fails every commit when the upgrade is refused with $status',
		async ({ status, body }) => {
			const socket = new FakeCommitSocket();
			const session = openSession(socket);
			const settled = session.commit(target);
			const refusal = new FakeUpgradeFailure(status);

			socket.emit('unexpected-response', {}, refusal);
			refusal.emit('data', Buffer.from(body));
			refusal.emit('end');

			const error = await rejectedBy(settled, CupboardHttpError);

			expect({
				name: error.name,
				method: error.method,
				path: error.path,
				status: error.status,
				body: error.body,
				// The session's teardown closes the connection on this exit.
				closed: socket.closed
			}).toStrictEqual({
				name: 'CupboardHttpError',
				method: 'GET',
				path,
				status,
				body,
				closed: true
			});
		}
	);

	// A dial meets the server's own overload statuses and the gateway ones an
	// edge in front of it reports, and a dial refused with any of them may still
	// be followed by one that succeeds. A paced session treats them all as a
	// drop, so its capacity clock decides how long it keeps trying, and the run
	// continues when a dial gets through.
	it.each([429, 502, 503, 504, 520])(
		'carries on after an upgrade refused with %i',
		async (status) => {
			const first = new FakeCommitSocket();
			const refused = new FakeCommitSocket();
			const last = new FakeCommitSocket();
			const session = openSessionOver([first, refused, last], {
				headers: creditDeclaringHeaders,
				timeoutSeconds: 100,
				keepaliveMs: 600_000
			});
			const commit = session.commit(target);

			advertiseCredit(first, 0, 1);
			first.emit('open');
			first.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);

			const refusal = new FakeUpgradeFailure(status);
			refused.emit('unexpected-response', {}, refusal);
			refusal.emit('data', Buffer.from('Commit sessions are busy'));
			refusal.emit('end');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);

			advertiseCredit(last, 1, 1);
			last.emit('open');
			last.emit('message', settledFrame(uploadId));

			await expect(ackOf(commit)).resolves.toStrictEqual({
				storePathHash,
				narHash,
				status: 'committed'
			});
		}
	);

	// An unpaced session has no capacity clock, so the refusal spends from the
	// reconnect budget like any other drop: the session dials again, and it is
	// the drop after that, with the budget gone, that ends the push.
	it('spends the reconnect budget on an upgrade refused with a retryable status', async () => {
		const first = new FakeCommitSocket();
		const refused = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const session = openSessionOver([first, refused, last], {
			maxReconnects: 2,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const failed = rejectedBy(commit, CommitSocketProtocolError);

		first.emit('upgrade', { headers: {} });
		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The refusal spends the second of the two reconnects, so the session
		// dials once more rather than failing here.
		const refusal = new FakeUpgradeFailure(503);
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		last.emit('upgrade', { headers: {} });
		last.emit('open');
		last.emit('close', 1006, '');

		const error = await failed;

		expect(error.path).toBe(path);
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

	it('reconnects after authentication expires without spending the fault budget', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], { maxReconnects: 0 });
		const committed = session.commit(target);

		first.emit('open');
		first.emit(
			'close',
			commitAuthenticationExpiredCloseCode,
			commitAuthenticationExpiredCloseReason
		);
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('open');
		second.emit('message', settledFrame(uploadId));

		await expect(ackOf(committed)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
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
	return { uploadId: uploadIdSchema.parse(id), storePathHash, narHash };
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

// Three single-entry chunks for windowing tests: the window cap (2) fills on
// the first two, leaving the third to queue until a frame arrives.
const windowTestIds = ['upload-w0', 'upload-w1', 'upload-w2'] as const;

describe('batch message windowing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('holds the third chunk until a frame arrives for any entry of the first', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const [id0, id1, id2] = windowTestIds;
		const commits = windowTestIds.map((id) => session.commit(targetFor(id)));

		// Advertise batch with max=1 so each entry lands in its own chunk.
		socket.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=1' }
		});
		socket.emit('open');

		// Only the first two chunks go out immediately.
		expect(socket.sent).toStrictEqual([batchOp([id0]), batchOp([id1])]);

		// A frame for an entry in the first chunk releases the third.
		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId: id0,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		expect(socket.sent).toStrictEqual([
			batchOp([id0]),
			batchOp([id1]),
			batchOp([id2])
		]);

		settleBoth(socket, [id1, id2]);
		await Promise.all(commits);

		session.close();
	});

	it('replays a queued-but-unsent chunk exactly once on reconnect, not double-sending', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const [id0, id1, id2] = windowTestIds;
		const commits = windowTestIds.map((id) => session.commit(targetFor(id)));

		first.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=1' }
		});
		first.emit('open');

		// Two chunks sent, one queued.
		expect(first.sent).toStrictEqual([batchOp([id0]), batchOp([id1])]);

		// Drop before the third chunk was sent; reconnect replays all three through
		// a fresh window without ever having sent the third to the first socket.
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Reconnect sends all outstanding entries through a fresh window.
		second.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=1' }
		});
		second.emit('open');

		// All three ids are outstanding, so the new window sends the first two
		// immediately and queues the third again.
		expect(second.sent).toStrictEqual([batchOp([id0]), batchOp([id1])]);

		// A frame for the first entry releases the window slot, sending the third.
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId: id0,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		expect(second.sent).toStrictEqual([
			batchOp([id0]),
			batchOp([id1]),
			batchOp([id2])
		]);

		settleBoth(second, [id1, id2]);
		await Promise.all(commits);
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

function batchOpWithRetention(ids: readonly string[]): string {
	return JSON.stringify({
		op: 'commit-batch',
		commits: ids.map((id) => ({
			uploadId: id,
			storePathHash,
			narHash,
			retention: true
		}))
	});
}

function subscribeIdentityOpWithRetention(ids: readonly string[]): string {
	return JSON.stringify({
		op: 'subscribe-identity',
		entries: ids.map((id) => ({
			uploadId: id,
			storePathHash,
			narHash,
			retention: true
		}))
	});
}

// Emits an upgrade whose capabilities are the real value the server sends,
// which carries the retention-marker attribute on both tokens.
function advertiseRetentionMarker(socket: FakeCommitSocket): void {
	socket.emit('upgrade', {
		headers: { 'x-cupboard-commit-capabilities': commitCapabilitiesValue }
	});
}

describe('retention marker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('sets the marker on a commit-batch entry for a plan-carrying target when the server advertises it', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit({ ...target, retention: true });

		advertiseRetentionMarker(socket);
		socket.emit('open');

		expect(socket.sent).toStrictEqual([batchOpWithRetention([uploadId])]);

		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);
		await settledOf(settled);
		session.close();
	});

	// A disabled or unrecognised advertisement must read as no marker: only
	// the exact advertised value proves the versioned handshake.
	it('omits the marker when the advertised attribute carries a different value', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit({ ...target, retention: true });

		socket.emit('upgrade', {
			headers: {
				'x-cupboard-commit-capabilities': 'commit-batch;max=100;retention=0'
			}
		});
		socket.emit('open');

		expect(socket.sent).toStrictEqual([batchOp([uploadId])]);

		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);
		await settledOf(settled);
		session.close();
	});

	it('omits the marker on a commit-batch entry when the server does not advertise it', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit({ ...target, retention: true });

		// Advertises commit-batch, but not the retention-marker attribute: the
		// shape a server that predates the marker sends.
		advertiseBatch(socket);
		socket.emit('open');

		expect(socket.sent).toStrictEqual([batchOp([uploadId])]);

		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);
		await settledOf(settled);
		session.close();
	});

	it('never sets the marker for a target that did not negotiate a plan', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		advertiseRetentionMarker(socket);
		socket.emit('open');

		expect(socket.sent).toStrictEqual([batchOp([uploadId])]);

		socket.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);
		await settledOf(settled);
		session.close();
	});

	it('sets the marker on a subscribe-identity replay entry when the server advertises it', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);
		const settled = session.commit({ ...target, retention: true });

		advertiseRetentionMarker(first);
		first.emit('open');
		first.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);

		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		advertiseRetentionMarker(second);
		second.emit('open');
		second.emit(
			'message',
			frame({ ev: 'verdict', uploadId, status: 'servable' })
		);

		await settledOf(settled);
		expect({ first: first.sent, second: second.sent }).toStrictEqual({
			first: [batchOpWithRetention([uploadId])],
			second: [subscribeIdentityOpWithRetention([uploadId])]
		});
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

	// `ws` reports one fault as an `error` event followed by a `close` event, so
	// a drop that costs two reconnects would halve the retry budget and open two
	// connections that then share the session's state. The reconnect budget of
	// one below is exhausted by a second count of the same drop.
	it('counts an error and the close that follows it as one drop', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], { maxReconnects: 1 });
		const commit = session.commit(target);

		first.emit('open');
		first.emit('error', new Error('connection reset'));
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('open');
		second.emit('message', settledFrame(uploadId));

		await expect(ackOf(commit)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
	});

	// A retryable error frame arms a per-entry retry. The replay onto the fresh
	// connection re-sends that entry itself, so the retry must not fire as well.
	it('does not re-send a replayed entry whose retry was armed before the drop', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], {
			// Short enough that the reconnect completes well before the entry's
			// retry would have fired.
			reconnectBackoffMs: 20,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);

		first.emit('upgrade', { headers: {} });
		first.emit('open');
		first.emit(
			'message',
			frame({ ev: 'error', uploadId, status: 503, message: 'overloaded' })
		);
		first.emit('close', 1006, '');

		await vi.advanceTimersByTimeAsync(50);
		second.emit('upgrade', { headers: {} });
		second.emit('open');
		const replayed = [...second.sent];

		// Past the retry armed on the dropped connection.
		await vi.advanceTimersByTimeAsync(1000);
		second.emit('message', settledFrame(uploadId));

		expect({
			replayed,
			sent: second.sent,
			ack: await ackOf(commit)
		}).toStrictEqual({
			replayed: [commitOp(uploadId)],
			sent: [commitOp(uploadId)],
			ack: { storePathHash, narHash, status: 'committed' }
		});
	});
});

describe('late commit after clean close', () => {
	// The server closes a socket it has heard nothing on for a long time. That
	// costs a session with nothing outstanding nothing at all, so the next commit
	// opens a fresh connection rather than failing. A session the caller closed
	// stays closed, which the case below asserts.
	it('reopens the connection for a commit issued after the server closed an idle socket', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second]);

		first.emit('open');
		first.emit('close', 1000, '');

		const reopened = session.commit(target);
		await Promise.resolve();
		second.emit('open');
		second.emit(
			'message',
			frame({
				ev: 'settled',
				uploadId,
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		expect({ sent: second.sent, ack: await ackOf(reopened) }).toStrictEqual({
			sent: [commitOp(uploadId)],
			ack: { storePathHash, narHash, status: 'committed' }
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
		// socket drops, so the drop enters the reconnect path.
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

// The server's side of an upgrade that paces the session by credit: `grant`
// entries to start with, and batches of at most `max` entries.
function advertiseCredit(
	socket: FakeCommitSocket,
	grant: number,
	max = commitBatchMaxEntries
): void {
	socket.emit('upgrade', {
		headers: {
			'x-cupboard-commit-capabilities': `commit-batch;max=${String(max)},commit-credit;grant=${String(grant)}`
		}
	});
}

function requestCreditOp(entries: number): string {
	return JSON.stringify({ op: 'request-credit', entries });
}

function deferredFrame(id: string): string {
	return frame({ ev: 'deferred', uploadId: id, storePathHash, narHash });
}

function settledFrame(id: string): string {
	return frame({
		ev: 'settled',
		uploadId: id,
		response: { storePathHash, narHash, status: 'committed' }
	});
}

const queuedIds = ['upload-1', 'upload-2', 'upload-3'];

describe('credit-paced commits', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// A session that opens on nothing declares its whole queue once, then spends
	// each grant as it arrives. It re-declares only when the queue outgrows what
	// it last declared, so a steady drain costs one declaration.
	it('declares its queue when it opens on no credit and sends what each grant covers', () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commits = queuedIds.map((id) => session.commit(targetFor(id)));

		advertiseCredit(socket, 0, 2);
		socket.emit('open');
		const declared = [...socket.sent];

		socket.emit('message', frame({ ev: 'credit', grant: 2 }));

		expect({
			pending: commits.length,
			declared,
			afterGrant: socket.sent
		}).toStrictEqual({
			pending: 3,
			declared: [requestCreditOp(3)],
			afterGrant: [requestCreditOp(3), batchOp(['upload-1', 'upload-2'])]
		});
	});

	// Waiting describes the session rather than any one frame: it holds whenever
	// paths are queued with nothing to send them under, and it ends when a grant
	// arrives. The callback reports that state and nothing more, since the
	// server's rotation moves as soon as any entry settles anywhere.
	it('reports waiting for capacity while paths are queued with no credit', () => {
		const socket = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSession(socket, {
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		void session.commit(target);

		advertiseCredit(socket, 0);
		socket.emit('open');
		socket.emit('message', frame({ ev: 'queued', ahead: 2 }));
		const whileQueued = [...reported];

		socket.emit('message', frame({ ev: 'credit', grant: 1 }));

		expect({ whileQueued, afterGrant: reported }).toStrictEqual({
			whileQueued: [true],
			afterGrant: [true, false]
		});
	});

	// Every ending of a wait is reported, however it ended, so a caller that
	// keeps its own record of the session never has a stale one. The queued
	// paths reject with the capacity timeout, and that rejection is what says
	// the wait ended in failure.
	it('reports the end of a wait when the wait expires', async () => {
		const socket = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSession(socket, {
			timeoutSeconds: 100,
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(socket, 0);
		socket.emit('open');
		const whileQueued = [...reported];

		await vi.advanceTimersByTimeAsync(101_000);
		const error = await expired;

		expect({
			whileQueued,
			afterExpiry: reported,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			whileQueued: [true],
			afterExpiry: [true, false],
			waitedSeconds: 100
		});
	});

	// A cache that refuses every dial with a server error is retried for the
	// whole budget, because a transient fault heals and the clock is what
	// bounds the attempt. What the operator needs from the failure is the
	// refusal, not just the length of the wait, so the timeout carries the last
	// one the session met.
	it('carries the refusal it kept meeting into an expired wait', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);

		const sockets = [
			new FakeCommitSocket(),
			new FakeCommitSocket(),
			new FakeCommitSocket()
		];
		const session = openSessionOver(sockets, {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 10,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		for (const socket of sockets) {
			const refusal = new FakeUpgradeFailure(500);
			socket.emit('unexpected-response', {}, refusal);
			refusal.emit('data', Buffer.from('commit credit budget is not a number'));
			refusal.emit('end');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		const error = await expired;
		const met = error.cause.cause;
		expectError(met, CupboardHttpError);

		expect({
			waitedSeconds: error.waitedSeconds,
			status: met.status,
			body: met.body
		}).toStrictEqual({
			waitedSeconds: 10,
			status: 500,
			body: 'commit credit budget is not a number'
		});
	});

	// A refusal belongs to the wait it was met during. Once that wait has
	// expired and reported it, a later wait that meets no refusal reports the
	// wait alone, rather than pointing the operator at a condition from before
	// the previous failure.
	it('leaves a refusal behind with the wait that reported it', async () => {
		const refused = new FakeCommitSocket();
		const idle = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([refused, idle, second], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 10,
			keepaliveMs: 600_000
		});
		const first = session.commit(target);
		const firstExpired = rejectedBy(first, CommitCapacityTimeoutError);

		const refusal = new FakeUpgradeFailure(503);
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		await vi.advanceTimersByTimeAsync(11_000);
		const firstError = await firstExpired;
		const met = firstError.cause.cause;
		expectError(met, CupboardHttpError);

		// The wait that follows meets a cache that takes the session and grants
		// it nothing, which refuses no dial at all.
		const later = session.commit(targetFor('upload-2'));
		const laterExpired = rejectedBy(later, CommitCapacityTimeoutError);
		advertiseCredit(second, 0, 1);
		second.emit('open');
		await vi.advanceTimersByTimeAsync(11_000);
		const laterError = await laterExpired;

		expect({
			firstStatus: met.status,
			laterMet: laterError.cause.cause
		}).toStrictEqual({
			firstStatus: 503,
			laterMet: undefined
		});
	});

	// A grant on the 101 is an offer, and `ws` reports the 101 before it has
	// checked the handshake, so a hop that answers every dial with a grant and
	// a handshake the client rejects never opens a connection. Such a dial
	// makes no progress for the session, and the wait it is spending has to
	// end it: its drops cost no reconnect budget, so nothing else would.
	it('expires a wait against a peer whose granting upgrades never open', async () => {
		const dialled = Array.from({ length: 8 }, () => new FakeCommitSocket());
		const spare = Array.from({ length: 8 }, () => new FakeCommitSocket());
		const session = openSessionOver([...dialled, ...spare], {
			headers: creditDeclaringHeaders,
			maxReconnects: 2,
			timeoutSeconds: 30,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);
		let isRejected = false;
		void commit.catch(() => {
			isRejected = true;
		});

		for (const socket of dialled) {
			advertiseCredit(socket, 1, 1);
			socket.emit('error', new Error('invalid Sec-WebSocket-Accept header'));
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		// The wait ends the loop. Its type says how: a session failed by the
		// reconnect budget instead would reject with a protocol error.
		expect(isRejected).toBe(true);

		const error = await expired;

		expect({
			waitedSeconds: error.waitedSeconds,
			met: error.cause.cause
		}).toStrictEqual({
			waitedSeconds: 30,
			met: undefined
		});
	});

	// The opening grant counts as progress once the connection carrying it
	// opens, the same as a `credit` frame does, so it ends the wait it arrived
	// during and the next wait runs a whole budget. A cache that takes the
	// session and grants it nothing has made no progress for it, which is why a
	// grant of zero elsewhere in these tests leaves a wait running.
	it('starts a fresh wait when the upgrade carries a grant', async () => {
		const refused = new FakeCommitSocket();
		const granting = new FakeCommitSocket();
		const idle = new FakeCommitSocket();
		const session = openSessionOver([refused, granting, idle], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 10,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);
		let isRejected = false;
		void commit.catch(() => {
			isRejected = true;
		});

		const refusal = new FakeUpgradeFailure(503);
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		await vi.advanceTimersByTimeAsync(8000);

		// The dial that follows is granted credit and takes the entry, then dies
		// before answering it, so the entry waits again from here.
		advertiseCredit(granting, 1, 1);
		granting.emit('open');
		granting.emit('close', 1006, '');

		await vi.advanceTimersByTimeAsync(5000);
		const isRejectedInsideBudget = isRejected;
		await vi.advanceTimersByTimeAsync(6000);
		const error = await expired;

		expect({
			isRejectedInsideBudget,
			waitedSeconds: error.waitedSeconds,
			met: error.cause.cause
		}).toStrictEqual({
			isRejectedInsideBudget: false,
			waitedSeconds: 10,
			met: undefined
		});
	});

	// A server that rejects `request-credit` takes the session off credit, which
	// ends the credited wait as surely as a grant would: what follows is the
	// session's own window, and a later connection that paces it again starts
	// its wait over.
	it('starts a fresh wait when the server drops it off credit', async () => {
		const refused = new FakeCommitSocket();
		const unpaced = new FakeCommitSocket();
		const paced = new FakeCommitSocket();
		const idle = new FakeCommitSocket();
		const session = openSessionOver([refused, unpaced, paced, idle], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 10,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);
		let isRejected = false;
		void commit.catch(() => {
			isRejected = true;
		});

		const refusal = new FakeUpgradeFailure(503);
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		await vi.advanceTimersByTimeAsync(8000);

		// This server knows nothing of credit, so the session sends the entry
		// through its own window instead, and the connection then drops.
		advertiseCredit(unpaced, 0, 1);
		unpaced.emit('open');
		unpaced.emit('message', frame({ ev: 'unsupported', op: 'request-credit' }));
		unpaced.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The connection after it paces the session again, and its wait is its
		// own.
		advertiseCredit(paced, 0, 1);
		paced.emit('open');
		await vi.advanceTimersByTimeAsync(5000);
		const isRejectedInsideBudget = isRejected;
		await vi.advanceTimersByTimeAsync(6000);
		const error = await expired;

		expect({
			isRejectedInsideBudget,
			waitedSeconds: error.waitedSeconds,
			met: error.cause.cause
		}).toStrictEqual({
			isRejectedInsideBudget: false,
			waitedSeconds: 10,
			met: undefined
		});
	});

	// A cache that gives the session progress and then stops has nothing to
	// answer for in the refusal it gave earlier, so the wait that expires
	// afterwards reports the wait alone.
	it('reports a plain capacity cause when the cache made progress after a refusal', async () => {
		const refused = new FakeCommitSocket();
		const serving = new FakeCommitSocket();
		const session = openSessionOver([refused, serving], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 10,
			keepaliveMs: 600_000
		});
		const parked = session.commit(target);
		void settledOf(parked).catch(() => {
			return;
		});

		const refusal = new FakeUpgradeFailure(503);
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The dial that follows makes progress: the entry is taken and answered,
		// which is the cache working rather than refusing.
		advertiseCredit(serving, 1, 1);
		serving.emit('open');
		serving.emit('message', deferredFrame(uploadId));

		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		await vi.advanceTimersByTimeAsync(11_000);
		const error = await expired;

		expect({
			waitedSeconds: error.waitedSeconds,
			met: error.cause.cause
		}).toStrictEqual({
			waitedSeconds: 10,
			met: undefined
		});
	});

	// A session closed while it waits is no longer waiting, and it reports that,
	// so a caller holding an announcement back for that wait can drop it.
	it('reports the end of a wait when the session closes during one', () => {
		const socket = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSession(socket, {
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		void session.commit(target);

		advertiseCredit(socket, 0);
		socket.emit('open');
		const whileQueued = [...reported];

		session.close();

		expect({ whileQueued, afterClose: reported }).toStrictEqual({
			whileQueued: [true],
			afterClose: [true, false]
		});
	});

	// A wait that expires and a wait that follows it are two separate waits, and
	// each is announced in its turn. A caller that announces only a wait which
	// lasts therefore never misses the second one.
	it('reports a second wait after one has expired', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSessionOver([first, second], {
			timeoutSeconds: 100,
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(first, 0);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(101_000);
		await expired;
		const afterExpiry = [...reported];

		const later = session.commit(targetFor('upload-2'));
		void later.catch(() => {
			return;
		});
		advertiseCredit(second, 0);
		second.emit('open');

		expect({ afterExpiry, afterSecondWait: reported }).toStrictEqual({
			afterExpiry: [true, false],
			afterSecondWait: [true, false, true]
		});
	});

	// A caller that commits one path at a time against a server granting one
	// entry at a time waits between each path and its grant, so the flag
	// toggles twice per path. A reporter that showed every toggle would print
	// two lines per path, which is why `build-push` announces only a wait that
	// lasts.
	it('toggles the waiting flag once per path when each grant covers one', async () => {
		const socket = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSession(socket, {
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});

		advertiseCredit(socket, 0, 1);
		socket.emit('open');

		for (const id of queuedIds) {
			const commit = session.commit(targetFor(id));
			await vi.advanceTimersByTimeAsync(0);
			socket.emit('message', frame({ ev: 'credit', grant: 1 }));
			socket.emit('message', settledFrame(id));
			await commit;
		}

		expect(reported).toStrictEqual([true, false, true, false, true, false]);
	});

	// The budget measures one unbroken stretch during which the cache gives the
	// session no progress. A cache that has stopped making progress runs that
	// stretch out, and every path still queued fails.
	it('expires the queued paths when the cache makes no progress for a whole budget', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
			// Long enough that no keepalive lands in the traffic asserted below.
			keepaliveMs: 600_000
		});
		// The rejections land while the clock is being advanced, so the
		// assertions take hold of the promises before that rather than after.
		const expiries = queuedIds.map((id) =>
			rejectedBy(session.commit(targetFor(id)), CommitCapacityTimeoutError)
		);

		advertiseCredit(socket, 0, 1);
		socket.emit('open');
		socket.emit('message', frame({ ev: 'queued', ahead: 3 }));

		await vi.advanceTimersByTimeAsync(101_000);
		const errors = await Promise.all(expiries);

		expect({
			expired: errors.map((error) => ({
				timeoutSeconds: error.timeoutSeconds,
				waitedSeconds: error.waitedSeconds,
				totalWaitedSeconds: error.totalWaitedSeconds,
				ahead: error.cause.ahead
			})),
			sent: socket.sent
		}).toStrictEqual({
			expired: queuedIds.map(() => ({
				timeoutSeconds: 100,
				waitedSeconds: 100,
				totalWaitedSeconds: 100,
				ahead: 3
			})),
			sent: [requestCreditOp(3)]
		});
	});

	// A budget of weeks is longer than a timer can hold, and a runtime truncates
	// such a delay to a millisecond. The deadline is armed in instalments
	// instead, so it stays armed across the boundary and expires only once the
	// wait has really run the budget out.
	it('holds a capacity budget longer than a timer can carry', async () => {
		const socket = new FakeCommitSocket();
		const timeoutSeconds = 4 * 7 * 24 * 60 * 60;
		const session = openSession(socket, {
			// A keepalive is an interval, which a runtime truncates the same way,
			// so the test keeps it under the boundary as well as rare.
			keepaliveMs: maxTimerDelayMs,
			timeoutSeconds
		});
		const commit = session.commit(target);
		let isRejected = false;
		void commit.catch(() => {
			isRejected = true;
		});

		advertiseCredit(socket, 0);
		socket.emit('open');

		await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
		const isRejectedAtBoundary = isRejected;

		const expired = rejectedBy(commit, CommitCapacityTimeoutError);
		await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000 - maxTimerDelayMs);
		const error = await expired;

		expect({
			atBoundary: isRejectedAtBoundary,
			timeoutSeconds: error.timeoutSeconds,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			atBoundary: false,
			timeoutSeconds,
			waitedSeconds: timeoutSeconds
		});
	});

	// The same instalments carry a deferred upload's verdict deadline, which is
	// armed from the same budget.
	it('holds a verdict deadline longer than a timer can carry', async () => {
		const socket = new FakeCommitSocket();
		const timeoutSeconds = 4 * 7 * 24 * 60 * 60;
		const session = openSession(socket, {
			keepaliveMs: maxTimerDelayMs,
			timeoutSeconds
		});
		const commit = session.commit(target);
		const settled = settledOf(commit);
		let isRejected = false;
		void settled.catch(() => {
			isRejected = true;
		});

		advertiseCredit(socket, 1, 1);
		socket.emit('open');
		socket.emit('message', deferredFrame(uploadId));

		await vi.advanceTimersByTimeAsync(maxTimerDelayMs);
		const isRejectedAtBoundary = isRejected;

		const timedOut = rejectedBy(settled, UploadWaitTimeoutError);
		await vi.advanceTimersByTimeAsync(timeoutSeconds * 1000 - maxTimerDelayMs);
		const error = await timedOut;

		expect({
			atBoundary: isRejectedAtBoundary,
			timeoutSeconds: error.timeoutSeconds,
			pending: error.pending
		}).toStrictEqual({
			atBoundary: false,
			timeoutSeconds,
			pending: 1
		});
	});

	// A frame for an upload the session does not hold is a stale duplicate: the
	// server re-answering a re-sent id, or answering one from before a
	// reconnect. It makes no progress for the session, so a cache that
	// repeats such frames while granting nothing runs the budget out like any
	// other silent cache.
	it('expires a wait that is fed only frames for uploads it does not hold', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(socket, 0, 1);
		socket.emit('open');

		for (const id of ['upload-gone-1', 'upload-gone-2', 'upload-gone-3']) {
			await vi.advanceTimersByTimeAsync(30_000);
			socket.emit('message', settledFrame(id));
		}

		await vi.advanceTimersByTimeAsync(11_000);
		const error = await expired;

		expect({
			waitedSeconds: error.waitedSeconds,
			totalWaitedSeconds: error.totalWaitedSeconds
		}).toStrictEqual({
			waitedSeconds: 100,
			totalWaitedSeconds: 100
		});
	});

	// Echoing one earns a connection no reconnect either. A cache that answers
	// ids the session has already finished has answered no entry the session is
	// waiting on, so each dead connection spends a reconnect and the push fails
	// instead of reconnecting for ever.
	it('spends a reconnect for a connection that only repeats an upload it does not hold', async () => {
		const sockets = [
			new FakeCommitSocket(),
			new FakeCommitSocket(),
			new FakeCommitSocket()
		];
		const session = openSessionOver(sockets, {
			maxReconnects: 2,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const failed = rejectedBy(commit, CommitSocketProtocolError);

		for (const socket of sockets) {
			advertiseCredit(socket, 1, 1);
			socket.emit('open');
			socket.emit('message', settledFrame('upload-gone'));
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		const error = await failed;

		expect(error.path).toBe(path);
	});

	// The same frame for an entry the session does hold is the server answering
	// that entry, which shows the connection can carry work, so each drop that
	// follows one costs no more of the reconnect budget than the first did.
	it('restores the reconnect budget for each entry a connection answers', async () => {
		const sockets = [
			new FakeCommitSocket(),
			new FakeCommitSocket(),
			new FakeCommitSocket()
		];
		const session = openSessionOver(sockets, {
			maxReconnects: 1,
			keepaliveMs: 600_000
		});
		const commits = queuedIds.map((id) => session.commit(targetFor(id)));

		for (const [index, id] of queuedIds.entries()) {
			const socket = sockets[index];

			if (socket === undefined) {
				throw new Error('expected a socket per connection');
			}

			advertiseCredit(socket, 3, 1);
			socket.emit('open');
			socket.emit('message', settledFrame(id));

			// Every connection but the last drops, spending the one reconnect the
			// budget holds and restoring it with the entry it answered.
			if (index < sockets.length - 1) {
				socket.emit('close', 1006, '');
				await vi.advanceTimersByTimeAsync(maxBackoffMs);
			}
		}

		expect(
			await Promise.all(commits.map((commit) => ackOf(commit)))
		).toStrictEqual(
			queuedIds.map(() => ({ storePathHash, narHash, status: 'committed' }))
		);
	});

	// A cache that is down or firewalled never completes an upgrade, so the
	// session learns no grant from a 101 and has no connection to measure. It is
	// paced by what it declared on the request, which is what the server pins
	// pacing to, so the clock runs from the first commit and the budget ends the
	// wait. This is the base case of the model: with no connection ever
	// established, nothing else bounds the session at all.
	it('expires a wait against a cache it never reaches', async () => {
		const failing = Array.from({ length: 4 }, () => new FakeCommitSocket());
		// The dial the last failure schedules, which the budget runs out under.
		const lastDial = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSessionOver([...failing, lastDial], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 100,
			keepaliveMs: 600_000,
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		// Every dial fails at the socket, before any upgrade reaches the client.
		for (const dial of failing) {
			dial.emit('error', new Error('connect ECONNREFUSED'));
			await vi.advanceTimersByTimeAsync(30_000);
		}

		const error = await expired;

		// A further dial would throw for want of a socket, so this also shows the
		// session stopped dialling when it gave up.
		await vi.advanceTimersByTimeAsync(60_000);

		expect({
			waitedSeconds: error.waitedSeconds,
			reported
		}).toStrictEqual({
			waitedSeconds: 100,
			reported: [true, false]
		});
	});

	// A cache that stops answering the dial makes no progress for the
	// session, which is the same wait as a cache that answers and grants
	// nothing, so the clock runs on and the budget ends it. Nothing else
	// would: an entry the session never sent has no deadline of its own, and
	// a dial that fails before it opens leaves nothing in flight, so it
	// spends no reconnect budget.
	//
	// Four connections are scripted after the first. A fifth would throw for
	// want of a socket, so the assertions below also show the session stopped
	// dialling once it gave up.
	it('expires a wait that a partition never lets it resume', async () => {
		const first = new FakeCommitSocket();
		const dials = Array.from({ length: 4 }, () => new FakeCommitSocket());
		const session = openSessionOver([first, ...dials], {
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(first, 0, 1);
		first.emit('open');
		first.emit('close', 1006, '');

		// Every dial from here fails before it opens, which is what `ws` reports
		// for a refused or reset handshake.
		for (const dial of dials) {
			await vi.advanceTimersByTimeAsync(30_000);
			dial.emit('error', new Error('connect ECONNREFUSED'));
		}

		const error = await expired;
		await vi.advanceTimersByTimeAsync(60_000);

		expect({
			timeoutSeconds: error.timeoutSeconds,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			timeoutSeconds: 100,
			waitedSeconds: 100
		});
	});

	// An entry parked on its verdict is bounded by its own verdict deadline,
	// which runs whether or not the session is connected, so the drops that
	// interrupt the park cost no reconnect budget. The server holds a durable
	// row for such an entry, and a link that flaps more often than the budget
	// allows must not fail work the next resubscribe would have collected.
	it('survives more drops than the reconnect budget while its entry is parked', async () => {
		const dropped = Array.from({ length: 6 }, () => new FakeCommitSocket());
		const last = new FakeCommitSocket();
		const session = openSessionOver([...dropped, last], {
			maxReconnects: 2,
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const parked = session.commit(target);
		const timedOut = rejectedBy(settledOf(parked), UploadWaitTimeoutError);

		// Every connection answers the resubscribe with a repeat deferral, which
		// is what the server sends for a row that is still pending.
		for (const socket of dropped) {
			advertiseCredit(socket, 1, 1);
			socket.emit('open');
			socket.emit('message', deferredFrame(uploadId));
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		advertiseCredit(last, 1, 1);
		last.emit('open');
		last.emit('message', deferredFrame(uploadId));

		// The verdict never comes, so the entry ends on its own deadline rather
		// than on a protocol error from an exhausted budget.
		await vi.advanceTimersByTimeAsync(101_000);
		const error = await timedOut;

		expect({
			timeoutSeconds: error.timeoutSeconds,
			ack: await ackOf(parked)
		}).toStrictEqual({
			timeoutSeconds: 100,
			ack: { storePathHash, narHash, status: 'pending' }
		});
	});

	// The first deferral of an entry answers it, so each connection that takes
	// one restores the reconnect budget and the session survives more drops than
	// that budget holds.
	it('restores the reconnect budget for each entry a connection parks', async () => {
		const sockets = [
			new FakeCommitSocket(),
			new FakeCommitSocket(),
			new FakeCommitSocket()
		];
		const session = openSessionOver(sockets, {
			maxReconnects: 1,
			keepaliveMs: 600_000
		});
		const parked = ['upload-1', 'upload-2'].map((id) =>
			session.commit(targetFor(id))
		);

		// Each of the first two connections parks a different entry, so each
		// restores the one reconnect its drop then spends.
		for (const [index, id] of ['upload-1', 'upload-2'].entries()) {
			const socket = sockets[index];

			if (socket === undefined) {
				throw new Error('expected a socket per connection');
			}

			advertiseCredit(socket, 1, 1);
			socket.emit('open');
			socket.emit('message', deferredFrame(id));
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		const last = sockets[2];

		if (last === undefined) {
			throw new Error('expected a final socket');
		}

		advertiseCredit(last, 1, 1);
		last.emit('open');

		for (const id of ['upload-1', 'upload-2']) {
			last.emit(
				'message',
				frame({ ev: 'verdict', uploadId: id, status: 'servable' })
			);
		}

		expect(
			await Promise.all(parked.map((commit) => ackOf(commit)))
		).toStrictEqual([
			{ storePathHash, narHash, status: 'pending' },
			{ storePathHash, narHash, status: 'pending' }
		]);
	});

	// A grant is not proof that a connection can carry work. A cache that
	// answers `request-credit` and then dies before it answers any entry has to
	// spend a reconnect for each attempt, so the push fails where restoring the
	// budget once per cycle would reconnect for ever.
	it('exhausts the reconnect budget when every connection dies after granting', async () => {
		const sockets = [
			new FakeCommitSocket(),
			new FakeCommitSocket(),
			new FakeCommitSocket()
		];
		const session = openSessionOver(sockets, {
			maxReconnects: 2,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const failed = rejectedBy(commit, CommitSocketProtocolError);

		// One cycle per scripted connection: it grants, the session sends the
		// commit under that grant, and the socket dies unanswered.
		for (const socket of sockets) {
			advertiseCredit(socket, 0, 1);
			socket.emit('open');
			socket.emit('message', frame({ ev: 'credit', grant: 1 }));
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		const error = await failed;

		expect({
			path: error.path,
			traffic: sockets.map((socket) => socket.sent)
		}).toStrictEqual({
			path,
			traffic: sockets.map(() => [requestCreditOp(1), batchOp(['upload-app'])])
		});
	});

	// A cache that keeps making progress for the session never expires it,
	// however slowly that progress comes: each grant and each answered entry
	// starts the measurement again. Here the session waits nine tenths of
	// its budget before
	// every path, so it waits more than two budgets in total and still commits
	// every one of them.
	it('never expires while the cache keeps making progress, whatever the total wait', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const commits = queuedIds.map((id) => session.commit(targetFor(id)));

		advertiseCredit(socket, 0, 1);
		socket.emit('open');

		for (const id of queuedIds) {
			await vi.advanceTimersByTimeAsync(90_000);
			socket.emit('message', frame({ ev: 'credit', grant: 1 }));
			socket.emit('message', settledFrame(id));
		}

		expect({
			acks: await Promise.all(commits.map((commit) => ackOf(commit))),
			sent: socket.sent
		}).toStrictEqual({
			acks: queuedIds.map(() => ({
				storePathHash,
				narHash,
				status: 'committed'
			})),
			sent: [
				requestCreditOp(3),
				batchOp(['upload-1']),
				batchOp(['upload-2']),
				batchOp(['upload-3'])
			]
		});
	});

	// An entry the server has still to answer is one the cache is working on,
	// and answering it returns the credit the queue is waiting for. So the
	// budget does not run while any entry is outstanding, however long the queue
	// behind it, and starts once the last of them is answered.
	it('spends none of the budget while an entry it sent is in flight', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { timeoutSeconds: 100 });
		void session.commit(targetFor('upload-1'));

		advertiseCredit(socket, 1, 1);
		socket.emit('open');

		const queued = session.commit(targetFor('upload-2'));
		let isRejected = false;
		void queued.catch(() => {
			isRejected = true;
		});

		// upload-1 spent the opening grant and no frame has answered it, so the
		// queued path waits behind it without the budget running.
		await vi.advanceTimersByTimeAsync(500_000);
		const isRejectedWhileInFlight = isRejected;

		socket.emit('message', settledFrame('upload-1'));
		await vi.advanceTimersByTimeAsync(99_000);
		const isRejectedMidway = isRejected;
		await vi.advanceTimersByTimeAsync(2000);
		const error = await rejectedBy(queued, CommitCapacityTimeoutError);

		expect({
			whileInFlight: isRejectedWhileInFlight,
			midway: isRejectedMidway,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			whileInFlight: false,
			midway: false,
			waitedSeconds: 100
		});
	});

	// An error frame is an answer like any other: the server released that
	// entry's credit when it sent the frame, and it owes the session nothing
	// further for the id. The retry re-queues the target behind the backlog, so
	// the session waits from the moment the error lands and its budget runs.
	it('starts the capacity wait when a retryable error re-queues its entry', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
			// Long enough that no keepalive lands in the traffic asserted below.
			keepaliveMs: 600_000
		});
		const retried = session.commit(targetFor('upload-1'));
		const queued = session.commit(targetFor('upload-2'));
		const retriedExpiry = rejectedBy(retried, CommitCapacityTimeoutError);
		const queuedExpiry = rejectedBy(queued, CommitCapacityTimeoutError);
		let isRejected = false;
		void retried.catch(() => {
			isRejected = true;
		});

		advertiseCredit(socket, 1, 1);
		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'error',
				uploadId: 'upload-1',
				status: 503,
				message: 'overloaded'
			})
		);

		// The retry re-queues upload-1 behind upload-2, and the tenant grants
		// nothing, so nothing goes out for the rest of the wait.
		await vi.advanceTimersByTimeAsync(99_000);
		const isMidway = isRejected;
		await vi.advanceTimersByTimeAsync(2000);

		const retriedError = await retriedExpiry;
		const queuedError = await queuedExpiry;

		expect({
			midway: isMidway,
			retriedWaitedSeconds: retriedError.waitedSeconds,
			queuedWaitedSeconds: queuedError.waitedSeconds,
			sent: socket.sent
		}).toStrictEqual({
			midway: false,
			retriedWaitedSeconds: 100,
			queuedWaitedSeconds: 100,
			sent: [batchOp(['upload-1']), requestCreditOp(1), requestCreditOp(2)]
		});
	});

	// The wait ends as any other does, when the session has an entry the server
	// has still to answer. Here that entry is the retried one, sent under the
	// grant that ended the wait. The grant reset the measurement, so the wait
	// that follows has the whole budget to run through.
	it('stops the capacity wait when the retried entry goes back on the wire', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
			// Long enough that no keepalive lands in the traffic asserted below.
			keepaliveMs: 600_000
		});
		const retried = session.commit(targetFor('upload-1'));
		let isRetriedRejected = false;
		void retried.catch(() => {
			isRetriedRejected = true;
		});

		advertiseCredit(socket, 1, 1);
		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'error',
				uploadId: 'upload-1',
				status: 503,
				message: 'overloaded'
			})
		);

		// Stalled from the error frame until the grant: sixty seconds of budget.
		await vi.advanceTimersByTimeAsync(60_000);
		socket.emit('message', frame({ ev: 'credit', grant: 1 }));

		// The resend is on the wire, so this stretch, three times the budget,
		// costs it nothing.
		await vi.advanceTimersByTimeAsync(300_000);
		const isRejectedWhileInFlight = isRetriedRejected;
		socket.emit('message', settledFrame('upload-1'));

		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		let isQueuedRejected = false;
		void queued.catch(() => {
			isQueuedRejected = true;
		});

		// The grant and the answer that followed it each reset the measurement,
		// so this wait starts from zero with the whole budget to run through.
		// The sixty seconds before them survive only in the lifetime total.
		await vi.advanceTimersByTimeAsync(99_000);
		const isMidway = isQueuedRejected;
		await vi.advanceTimersByTimeAsync(2000);

		const error = await expired;

		expect({
			rejectedWhileInFlight: isRejectedWhileInFlight,
			midway: isMidway,
			waitedSeconds: error.waitedSeconds,
			totalWaitedSeconds: error.totalWaitedSeconds,
			ack: await ackOf(retried),
			sent: socket.sent
		}).toStrictEqual({
			rejectedWhileInFlight: false,
			midway: false,
			waitedSeconds: 100,
			totalWaitedSeconds: 160,
			ack: { storePathHash, narHash, status: 'committed' },
			sent: [
				batchOp(['upload-1']),
				requestCreditOp(1),
				batchOp(['upload-1']),
				requestCreditOp(1)
			]
		});
	});

	// An entry can finish while its target is still queued: a retryable error
	// re-queues it, and the verdict for the row the server had already attached
	// arrives later. The session will never send that target, so it stops
	// counting as a path waiting for capacity and is not declared to the server
	// as demand.
	it('stops waiting for a queue whose entries have all finished', async () => {
		const socket = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSession(socket, {
			keepaliveMs: 600_000,
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		const retried = session.commit(targetFor('upload-1'));

		advertiseCredit(socket, 1, 1);
		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'error',
				uploadId: 'upload-1',
				status: 503,
				message: 'overloaded'
			})
		);

		// The retry re-queues upload-1 with no credit to send it under, so the
		// session declares it and waits; the late verdict then finishes it.
		await vi.advanceTimersByTimeAsync(500);
		const whileQueued = [...reported];
		socket.emit(
			'message',
			frame({ ev: 'verdict', uploadId: 'upload-1', status: 'servable' })
		);
		const afterVerdict = [...reported];

		// A real path committed now is one path, and the one entry of demand the
		// session has already declared covers it, so it declares nothing further.
		// A queue still holding the finished target would have declared two.
		const later = session.commit(targetFor('upload-2'));
		await vi.advanceTimersByTimeAsync(0);
		socket.emit('message', frame({ ev: 'credit', grant: 1 }));
		socket.emit('message', settledFrame('upload-2'));

		let isRetriedServable = false;
		void settledOf(retried).then(() => {
			isRetriedServable = true;
		});
		await vi.advanceTimersByTimeAsync(0);

		expect({
			whileQueued,
			afterVerdict,
			isRetriedServable,
			laterAck: await ackOf(later),
			sent: socket.sent
		}).toStrictEqual({
			whileQueued: [true],
			afterVerdict: [true, false],
			isRetriedServable: true,
			laterAck: { storePathHash, narHash, status: 'committed' },
			sent: [batchOp(['upload-1']), requestCreditOp(1), batchOp(['upload-2'])]
		});
	});

	// A retryable error re-queues its entry, and the answer to the first attempt
	// can still arrive while it waits there. The queued target is stale by then:
	// its id names a row the server has answered, so the next grant skips it and
	// spends nothing on it.
	it('skips a queued target whose entry settled before the grant arrived', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const retried = session.commit(targetFor('upload-1'));
		const queued = session.commit(targetFor('upload-2'));

		advertiseCredit(socket, 1, 1);
		socket.emit('open');
		socket.emit(
			'message',
			frame({
				ev: 'error',
				uploadId: 'upload-1',
				status: 503,
				message: 'overloaded'
			})
		);

		// The retry re-queues upload-1 behind upload-2, with no credit to send
		// either under, and the first attempt's answer arrives while it waits.
		await vi.advanceTimersByTimeAsync(500);
		socket.emit('message', settledFrame('upload-1'));

		socket.emit('message', frame({ ev: 'credit', grant: 2 }));
		socket.emit('message', settledFrame('upload-2'));

		expect({
			sent: socket.sent,
			acks: [await ackOf(retried), await ackOf(queued)]
		}).toStrictEqual({
			sent: [
				batchOp(['upload-1']),
				requestCreditOp(1),
				requestCreditOp(2),
				batchOp(['upload-2'])
			],
			acks: [
				{ storePathHash, narHash, status: 'committed' },
				{ storePathHash, narHash, status: 'committed' }
			]
		});
	});

	// The server returns an entry's credit with the first frame it sends for
	// that entry, the `deferred` frame included, and the verdict that follows
	// returns none. A session whose sent entries have all parked on their
	// verdicts is therefore waiting on capacity like any other, and its budget
	// runs.
	it('spends the budget while a sent entry parks on its verdict', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { timeoutSeconds: 100 });
		void session.commit(targetFor('upload-1'));

		advertiseCredit(socket, 1, 1);
		socket.emit('open');
		socket.emit('message', deferredFrame('upload-1'));

		const queued = session.commit(targetFor('upload-2'));
		let isRejected = false;
		void queued.catch(() => {
			isRejected = true;
		});

		await vi.advanceTimersByTimeAsync(99_000);
		const isMidway = isRejected;
		await vi.advanceTimersByTimeAsync(2000);
		const error = await rejectedBy(queued, CommitCapacityTimeoutError);

		expect({
			midway: isMidway,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			midway: false,
			waitedSeconds: 100
		});
	});

	// Parking an entry on its verdict answers that entry and returns its credit
	// to the tenant, so the queue behind it starts a new wait with the whole
	// budget, and the sixty seconds before the parking survive only in the
	// lifetime total. A cache that answers every entry with a deferral gives the
	// session as much progress as one that settles them.
	it('restarts the wait when an entry parks on its verdict', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], {
			timeoutSeconds: 100,
			// Long enough that no keepalive lands in the traffic asserted below.
			keepaliveMs: 600_000
		});
		const parked = session.commit(targetFor('upload-1'));
		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		// The parked entry is bounded by its own verdict deadline, armed for the
		// same budget when it parked, so it fails at that moment too.
		const parkedTimedOut = rejectedBy(
			settledOf(parked),
			UploadWaitTimeoutError
		);
		let isQueuedRejected = false;
		void queued.catch(() => {
			isQueuedRejected = true;
		});

		advertiseCredit(first, 0, 1);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(60_000);
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		advertiseCredit(second, 1, 1);
		second.emit('open');
		second.emit('message', deferredFrame('upload-1'));

		await vi.advanceTimersByTimeAsync(99_000);
		const isMidway = isQueuedRejected;
		await vi.advanceTimersByTimeAsync(2000);

		const error = await expired;
		const parkedError = await parkedTimedOut;

		expect({
			midway: isMidway,
			waitedSeconds: error.waitedSeconds,
			totalWaitedSeconds: error.totalWaitedSeconds,
			parkedAck: await ackOf(parked),
			parkedTimeoutSeconds: parkedError.timeoutSeconds
		}).toStrictEqual({
			midway: false,
			waitedSeconds: 100,
			// Three stretches: sixty seconds waiting before the drop, five
			// disconnected, and the hundred seconds of the wait that expired.
			// The deferred frame reset the wait the timeout measures, and this
			// total keeps all three.
			totalWaitedSeconds: 165,
			parkedAck: { storePathHash, narHash, status: 'pending' },
			parkedTimeoutSeconds: 100
		});
	});

	// A disconnection the session waits through is part of one wait, so the
	// caller hears the wait start once and end once. Reporting an end at every
	// drop would let a caller that announces only a sustained wait stay silent
	// through a long one, because each connected window is shorter than the
	// delay it holds the announcement for.
	it('reports one wait across the drops it waits through', async () => {
		const dropped = [
			new FakeCommitSocket(),
			new FakeCommitSocket(),
			new FakeCommitSocket()
		];
		const last = new FakeCommitSocket();
		const reported: boolean[] = [];
		const session = openSessionOver([...dropped, last], {
			timeoutSeconds: 100,
			keepaliveMs: 600_000,
			onWaiting: (isWaitingForCapacity) => {
				reported.push(isWaitingForCapacity);
			}
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		for (const socket of dropped) {
			advertiseCredit(socket, 0, 1);
			socket.emit('open');
			await vi.advanceTimersByTimeAsync(2000);
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		const whileDropping = [...reported];

		advertiseCredit(last, 0, 1);
		last.emit('open');
		await vi.advanceTimersByTimeAsync(100_000);
		const error = await expired;

		expect({
			whileDropping,
			afterExpiry: reported,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			whileDropping: [true],
			afterExpiry: [true, false],
			waitedSeconds: 100
		});
	});

	// The back-off is drawn from the number of reconnects since the server last
	// answered an entry, not from the reconnect budget, so a session that
	// reconnects for free while it waits still backs off to the cap. Otherwise a
	// cache that accepts a connection and drops it is reopened every few hundred
	// milliseconds for the whole budget, and the object never hibernates.
	//
	// The jitter is pinned to its lower bound, so each delay here is half of its
	// step's ceiling: 500, 1000, 2000, 4000, then the 5000 cap.
	it('backs off further on each free reconnect', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);

		const dropped = Array.from({ length: 5 }, () => new FakeCommitSocket());
		const last = new FakeCommitSocket();
		const connectedAt: number[] = [];
		const session = openSessionOver([...dropped, last], {
			timeoutSeconds: 600,
			keepaliveMs: 600_000,
			connectedAt
		});
		void session.commit(target).catch(() => {
			return;
		});

		const delays: number[] = [];

		for (const socket of dropped) {
			advertiseCredit(socket, 0, 1);
			socket.emit('open');
			socket.emit('close', 1006, '');
			const closedAt = Date.now();
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
			delays.push((connectedAt.at(-1) ?? 0) - closedAt);
		}

		expect(delays).toStrictEqual([250, 500, 1000, 2000, 2500]);
	});

	// The same counter serves the drops that do spend budget, and the server
	// answering an entry starts it again: the connection after that answer waits
	// the first step once more.
	it('starts the back-off again when the server answers an entry', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);

		const unanswered = [new FakeCommitSocket(), new FakeCommitSocket()];
		const answering = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const connectedAt: number[] = [];
		const session = openSessionOver([...unanswered, answering, last], {
			timeoutSeconds: 600,
			keepaliveMs: 600_000,
			connectedAt
		});
		const sent = session.commit(targetFor('upload-1'));
		void session.commit(targetFor('upload-2')).catch(() => {
			return;
		});

		const delays: number[] = [];

		// The first two connections take the entry and die unanswered, so each
		// drop spends budget and the back-off steps up.
		for (const socket of unanswered) {
			advertiseCredit(socket, 1, 1);
			socket.emit('open');
			socket.emit('close', 1006, '');
			const closedAt = Date.now();
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
			delays.push((connectedAt.at(-1) ?? 0) - closedAt);
		}

		advertiseCredit(answering, 1, 1);
		answering.emit('open');
		answering.emit('message', settledFrame('upload-1'));
		answering.emit('close', 1006, '');
		const closedAt = Date.now();
		await vi.advanceTimersByTimeAsync(maxBackoffMs);
		delays.push((connectedAt.at(-1) ?? 0) - closedAt);

		expect({
			ack: await ackOf(sent),
			delays
		}).toStrictEqual({
			ack: { storePathHash, narHash, status: 'committed' },
			delays: [250, 500, 250]
		});
	});

	// A server that refuses the upgrade sends `Retry-After` when it wants a
	// longer gap than the back-off would take, so the delay before the next dial
	// is at least the seconds it named, capped at a minute. A refusal that
	// carries no delay, or one the client cannot read, leaves the back-off alone.
	//
	// The jitter is pinned to its lower bound, so the back-off the first
	// reconnect would otherwise wait is 250 ms.
	it.each([
		{ what: 'a delay longer than the back-off', asked: '12', delayMs: 12_000 },
		{ what: 'a delay beyond the cap', asked: '3600', delayMs: 60_000 },
		{ what: 'no delay', asked: undefined, delayMs: 250 },
		{ what: 'a delay it cannot read', asked: 'in a while', delayMs: 250 }
	])(
		'waits $delayMs ms after an upgrade refusal naming $what',
		async ({ asked, delayMs }) => {
			vi.spyOn(Math, 'random').mockReturnValue(0);

			const refused = new FakeCommitSocket();
			const last = new FakeCommitSocket();
			const connectedAt: number[] = [];
			const session = openSessionOver([refused, last], {
				headers: creditDeclaringHeaders,
				timeoutSeconds: 600,
				keepaliveMs: 600_000,
				connectedAt
			});
			void session.commit(target).catch(() => {
				return;
			});

			const refusal = new FakeUpgradeFailure(
				503,
				asked === undefined ? {} : { 'retry-after': asked }
			);
			refused.emit('unexpected-response', {}, refusal);
			refusal.emit('data', Buffer.from('Commit sessions are busy'));
			refusal.emit('end');
			const refusedAt = Date.now();
			await vi.advanceTimersByTimeAsync(120_000);

			expect((connectedAt.at(-1) ?? 0) - refusedAt).toBe(delayMs);
		}
	);

	// `ws` hands a refused connection over to the session and abandons it in its
	// handshake, so closing it is the session's to do: a session that keeps
	// dialling against a busy cache would otherwise hold one open connection
	// per refusal, and each of those keeps the process alive after the run has
	// finished. The close is what returns the connection, so it is the close
	// this asserts rather than the state of the response.
	it('closes every connection an upgrade refusal arrives on', async () => {
		const refused = [new FakeCommitSocket(), new FakeCommitSocket()];
		const last = new FakeCommitSocket();
		const session = openSessionOver([...refused, last], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 600,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);

		for (const socket of refused) {
			const refusal = new FakeUpgradeFailure(503);
			socket.emit('unexpected-response', {}, refusal);
			refusal.emit('data', Buffer.from('Commit sessions are busy'));
			refusal.emit('end');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		advertiseCredit(last, 1, 1);
		last.emit('open');
		last.emit('message', settledFrame(uploadId));

		expect({
			closed: refused.map((socket) => socket.closed),
			ack: await ackOf(commit)
		}).toStrictEqual({
			closed: [true, true],
			ack: { storePathHash, narHash, status: 'committed' }
		});
	});

	// A refusal is read long after it arrives when the body stalls, and by then
	// the session may have left the connection it refused: here the capacity
	// wait expires, abandons that connection and goes dormant, and the next
	// commit is served over a fresh one. The refusal condemned a connection that
	// is gone, so reading it changes nothing, whatever its status.
	it('ignores a refusal read after the connection it refused was abandoned', async () => {
		const refused = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const session = openSessionOver([refused, last], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 3,
			keepaliveMs: 600_000
		});
		const abandoned = session.commit(target);
		const expired = rejectedBy(abandoned, CommitCapacityTimeoutError);

		// The status would end the session if the refusal were still the
		// session's to act on, and the body never arrives, so the drain is what
		// eventually reads it.
		const refusal = new FakeUpgradeFailure(403);
		refused.emit('unexpected-response', {}, refusal);
		await vi.advanceTimersByTimeAsync(3000);
		await expired;

		const resumed = session.commit(targetFor('upload-2'));
		await vi.advanceTimersByTimeAsync(0);
		advertiseCredit(last, 1, 1);
		last.emit('open');
		last.emit('message', settledFrame('upload-2'));
		await ackOf(resumed);

		// The drain of the abandoned connection falls here.
		await vi.advanceTimersByTimeAsync(drainTimeoutMs);
		const served = session.commit(targetFor('upload-3'));
		last.emit('message', settledFrame('upload-3'));

		await expect(ackOf(served)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
	});

	// A refusal that finds nothing outstanding leaves the session dormant, and
	// the dial the next commit makes is the one the server's wait applies to.
	// The session opens before a push has anything to commit, so this is the
	// refusal a loaded server is most likely to give.
	it('holds a dormant redial back until the wait a refusal asked for', async () => {
		const refused = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const connectedAt: number[] = [];
		const session = openSessionOver([refused, last], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 600,
			keepaliveMs: 600_000,
			connectedAt
		});

		const refusal = new FakeUpgradeFailure(503, { 'retry-after': '12' });
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		const refusedAt = Date.now();

		// The commit arrives inside the gap the server asked for, so its dial
		// waits out what is left of it.
		await vi.advanceTimersByTimeAsync(5000);
		void session.commit(target).catch(() => {
			return;
		});
		const dialsInsideGap = connectedAt.length;
		await vi.advanceTimersByTimeAsync(10_000);

		expect({
			dialsInsideGap,
			dialedAfterMs: (connectedAt.at(-1) ?? 0) - refusedAt
		}).toStrictEqual({
			dialsInsideGap: 1,
			dialedAfterMs: 12_000
		});
	});

	// A refusal that finds work outstanding has its wait honoured by the
	// reconnect it schedules, and that reconnect is not always the dial that
	// happens: an expiring capacity wait cancels it and leaves the session
	// dormant. The dial the next commit makes then owes the server the rest of
	// the wait it asked for.
	it('holds a redial back when a capacity expiry cancels the dial a refusal delayed', async () => {
		const refused = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const connectedAt: number[] = [];
		const session = openSessionOver([refused, last], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 3,
			keepaliveMs: 600_000,
			connectedAt
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		const refusal = new FakeUpgradeFailure(503, { 'retry-after': '5' });
		refused.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Commit sessions are busy'));
		refusal.emit('end');
		const refusedAt = Date.now();

		// The wait expires two seconds inside the gap, which cancels the dial
		// the refusal scheduled for the end of it.
		await vi.advanceTimersByTimeAsync(3000);
		await expired;

		void session.commit(targetFor('upload-2')).catch(() => {
			return;
		});
		const dialsInsideGap = connectedAt.length;
		await vi.advanceTimersByTimeAsync(5000);

		expect({
			dialsInsideGap,
			dialedAfterMs: (connectedAt.at(-1) ?? 0) - refusedAt
		}).toStrictEqual({
			dialsInsideGap: 1,
			dialedAfterMs: 5000
		});
	});

	// A peer can leave the refusal body unfinished: truncated and then
	// half-closed, or headers with a length it never sends the rest of. Neither
	// shape produces another event, so the session bounds the read and treats
	// the timeout as the refusal itself. The delay stated in a response that
	// never finished is not honoured, so the next dial takes the back-off.
	it.each([
		{ what: 'a truncated body', body: 'Commit sess' },
		{ what: 'no body at all', body: undefined }
	])('drops a refusal that never ends, given $what', async ({ body }) => {
		vi.spyOn(Math, 'random').mockReturnValue(0);

		const refused = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const connectedAt: number[] = [];
		const session = openSessionOver([refused, last], {
			headers: creditDeclaringHeaders,
			timeoutSeconds: 600,
			keepaliveMs: 600_000,
			connectedAt
		});
		const commit = session.commit(target);

		const refusal = new FakeUpgradeFailure(503, { 'retry-after': '12' });
		refused.emit('unexpected-response', {}, refusal);

		if (body !== undefined) {
			refusal.emit('data', Buffer.from(body));
		}

		const refusedAt = Date.now();
		await vi.advanceTimersByTimeAsync(drainTimeoutMs + maxBackoffMs);

		advertiseCredit(last, 1, 1);
		last.emit('open');
		last.emit('message', settledFrame(uploadId));

		expect({
			destroyed: refusal.destroyed,
			dialedAfterMs: (connectedAt.at(-1) ?? 0) - refusedAt,
			ack: await ackOf(commit)
		}).toStrictEqual({
			destroyed: true,
			dialedAfterMs: drainTimeoutMs + 250,
			ack: { storePathHash, narHash, status: 'committed' }
		});
	});

	// A drop while the session is doing nothing but wait costs no reconnect
	// budget: what bounds a wait is the capacity deadline. The wait also carries
	// on through the disconnection, since the cache makes no progress for
	// the session while it reconnects, so the two five-second gaps count
	// towards the hundred alongside each attempt's thirty connected seconds.
	it('counts a disconnection while it only waits, and spends no reconnect budget', async () => {
		const dropped = [new FakeCommitSocket(), new FakeCommitSocket()];
		const last = new FakeCommitSocket();
		const session = openSessionOver([...dropped, last], {
			maxReconnects: 1,
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		for (const socket of dropped) {
			advertiseCredit(socket, 0, 1);
			socket.emit('open');
			await vi.advanceTimersByTimeAsync(30_000);
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		advertiseCredit(last, 0, 1);
		last.emit('open');
		await vi.advanceTimersByTimeAsync(31_000);
		const error = await expired;

		expect({
			waitedSeconds: error.waitedSeconds,
			totalWaitedSeconds: error.totalWaitedSeconds
		}).toStrictEqual({
			waitedSeconds: 100,
			totalWaitedSeconds: 100
		});
	});

	// The clock runs on whatever the connection is doing: it stops only while
	// the cache owes the session an answer, and a grant starts it again. Here
	// the minute one entry spends unanswered costs the budget nothing, the ten
	// seconds queued before the grant are wiped by that grant, and what reaches
	// the hundred is the five seconds of the disconnection after it plus the
	// ninety-five the last connection spends granting nothing. Every one of
	// those stretches is still in the session's lifetime total.
	it('runs the clock through disconnection and stops it only for work in flight', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const third = new FakeCommitSocket();
		const session = openSessionOver([first, second, third], {
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const sent = session.commit(targetFor('upload-1'));
		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		let isQueuedRejected = false;
		void queued.catch(() => {
			isQueuedRejected = true;
		});
		void sent.catch(() => {
			return;
		});

		// Ten seconds waiting, then the drop that starts the disconnection.
		advertiseCredit(first, 0, 1);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(10_000);
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// This connection takes an entry and holds it for a minute before it
		// dies, which is working time rather than waiting time.
		advertiseCredit(second, 1, 1);
		second.emit('open');
		await vi.advanceTimersByTimeAsync(60_000);
		second.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Five seconds are spent, from the disconnection this connection ends.
		advertiseCredit(third, 0, 1);
		third.emit('open');
		await vi.advanceTimersByTimeAsync(94_000);
		const isMidway = isQueuedRejected;
		await vi.advanceTimersByTimeAsync(2000);

		const error = await expired;

		expect({
			midway: isMidway,
			waitedSeconds: error.waitedSeconds,
			totalWaitedSeconds: error.totalWaitedSeconds
		}).toStrictEqual({
			midway: false,
			waitedSeconds: 100,
			totalWaitedSeconds: 115
		});
	});

	// A drop while an entry is parked on its verdict is still a drop out of a
	// capacity wait: a parked entry is no sign that the cache is making
	// progress, and the replay resubscribes it whatever the drop cost. A paced
	// push parks entries as a matter of course, so counting them here would
	// spend the reconnect budget on the ordinary case.
	it('spends no reconnect budget for a drop with an entry parked on its verdict', async () => {
		const parking = new FakeCommitSocket();
		const blipped = new FakeCommitSocket();
		const last = new FakeCommitSocket();
		const session = openSessionOver([parking, blipped, last], {
			maxReconnects: 1,
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const parked = session.commit(targetFor('upload-1'));
		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		const parkedTimedOut = rejectedBy(
			settledOf(parked),
			UploadWaitTimeoutError
		);

		// The first connection parks upload-1 and leaves upload-2 queued; the
		// two that follow have nothing to send and drop with it still parked.
		advertiseCredit(parking, 1, 1);
		parking.emit('open');
		parking.emit('message', deferredFrame('upload-1'));
		parking.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		advertiseCredit(blipped, 0, 1);
		blipped.emit('open');
		await vi.advanceTimersByTimeAsync(50_000);
		blipped.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		advertiseCredit(last, 0, 1);
		last.emit('open');
		await vi.advanceTimersByTimeAsync(50_000);

		const error = await expired;
		const parkedError = await parkedTimedOut;

		expect({
			waitedSeconds: error.waitedSeconds,
			parkedTimeoutSeconds: parkedError.timeoutSeconds
		}).toStrictEqual({
			waitedSeconds: 100,
			parkedTimeoutSeconds: 100
		});
	});

	// A cache that accepts a connection and drops it before making any progress
	// gives the session no connected time to measure, and costs it no reconnect
	// budget either, since it never leaves the waiting state. What bounds it is
	// that the disconnections themselves count as waiting: four twenty-five
	// second gaps run the budget out.
	it('expires a wait that a cache keeps dropping before it makes any progress', async () => {
		const dropped = Array.from({ length: 4 }, () => new FakeCommitSocket());
		const last = new FakeCommitSocket();
		const session = openSessionOver([...dropped, last], {
			maxReconnects: 1,
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		for (const socket of dropped) {
			advertiseCredit(socket, 0, 1);
			socket.emit('open');
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(25_000);
		}

		// The wait resumes on this connection with the budget already run out by
		// the four gaps behind it, so it expires without waiting on it at all.
		advertiseCredit(last, 0, 1);
		last.emit('open');
		await vi.advanceTimersByTimeAsync(0);
		const error = await expired;

		expect({
			waitedSeconds: error.waitedSeconds,
			totalWaitedSeconds: error.totalWaitedSeconds
		}).toStrictEqual({
			waitedSeconds: 100,
			totalWaitedSeconds: 100
		});
	});

	// An expired wait gives the connection up: the server keeps a session's
	// declared demand and its granted credit in the socket, so a publication that
	// has stopped waiting must stop absorbing the grants other sessions need.
	it('closes the connection when the wait expires and reopens for a later commit', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], { timeoutSeconds: 100 });
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(first, 0);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(100_000);
		await expired;

		const wasClosedOnExpiry = first.closed;
		const later = session.commit(targetFor('upload-2'));
		await vi.advanceTimersByTimeAsync(0);
		advertiseCredit(second, 1, 1);
		second.emit('open');
		second.emit('message', settledFrame('upload-2'));

		expect({
			wasClosedOnExpiry,
			ack: await ackOf(later),
			// The reopened connection sends the commit its grant covers, with no
			// declaration to make.
			sent: second.sent
		}).toStrictEqual({
			wasClosedOnExpiry: true,
			ack: { storePathHash, narHash, status: 'committed' },
			sent: [batchOp(['upload-2'])]
		});
	});

	// The budget bounds one wait, not the session: a later commit that finds the
	// cache busy again waits its own full budget before giving up.
	it('waits the full budget again after an expiry', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], { timeoutSeconds: 100 });
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(first, 0);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(100_000);
		await expired;

		const later = session.commit(targetFor('upload-2'));
		let isRejected = false;
		void later.catch(() => {
			isRejected = true;
		});

		advertiseCredit(second, 0);
		second.emit('open');
		await vi.advanceTimersByTimeAsync(99_000);
		const isMidway = isRejected;
		await vi.advanceTimersByTimeAsync(2000);
		const error = await rejectedBy(later, CommitCapacityTimeoutError);

		expect({
			midway: isMidway,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			midway: false,
			waitedSeconds: 100
		});
	});

	it('fails a queued path promptly when the caller aborts mid-wait', async () => {
		const controller = new AbortController();
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { signal: controller.signal });
		const commit = session.commit(target);

		advertiseCredit(socket, 0);
		socket.emit('open');
		controller.abort();

		const error = await rejectedBy(commit, Error);

		expect({ name: error.name, socketClosed: socket.closed }).toStrictEqual({
			name: 'AbortError',
			socketClosed: true
		});
	});

	// The wait belongs to the session, not to the connection it was spent on, so
	// reconnecting cannot reset it. Were it reset, the fresh connection's
	// budget would be a full hundred seconds and the path below would still be
	// waiting rather than failed.
	it('keeps the wait it has already spent across a reconnect', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], {
			timeoutSeconds: 100,
			// Long enough that no keepalive lands in the traffic asserted below.
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const expired = rejectedBy(commit, CommitCapacityTimeoutError);

		advertiseCredit(first, 0);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(60_000);

		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);
		advertiseCredit(second, 0);
		second.emit('open');

		await vi.advanceTimersByTimeAsync(45_000);
		const error = await expired;

		expect({
			replayed: second.sent,
			timeoutSeconds: error.timeoutSeconds,
			waitedSeconds: error.waitedSeconds
		}).toStrictEqual({
			replayed: [requestCreditOp(1)],
			timeoutSeconds: 100,
			waitedSeconds: 100
		});
	});
});

describe('a session that declares credit to a server that offers none', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// The server pins its grant to the declaration on the upgrade request and
	// closes a session that sends more than it has. Whether the grant reaches the
	// client is a separate question: an intermediary that answers the handshake
	// itself can drop the response header. A session that declared credit
	// therefore paces itself either way, opening at zero and asking for what its
	// queue needs.
	it('paces itself through request-credit when the 101 carries no grant', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { headers: creditDeclaringHeaders });
		const commits = queuedIds.map((id) => session.commit(targetFor(id)));

		socket.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=2' }
		});
		socket.emit('open');
		const declared = [...socket.sent];

		socket.emit('message', frame({ ev: 'credit', grant: 3 }));

		for (const id of queuedIds) {
			socket.emit('message', settledFrame(id));
		}

		expect({
			declared,
			sent: socket.sent,
			acks: await Promise.all(commits.map((commit) => ackOf(commit)))
		}).toStrictEqual({
			declared: [requestCreditOp(3)],
			sent: [
				requestCreditOp(3),
				batchOp(['upload-1', 'upload-2']),
				batchOp(['upload-3'])
			],
			acks: queuedIds.map(() => ({
				storePathHash,
				narHash,
				status: 'committed'
			}))
		});
	});

	// A server old enough not to know `request-credit` answers `unsupported`
	// rather than closing. It paces nothing, so the session drops back to the
	// window it keeps itself and sends the queue through that.
	it('falls back to the uncredited window when the server rejects request-credit', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, { headers: creditDeclaringHeaders });
		const commit = session.commit(target);

		socket.emit('upgrade', { headers: {} });
		socket.emit('open');
		socket.emit('message', frame({ ev: 'unsupported', op: 'request-credit' }));
		socket.emit('message', settledFrame(uploadId));

		expect({
			ack: await ackOf(commit),
			sent: socket.sent
		}).toStrictEqual({
			ack: { storePathHash, narHash, status: 'committed' },
			sent: [requestCreditOp(1), commitOp(uploadId)]
		});
	});

	// The budget is the only bound an unpaced session has, so every drop spends
	// one, a dial that fails before it opens included. A paced session
	// reconnects free of the budget only because its capacity clock is running
	// instead, and this session has none.
	it('spends the budget on a failed dial once the fallback takes it off credit', async () => {
		const first = new FakeCommitSocket();
		const failedDial = new FakeCommitSocket();
		const session = openSessionOver([first, failedDial], {
			headers: creditDeclaringHeaders,
			maxReconnects: 1,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const dialFailure = new Error('connect ECONNREFUSED');
		let rejection: unknown;
		void commit.catch((error: unknown) => {
			rejection = error;
		});

		// The fallback puts the session on its own window, and the drop that
		// follows owes an answer, so it spends the one reconnect the budget has.
		first.emit('upgrade', { headers: {} });
		first.emit('open');
		first.emit('message', frame({ ev: 'unsupported', op: 'request-credit' }));
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// This dial fails before it opens, so it owes nothing. A third connection
		// would throw for want of a socket, so reaching the assertion at all also
		// shows the session stopped dialling.
		failedDial.emit('error', dialFailure);
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// The transport fault reaches the caller, which is what the session has
		// to report when the budget runs out on a dial that never opened.
		expect(rejection).toBe(dialFailure);
	});

	// A session the fallback took off credit has no capacity clock, so the
	// reconnect budget is what bounds it, as it does for a client that never
	// declared credit at all. The window sends its entries, so each drop leaves
	// an answer owed and spends one.
	it('bounds a session the fallback took off credit by the reconnect budget', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], {
			headers: creditDeclaringHeaders,
			maxReconnects: 1,
			keepaliveMs: 600_000
		});
		const commit = session.commit(target);
		const failed = rejectedBy(commit, CommitSocketProtocolError);

		for (const socket of [first, second]) {
			socket.emit('upgrade', { headers: {} });
			socket.emit('open');
			socket.emit(
				'message',
				frame({ ev: 'unsupported', op: 'request-credit' })
			);
			socket.emit('close', 1006, '');
			await vi.advanceTimersByTimeAsync(maxBackoffMs);
		}

		const error = await failed;

		expect(error.path).toBe(path);
	});
});
