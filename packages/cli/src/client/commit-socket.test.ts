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
// Advancing by this cap fires every possible jittered reconnect delay.
const maxBackoffMs = 5000;
// Node truncates longer timer delays. The session chains timers to preserve a
// deadline beyond this limit.
const maxTimerDelayMs = 2 ** 31 - 1;
// The session abandons a stalled upgrade-response body after this interval.
const drainTimeoutMs = 5000;
// The client offers both optional operations on every connection. The response
// selects the operations the server supports.
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
	// Headers offered by the client on the upgrade request.
	readonly headers?: Readonly<Record<string, string>>;
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
	readonly keepaliveMs?: number;
	readonly maxReconnects?: number;
	readonly reconnectBackoffMs?: number;
	readonly onCapabilities?: (capabilities: AdvertisedCapabilities) => void;
	readonly onWaiting?: (isWaitingForCapacity: boolean) => void;
	// Record each connection time so tests can measure reconnect delays.
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

// Return a fresh socket for each connection attempt.
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

// Remove the asynchronous verdict from an acknowledgement before comparison.
async function ackOf(
	commit: Promise<CommitOutcome>
): Promise<Omit<CommitOutcome, 'settled'>> {
	const { storePathHash, narHash, status } = await commit;

	return { storePathHash, narHash, status };
}

