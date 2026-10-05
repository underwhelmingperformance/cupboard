import { uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it, vi } from 'vitest';

import {
	commitFixturePhaseDeadlineMs,
	commitSessionFromResponse,
	completeCommitSession,
	testBase
} from './test-support.ts';

const uploadId = uploadIdSchema.parse('f18ba531-f2d0-4acd-a2f1-cea79bc090b8');

function openConversation() {
	const pair = new WebSocketPair();
	const server = pair[1];
	server.accept();
	const conversation = commitSessionFromResponse(
		new Response(undefined, { status: 101, webSocket: pair[0] })
	);
	const closed = new Promise<void>((resolve) => {
		conversation.socket.addEventListener(
			'close',
			() => {
				resolve();
			},
			{ once: true }
		);
	});

	return { server, conversation, closed };
}

describe('commit conversation frame reader', () => {
	it('closes the session when verification rejects after a deferred commit', async () => {
		const { server, conversation } = openConversation();
		server.addEventListener('message', () => {
			server.send(
				JSON.stringify({
					ev: 'deferred',
					uploadId,
					storePathHash: 'a'.repeat(32),
					narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
				})
			);
		});

		await expect(
			completeCommitSession(
				conversation,
				uploadId,
				() => Promise.reject(new Error('verification failed')),
				{}
			)
		).rejects.toThrow('verification failed');
		expect(conversation.socket.readyState).toBe(WebSocket.READY_STATE_CLOSED);
	});

	it('runs another verification pass when a pass leaves the deferred upload without a verdict', async () => {
		const { server, conversation } = openConversation();
		server.addEventListener('message', () => {
			server.send(
				JSON.stringify({
					ev: 'deferred',
					uploadId,
					storePathHash: 'a'.repeat(32),
					narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
				})
			);
		});
		let passes = 0;

		const pause = vi
			.spyOn(scheduler, 'wait')
			.mockRejectedValue(
				new Error('Verification must not wait for elapsed time')
			);

		try {
			const result = await completeCommitSession(
				conversation,
				uploadId,
				() => {
					passes += 1;

					if (passes === 2) {
						server.send(
							JSON.stringify({ ev: 'verdict', uploadId, status: 'servable' })
						);
					}

					return Promise.resolve(passes === 2 ? 'complete' : 'pending');
				},
				{}
			);

			expect({ result, passes, pauses: pause.mock.calls }).toStrictEqual({
				result: {
					storePathHash: 'a'.repeat(32),
					narHash:
						'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
					status: 'committed'
				},
				passes: 2,
				pauses: []
			});
		} finally {
			pause.mockRestore();
		}
	});

	it('waits for the verdict frame after a completed pass without running another pass', async () => {
		const { server, conversation } = openConversation();
		server.addEventListener('message', () => {
			server.send(
				JSON.stringify({
					ev: 'deferred',
					uploadId,
					storePathHash: 'a'.repeat(32),
					narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
				})
			);
		});
		const started = Promise.withResolvers<undefined>();
		const verify = vi.fn(() => {
			started.resolve(undefined);
			return Promise.resolve('complete' as const);
		});
		const pending = completeCommitSession(conversation, uploadId, verify, {});
		await started.promise;
		server.send(
			JSON.stringify({ ev: 'verdict', uploadId, status: 'servable' })
		);
		const result = await pending;

		expect({ result, passes: verify.mock.calls }).toStrictEqual({
			result: {
				storePathHash: 'a'.repeat(32),
				narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
				status: 'committed'
			},
			passes: [[]]
		});
	});

	it('bounds pending verification passes and reports a missing verdict frame', async () => {
		vi.useFakeTimers();

		try {
			const { server, conversation } = openConversation();
			server.addEventListener('message', () => {
				server.send(
					JSON.stringify({
						ev: 'deferred',
						uploadId,
						storePathHash: 'a'.repeat(32),
						narHash:
							'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347'
					})
				);
			});
			const finalPass = Promise.withResolvers<undefined>();
			let passes = 0;
			const pending = completeCommitSession(
				conversation,
				uploadId,
				() => {
					passes += 1;
					if (passes === 100) {
						finalPass.resolve(undefined);
					}
					return Promise.resolve('pending');
				},
				{}
			);
			const rejected = expect(pending).rejects.toMatchObject({
				name: 'CommitFixturePhaseTimeoutError',
				phase: 'verdict',
				uploadId
			});
			await finalPass.promise;
			await vi.advanceTimersByTimeAsync(commitFixturePhaseDeadlineMs);
			await rejected;
			expect({
				passes,
				socketState: conversation.socket.readyState
			}).toStrictEqual({
				passes: 100,
				socketState: WebSocket.READY_STATE_CLOSED
			});
		} finally {
			vi.useRealTimers();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(testBase);
		}
	});

	it('rejects a frame read started after the socket has closed', async () => {
		const { server, conversation, closed } = openConversation();
		server.close();
		await closed;

		await expect(
			Promise.race([
				conversation.nextFrame(),
				Promise.resolve('reader remained pending')
			])
		).rejects.toThrow('the socket closed before the frame');
	});

	it('rejects a pending frame read when the socket closes', async () => {
		const { server, conversation, closed } = openConversation();
		const rejected = expect(conversation.nextFrame()).rejects.toThrow(
			'the socket closed before the frame'
		);
		server.close();

		await Promise.all([closed, rejected]);
	});

	it('returns frames received before closure before rejecting further reads', async () => {
		const { server, conversation, closed } = openConversation();
		server.send(JSON.stringify({ ev: 'credit', grant: 1 }));
		server.close();
		await closed;

		await expect(conversation.nextFrame()).resolves.toStrictEqual({
			ev: 'credit',
			grant: 1
		});
		await expect(
			Promise.race([
				conversation.nextFrame(),
				Promise.resolve('reader remained pending')
			])
		).rejects.toThrow('the socket closed before the frame');
	});

	it('reports the stalled commit phase and closes its socket before teardown', async () => {
		vi.useFakeTimers();

		try {
			const { conversation } = openConversation();
			const pending = completeCommitSession(
				conversation,
				uploadId,
				() => Promise.resolve('pending'),
				{}
			);
			const rejected = expect(pending).rejects.toMatchObject({
				name: 'CommitFixturePhaseTimeoutError',
				phase: 'initial frame',
				uploadId,
				server: 'initial',
				conversation: {
					socketState: WebSocket.READY_STATE_OPEN,
					queuedFrames: 0,
					pendingReaders: 1,
					closed: false
				}
			});

			await vi.advanceTimersByTimeAsync(commitFixturePhaseDeadlineMs);
			await rejected;
			expect(conversation.socket.readyState).toBe(WebSocket.READY_STATE_CLOSED);
		} finally {
			vi.useRealTimers();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(testBase);
		}
	});
});
