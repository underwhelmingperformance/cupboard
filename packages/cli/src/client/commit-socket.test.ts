import type { CommitSocketFrame } from '@cupboard/protocol/upload';
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
import { settleCommitSocket } from './commit-socket.ts';

function frame(value: CommitSocketFrame): string {
	return JSON.stringify(value);
}

const storePathHash = '0123456789abcdfghijklmnpqrsvwxyz';
const narHash = `sha256:${'1'.repeat(52)}`;

function settle(
	socket: FakeCommitSocket,
	options: {
		readonly wait?: boolean;
		readonly timeoutSeconds?: number;
		readonly signal?: AbortSignal;
		readonly keepaliveMs?: number;
	} = {}
): Promise<unknown> {
	return settleCommitSocket(socket, {
		path: '/uploads/upload-app/commit',
		uploadId: 'upload-app',
		storePathHash,
		narHash,
		wait: options.wait ?? true,
		timeoutSeconds: options.timeoutSeconds ?? 600,
		signal: options.signal,
		keepaliveMs: options.keepaliveMs
	});
}

describe('settleCommitSocket', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('settles with the response of a result frame and closes the socket', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);

		socket.emit(
			'message',
			frame({
				event: 'result',
				response: { storePathHash, narHash, status: 'already-present' }
			})
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'already-present'
		});
		expect(socket.closed).toBe(true);
	});

	it('reports a deferred upload as pending without waiting when wait is off', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket, { wait: false });

		socket.emit(
			'message',
			frame({ event: 'deferred', storePathHash, narHash })
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'pending'
		});
	});

	it('parks a deferred upload and settles committed on a servable verdict', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);

		socket.emit(
			'message',
			frame({ event: 'deferred', storePathHash, narHash })
		);
		socket.emit('message', frame({ event: 'verdict', status: 'servable' }));

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.closed).toBe(true);
	});

	it('settles committed on a servable verdict that arrives before the deferred frame', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);

		// Verification settled the upload as the socket opened, so the verdict races
		// ahead of the deferred frame. The client settles from the upload's known
		// identity instead of failing the push.
		socket.emit('message', frame({ event: 'verdict', status: 'servable' }));

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.closed).toBe(true);
	});

	it.each(['mismatch', 'over-quota', 'absent'] as const)(
		'rejects a parked upload on a %s verdict',
		async (status) => {
			const socket = new FakeCommitSocket();
			const settled = settle(socket);

			socket.emit(
				'message',
				frame({ event: 'deferred', storePathHash, narHash })
			);
			socket.emit('message', frame({ event: 'verdict', status }));

			await expect(settled).rejects.toStrictEqual(
				new UploadVerificationFailedError('upload-app', status)
			);
		}
	);

	it('rejects an error frame with the HTTP error it mirrors', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);

		socket.emit(
			'message',
			frame({ event: 'error', status: 507, message: 'over quota' })
		);

		await expect(settled).rejects.toStrictEqual(
			new CupboardHttpError(
				'GET',
				'/uploads/upload-app/commit',
				507,
				'over quota'
			)
		);
	});

	it('rejects a refused upgrade with the response status and body', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);
		const refusal = new FakeUpgradeFailure(401);

		socket.emit('unexpected-response', {}, refusal);
		refusal.emit('data', Buffer.from('Missing bearer token'));
		refusal.emit('end');

		await expect(settled).rejects.toStrictEqual(
			new CupboardHttpError(
				'GET',
				'/uploads/upload-app/commit',
				401,
				'Missing bearer token'
			)
		);
	});

	it('rejects when the socket closes before the commit settles', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);

		socket.emit('close', 1006);

		await expect(settled).rejects.toStrictEqual(
			new CommitSocketProtocolError(
				'/uploads/upload-app/commit',
				'the socket closed before the commit settled'
			)
		);
	});

	it('rejects an unparseable frame as a protocol error', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket);

		socket.emit('message', 'not json');

		await expect(settled).rejects.toStrictEqual(
			new CommitSocketProtocolError(
				'/uploads/upload-app/commit',
				'unexpected frame: not json'
			)
		);
	});

	it('times out a parked upload after the wait deadline', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket, { timeoutSeconds: 30 });

		socket.emit(
			'message',
			frame({ event: 'deferred', storePathHash, narHash })
		);
		const expectation = expect(settled).rejects.toStrictEqual(
			new UploadWaitTimeoutError(1, 30)
		);
		await vi.advanceTimersByTimeAsync(30_000);

		await expectation;
		expect(socket.closed).toBe(true);
	});

	it('keeps the socket alive with pings and ignores the pong replies', async () => {
		const socket = new FakeCommitSocket();
		const settled = settle(socket, { keepaliveMs: 1000 });

		socket.emit('open');
		await vi.advanceTimersByTimeAsync(2000);
		socket.emit('message', 'pong');
		socket.emit('message', 'pong');
		socket.emit(
			'message',
			frame({
				event: 'result',
				response: { storePathHash, narHash, status: 'committed' }
			})
		);

		await expect(settled).resolves.toStrictEqual({
			storePathHash,
			narHash,
			status: 'committed'
		});
		expect(socket.sent).toStrictEqual(['ping', 'ping']);
	});

	it('rejects and closes the socket when the signal aborts', async () => {
		const socket = new FakeCommitSocket();
		const controller = new AbortController();
		const settled = settle(socket, { signal: controller.signal });

		controller.abort();

		await expect(settled).rejects.toMatchObject({ name: 'AbortError' });
		expect(socket.closed).toBe(true);
	});
});