// Return the promise that resolves with the final verdict.
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

	it('resolves each commit from the frame with its upload ID', async () => {
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

	it('parks a deferred upload and resolves it as committed on a servable verdict', async () => {
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

	it('resolves as committed when a servable verdict precedes the deferred frame', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		// Deliver the verdict first to reproduce verification completing before the
		// deferred frame reaches the client.
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

		// Register the handler before advancing fake timers because rejection can
		// occur synchronously inside the timer callback.
		const rejection = rejectedBy(commit, CupboardHttpError);

		socket.emit('open');

		// Four error frames exhaust the three-retry budget.
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
			sentAfterError: 1
		});
	});

	// A 429 response can succeed after a delay. Other 4xx responses reject this
	// request permanently, so reconnecting with the same route and token cannot
	// help.
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

	// Server and gateway overload responses can be transient. A credit-paced
	// session keeps reconnecting until its capacity deadline expires.
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

	// An unpaced session has no capacity deadline, so a retryable upgrade refusal
	// consumes its reconnect budget like any other drop.
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

		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

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

// Accept an upgrade and advertise the batch operation.
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

// The response capability selects `commit-batch`, which includes each path's
// identity. Without it, the session sends one `commit` operation per upload ID.
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
		// Let the microtask that coalesces commits run.
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

		advertiseBatch(first);
		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Identity-aware replay remains valid after the server clears the pending
		// row.
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

	it('sends per-ID operations when the connection advertises no capabilities', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const commit = session.commit(target);

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

// Three single-entry chunks fill the two-message window and leave one queued.
const windowTestIds = ['upload-w0', 'upload-w1', 'upload-w2'] as const;

describe('batch message windowing', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('queues the third chunk until a frame frees a message-window slot', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const [id0, id1, id2] = windowTestIds;
		const commits = windowTestIds.map((id) => session.commit(targetFor(id)));

		socket.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=1' }
		});
		socket.emit('open');

		expect(socket.sent).toStrictEqual([batchOp([id0]), batchOp([id1])]);

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

		expect(first.sent).toStrictEqual([batchOp([id0]), batchOp([id1])]);

		// Drop while the third chunk is still queued on the first socket.
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		second.emit('upgrade', {
			headers: { 'x-cupboard-commit-capabilities': 'commit-batch;max=1' }
		});
		second.emit('open');

		expect(second.sent).toStrictEqual([batchOp([id0]), batchOp([id1])]);

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

// Advertise both identity-aware operations.
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

		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

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

	it('resolves an acknowledged entry from a later settled frame', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket);
		const settled = session.commit(target);

		advertiseBoth(socket);
		socket.emit('open');
		socket.emit(
			'message',
			frame({ ev: 'deferred', uploadId, storePathHash, narHash })
		);
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

// Advertise the server's retention-marker attribute on both operations.
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

	it('sets the marker on a commit-batch entry whose target has a retention plan', async () => {
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

	// Only the exact attribute value enables the versioned handshake.
	it('omits the marker when the advertised attribute has a different value', async () => {
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

	it('ignores a frame with an unknown event and resolves on the next valid frame', async () => {
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
		expect([...(calls[0]?.entries() ?? [])]).toStrictEqual([
			['commit-batch', {}]
		]);
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

	// `ws` reports one transport fault as an `error` followed by `close`. Count
	// that pair once so one failure cannot consume two reconnects or start two
	// connections over the same session state.
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

	// Reconnect replay resends an entry that already has a retry timer. Cancel the
	// timer so the new connection does not receive the entry twice.
	it('does not re-send a replayed entry whose retry was armed before the drop', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], {
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
	// A server-initiated idle close leaves the session reusable. An explicit
	// client close is terminal.
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
		// Drop before the batching microtask runs. Replay must send the entry once
		// on the new socket.
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
			first: [],
			second: [commitOp(uploadId)]
		});
	});

	it('rejects an outstanding commit when reconnects exhaust', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], { maxReconnects: 1 });

		const commit = session.commit(target);

		first.emit('open');
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

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

		// Bare replay lacks path identity. If the pending row disappeared before
		// reconnect, only the server's error frame can resolve the entry.
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

// Accept an upgrade with credit pacing and the given batch limit.
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

	// A zero-credit session declares the queued demand once, then consumes each
	// grant. It declares again only when the queue exceeds the previous demand.
	it('declares its queue at zero credit and sends entries as grants arrive', () => {
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

	// Waiting is session state: it begins when entries are queued without credit
	// and ends when a grant lets the session send one.
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

	// Report every transition out of waiting so callers cannot retain a stale
	// capacity-wait indicator. The queued entries separately reject with the
	// timeout.
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

	// Retry transient upgrade failures until the capacity deadline. Preserve the
	// last refusal as the timeout cause so the operator sees why no connection
	// opened.
	it('includes the last upgrade refusal in a capacity timeout', async () => {
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

	// Clear a recorded refusal when its wait ends. A later timeout must not report
	// an error from a previous capacity wait.
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

	// `ws` exposes the 101 response before it validates the handshake. Do not
	// treat an opening grant as progress until the connection opens, or repeated
	// invalid handshakes could reset the capacity deadline indefinitely.
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

	// An opening grant counts as progress only after the connection opens. It
	// resets the capacity deadline just like a later credit frame.
	it('starts a fresh wait after an opening grant is consumed', async () => {
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

	// An `unsupported` response disables credit pacing and ends the current
	// capacity wait. If a later connection enables pacing again, its wait starts
	// with a fresh deadline.
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

		advertiseCredit(unpaced, 0, 1);
		unpaced.emit('open');
		unpaced.emit('message', frame({ ev: 'unsupported', op: 'request-credit' }));
		unpaced.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

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

	// Progress clears an earlier upgrade refusal. A later timeout must report
	// only the new capacity wait.
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

	// Closing the session must clear the waiting state reported to callers.
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

	// Report a new waiting transition after an earlier wait expires. Callers may
	// suppress brief waits independently.
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

	// With one-entry grants, the waiting flag changes once before and once after
	// each grant. `build-push` delays its announcement to suppress these brief
	// waits.
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

	// The capacity budget measures one uninterrupted period without progress.
	// When it expires, reject every entry still queued.
	it('expires the queued paths when the cache makes no progress for a whole budget', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		// Observe the promises before advancing fake time because they reject in
		// the timer callback.
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

	// Arm long deadlines in instalments because Node truncates a delay above its
	// timer limit to one millisecond.
	it("preserves a capacity budget longer than Node's timer limit", async () => {
		const socket = new FakeCommitSocket();
		const timeoutSeconds = 4 * 7 * 24 * 60 * 60;
		const session = openSession(socket, {
			// Keep the interval below Node's timer limit and outside this assertion.
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

	// Deferred verdict deadlines use the same chained-timer implementation.
	it("preserves a verdict deadline longer than Node's timer limit", async () => {
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

	// A frame for an unknown upload ID is stale and does not reset the capacity
	// deadline.
	it('expires a wait that receives only frames for unknown upload IDs', async () => {
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

	// Frames for completed or unknown uploads do not prove that a connection made
	// progress on outstanding work. Its subsequent drop consumes a reconnect.
	it('spends a reconnect when a connection reports only an unknown upload ID', async () => {
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

	// A frame for an outstanding entry proves progress and restores the reconnect
	// budget before the next drop.
	it('restores the reconnect budget after each outstanding entry receives a frame', async () => {
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

	// Credit was offered on the request before any connection opens. Therefore
	// repeated transport failures remain subject to the capacity deadline even
	// when no 101 response ever supplies a grant.
	it('expires a wait against a cache it never reaches', async () => {
		const failing = Array.from({ length: 4 }, () => new FakeCommitSocket());
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

		for (const dial of failing) {
			dial.emit('error', new Error('connect ECONNREFUSED'));
			await vi.advanceTimersByTimeAsync(30_000);
		}

		const error = await expired;

		await vi.advanceTimersByTimeAsync(60_000);

		expect({
			waitedSeconds: error.waitedSeconds,
			reported
		}).toStrictEqual({
			waitedSeconds: 100,
			reported: [true, false]
		});
	});

	// A partition after the first connection leaves queued entries without an
	// in-flight verdict deadline. Keep the capacity deadline running across the
	// failed reconnects so the session still terminates.
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

	// A parked entry has its own verdict deadline and a durable server row. Drops
	// while it is parked do not consume the reconnect budget; reconnect replay
	// can still collect the eventual verdict.
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

	// A deferral is progress for its entry and restores the reconnect budget.
	it('restores the reconnect budget when each entry is deferred', async () => {
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

	// A credit grant alone does not prove progress on an entry. A connection that
	// drops before any entry receives a frame must consume a reconnect.
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

	// Each grant and each entry frame resets the no-progress deadline. Total wait
	// time may therefore exceed one budget while the cache continues to advance
	// the queue.
	it('does not expire while the cache keeps making progress across a longer total wait', async () => {
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

	// Stop the capacity deadline while an entry is in flight. Its first response
	// returns credit and starts the deadline for any queued work.
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

	// A retryable error returns the entry's credit before requeueing it. Start the
	// capacity deadline if the retry cannot be sent immediately.
	it('starts the capacity wait when a retryable error re-queues its entry', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
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

	// A grant ends the current wait and resets the deadline. Once the retried
	// entry is in flight, no capacity time accrues until its next response.
	it('stops the capacity wait when the retried entry goes back on the wire', async () => {
		const socket = new FakeCommitSocket();
		const session = openSession(socket, {
			timeoutSeconds: 100,
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

		await vi.advanceTimersByTimeAsync(60_000);
		socket.emit('message', frame({ ev: 'credit', grant: 1 }));

		await vi.advanceTimersByTimeAsync(300_000);
		const isRejectedWhileInFlight = isRetriedRejected;
		socket.emit('message', settledFrame('upload-1'));

		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		let isQueuedRejected = false;
		void queued.catch(() => {
			isQueuedRejected = true;
		});

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

	// A late verdict can finish an entry after a retryable error requeues it.
	// Remove the stale queued target so it no longer contributes to declared
	// demand.
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

		await vi.advanceTimersByTimeAsync(500);
		const whileQueued = [...reported];
		socket.emit(
			'message',
			frame({ ev: 'verdict', uploadId: 'upload-1', status: 'servable' })
		);
		const afterVerdict = [...reported];

		// The existing demand declaration covers this one new path. A stale queued
		// retry would force another declaration.
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

	// A late frame for the first attempt can resolve an entry while its retry is
	// queued. The next grant must skip that stale queue item.
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

	// The first frame for an entry returns its credit, including a `deferred`
	// frame. A later verdict returns no additional credit, so queued work waits
	// against the capacity deadline while earlier entries are parked.
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

	// Deferring an entry returns its credit and counts as progress. The queued
	// work therefore starts a fresh capacity deadline.
	it('restarts the wait when an entry parks on its verdict', async () => {
		const first = new FakeCommitSocket();
		const second = new FakeCommitSocket();
		const session = openSessionOver([first, second], {
			timeoutSeconds: 100,
			keepaliveMs: 600_000
		});
		const parked = session.commit(targetFor('upload-1'));
		const queued = session.commit(targetFor('upload-2'));
		const expired = rejectedBy(queued, CommitCapacityTimeoutError);
		// The parked entry has an independent verdict deadline with the same length.
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
			// Lifetime includes the wait before the drop, the disconnection, and the
			// final capacity wait.
			totalWaitedSeconds: 165,
			parkedAck: { storePathHash, narHash, status: 'pending' },
			parkedTimeoutSeconds: 100
		});
	});

	// A reconnect does not split one capacity wait into several reported waits.
	// Otherwise a caller that suppresses brief waits could hide one long outage.
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

	// Backoff depends on reconnects since the last entry frame, not on reconnect
	// budget consumption. Free reconnects during a capacity wait must still reach
	// the cap so a repeatedly dropping server is not dialled continuously.
	//
	// Pin jitter to its lower bound: 500, 1000, 2000, 4000, then the 5000 cap.
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

	// An entry frame resets the reconnect counter as well as restoring budget.
	it('resets reconnect backoff after an entry receives a frame', async () => {
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

	// Honour a valid `Retry-After` when it exceeds the reconnect backoff, up to
	// one minute. A missing or unreadable value leaves the backoff unchanged.
	//
	// Pin jitter so the first reconnect backoff is 250 ms.
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

	// `ws` exposes a refused connection but does not close it. Close each refusal
	// so repeated retries do not leak sockets that keep the process alive.
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

	// Reading a stalled refusal body can finish after its connection was
	// abandoned. Ignore that late result so it cannot terminate a newer
	// connection.
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

		await vi.advanceTimersByTimeAsync(drainTimeoutMs);
		const served = session.commit(targetFor('upload-3'));
		last.emit('message', settledFrame('upload-3'));

		await expect(ackOf(served)).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
	});

	// Preserve `Retry-After` while the session is dormant so the next commit does
	// not redial before the server's requested time.
	it('delays a dormant redial until Retry-After expires', async () => {
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

	// A capacity timeout can cancel a reconnect scheduled after `Retry-After`.
	// Preserve the remaining delay for the next commit's dial.
	it('preserves Retry-After when capacity expiry cancels the scheduled redial', async () => {
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

	// A peer can leave an upgrade-response body unfinished without another
	// socket event. Bound the read; if it times out, discard any incomplete
	// `Retry-After` value and use reconnect backoff.
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

	// A drop during a capacity wait does not consume reconnect budget. The
	// disconnected interval still counts towards the capacity deadline because
	// the cache makes no progress during it.
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

	// Capacity time accrues while queued or disconnected and stops while an entry
	// is in flight. A grant resets the deadline; lifetime reporting still includes
	// every interval.
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

		advertiseCredit(first, 0, 1);
		first.emit('open');
		await vi.advanceTimersByTimeAsync(10_000);
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		// Keep the entry in flight for a minute before dropping the connection.
		advertiseCredit(second, 1, 1);
		second.emit('open');
		await vi.advanceTimersByTimeAsync(60_000);
		second.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

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

	// A parked entry does not make a drop consume reconnect budget. Verdict
	// replay resubscribes it, and credit-paced sessions park entries routinely.
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

	// Repeated drops before any progress do not consume reconnect budget during
	// a capacity wait. Count the disconnected intervals so the capacity deadline
	// still bounds the session.
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

	// Close the connection when a capacity wait expires. The server associates
	// declared demand and granted credit with that socket, so leaving it open
	// would absorb capacity needed by other sessions.
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
			sent: second.sent
		}).toStrictEqual({
			wasClosedOnExpiry: true,
			ack: { storePathHash, narHash, status: 'committed' },
			sent: [batchOp(['upload-2'])]
		});
	});

	// A capacity timeout ends one wait, not the session. A later commit receives
	// a fresh capacity deadline.
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

	// The capacity deadline belongs to the session, so reconnecting cannot reset
	// time already spent waiting.
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

	// The server enforces the credit declaration on the request even if an
	// intermediary removes the grant header from the 101 response. Start at zero
	// credit and request the queue's demand in that case.
	it('requests credit when the 101 response omits the opening grant', async () => {
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

	// An older server returns `unsupported` for `request-credit`. Fall back to
	// the client's uncredited message window without closing the session.
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

	// After credit fallback, the session has no capacity deadline. Transport
	// failures therefore consume the reconnect budget, including a dial that
	// never opens.
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

		first.emit('upgrade', { headers: {} });
		first.emit('open');
		first.emit('message', frame({ ev: 'unsupported', op: 'request-credit' }));
		first.emit('close', 1006, '');
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		failedDial.emit('error', dialFailure);
		await vi.advanceTimersByTimeAsync(maxBackoffMs);

		expect(rejection).toBe(dialFailure);
	});

	// Once credit fallback disables pacing, the reconnect budget bounds the
	// session just as it does for a client that never offered credit.
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
