import { uploadIdSchema } from '@cupboard/protocol/upload';
import { describe, expect, it, vi } from 'vitest';

import {
	CommitFixturePassesExhaustedError,
	CommitFixtureStalledError,
	commitSessionFromResponse,
	completeCommitSession,
	maxVerificationPasses
} from './test-support.ts';

const uploadId = uploadIdSchema.parse('f18ba531-f2d0-4acd-a2f1-cea79bc090b8');

async function failureOf(operation: Promise<unknown>): Promise<unknown> {
	try {
		return await operation;
	} catch (error) {
		return error;
	}
}

function openConversation() {
	const pair = new WebSocketPair();
	const server = pair[1];
	server.accept();
	const conversation = commitSessionFromResponse(
		// Workers permits 101 for WebSocket upgrades; Fetch still excludes it.
		// https://developers.cloudflare.com/workers/runtime-apis/websockets/
		// https://github.com/whatwg/fetch/issues/1759
		// eslint-disable-next-line unicorn/no-invalid-response-options
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

	it('fails as soon as the verification passes are exhausted without a verdict', async () => {
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
		const pending = completeCommitSession(
			conversation,
			uploadId,
			() => {
				passes += 1;
				return Promise.resolve('pending');
			},
			{}
		);

		await expect(pending).rejects.toStrictEqual(
			new CommitFixturePassesExhaustedError(
				uploadId,
				'initial',
				maxVerificationPasses,
				{
					socketState: WebSocket.READY_STATE_OPEN,
					queuedFrames: 0,
					pendingReaders: 1,
					closed: false
				}
			)
		);
		expect({
			passes,
			socketState: conversation.socket.readyState
		}).toStrictEqual({
			passes: maxVerificationPasses,
			socketState: WebSocket.READY_STATE_CLOSED
		});
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

	it.each(['initial frame', 'verdict'] as const)(
		'closes the socket and reports the %s phase when the test ends before the session completes',
		async (phase) => {
			const { server, conversation, closed } = openConversation();
			if (phase === 'verdict') {
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
			}
			const verificationStarted = Promise.withResolvers<undefined>();
			const cleanups: (() => Promise<void>)[] = [];
			const pending = completeCommitSession(
				conversation,
				uploadId,
				() => {
					verificationStarted.resolve(undefined);

					return Promise.withResolvers<never>().promise;
				},
				{
					registerCleanup: (cleanup) => {
						cleanups.push(cleanup);
					}
				}
			);
			void failureOf(pending);
			if (phase === 'verdict') {
				await verificationStarted.promise;
			}
			const [cleanup] = cleanups;
			if (cleanup === undefined) {
				throw new Error('completeCommitSession registered no cleanup');
			}
			const failure = await failureOf(cleanup());
			await closed;

			expect({
				failure:
					failure instanceof CommitFixtureStalledError
						? {
								name: failure.name,
								phase: failure.phase,
								uploadId: failure.uploadId,
								server: failure.server,
								conversation: failure.conversation
							}
						: failure,
				socketState: conversation.socket.readyState
			}).toStrictEqual({
				failure: {
					name: 'CommitFixtureStalledError',
					phase,
					uploadId,
					server: 'initial',
					conversation: {
						socketState: WebSocket.READY_STATE_OPEN,
						queuedFrames: 0,
						pendingReaders: 1,
						closed: false
					}
				},
				socketState: WebSocket.READY_STATE_CLOSED
			});
		}
	);

	it('reports the stalled phase without waiting for the close handshake', async () => {
		const { conversation, closed } = openConversation();
		// A tenant object that stalled the commit may not answer the close.
		const close = vi
			.spyOn(conversation.socket, 'close')
			.mockImplementation(vi.fn());
		const cleanups: (() => Promise<void>)[] = [];
		void failureOf(
			completeCommitSession(
				conversation,
				uploadId,
				() => Promise.resolve('pending'),
				{
					registerCleanup: (cleanup) => {
						cleanups.push(cleanup);
					}
				}
			)
		);
		const [cleanup] = cleanups;
		if (cleanup === undefined) {
			throw new Error('completeCommitSession registered no cleanup');
		}
		const failure = await failureOf(cleanup());
		const closeCalls = close.mock.calls.length;
		close.mockRestore();
		conversation.socket.close();
		await closed;

		expect({
			failure:
				failure instanceof CommitFixtureStalledError
					? { name: failure.name, phase: failure.phase }
					: failure,
			closeCalls
		}).toStrictEqual({
			failure: { name: 'CommitFixtureStalledError', phase: 'initial frame' },
			closeCalls: 1
		});
	});

	it('reports the close phase while the peer has not completed the close handshake', async () => {
		const { server, conversation, closed } = openConversation();
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
		const closeRequested = Promise.withResolvers<undefined>();
		const close = vi
			.spyOn(conversation.socket, 'close')
			.mockImplementation(() => {
				closeRequested.resolve(undefined);
			});
		const cleanups: (() => Promise<void>)[] = [];
		const completed = completeCommitSession(
			conversation,
			uploadId,
			() => Promise.resolve('pending'),
			{
				wait: false,
				registerCleanup: (cleanup) => {
					cleanups.push(cleanup);
				}
			}
		);
		await closeRequested.promise;
		const [cleanup] = cleanups;
		if (cleanup === undefined) {
			throw new Error('completeCommitSession registered no cleanup');
		}
		const failure = await failureOf(cleanup());
		close.mockRestore();
		conversation.socket.close();
		await closed;

		expect({
			failure:
				failure instanceof CommitFixtureStalledError
					? { name: failure.name, phase: failure.phase }
					: failure,
			result: await completed
		}).toStrictEqual({
			failure: { name: 'CommitFixtureStalledError', phase: 'close' },
			result: {
				storePathHash: 'a'.repeat(32),
				narHash: 'sha256:1qjpr1bqmj286dkawd7rrzplp9g0zdp50syslw15kg13pf2ra347',
				status: 'pending'
			}
		});
	});
});
