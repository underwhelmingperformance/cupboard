import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import type { StoreDirectory } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { type BuildEvent, buildEventSchema } from '@cupboard/protocol/build';
import { withCleanups } from '@cupboard/shared/cleanup';

import {
	BuildEventConnectionClosedError,
	BuildEventHandlingError,
	BuildEventMalformedError,
	BuildEventOutsideStoreError,
	type BuildEventRejectedError,
	BuildEventTooLargeError
} from '../errors.ts';

const newlineByte = 0x0a;
const acceptedByte = 0x01;

// A post-build event is a compact JSON object. One MiB accommodates thousands
// of ordinary store paths while bounding an unauthenticated local connection.
export const maximumBuildEventBytes = 1024 * 1024;

// The hook helper abandons a transfer after three seconds of inactivity, so a
// connection still unsettled this long after the child exits has no writer
// left behind it.
const defaultDrainTimeoutMs = 3000;

// Resolves only after the event loop has run a poll phase: the timer callback
// runs before the loop polls again, and the immediate that callback schedules
// runs after that poll, so every connection already queued on a listening
// socket has been accepted by the time the promise settles.
function afterNextPoll(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			setImmediate(() => {
				resolve();
			});
		}, 0);
	});
}

export interface BuildEventListenerOptions {
	readonly socketPath: string;
	readonly storeDirectory: StoreDirectory;
	readonly onEvent: (
		event: BuildEvent,
		signal: AbortSignal
	) => Promise<void> | void;
	readonly onRejected: (error: BuildEventRejectedError) => void;
	readonly setSocketMode?: (socketPath: string) => Promise<void>;
	readonly drainTimeoutMs?: number;
}

/**
 * The invocation's hook endpoint: a Unix-socket listener accepting the
 * post-build hook's events. Each connection sends one newline-terminated
 * message, so concurrent hook firings cannot interleave. Every valid event is
 * recorded immediately, and the accepted set is deliberately unbounded: even an
 * enormous build is only tens of thousands of paths, and the back-pressure comes
 * from the bounded upload pool that consumes the set, never from the hook.
 */
export class BuildEventListener {
	static async listen(
		options: BuildEventListenerOptions
	): Promise<BuildEventListener> {
		const listener = new BuildEventListener(options);
		await listener.start();

		return listener;
	}

	private readonly acceptedEvents: BuildEvent[] = [];
	private readonly unsettledSockets = new Set<Socket>();
	private readonly server: Server;
	private draining = false;
	private notifySettled: (() => void) | undefined;

	private constructor(private readonly options: BuildEventListenerOptions) {
		this.server = createServer({ allowHalfOpen: true }, (socket) => {
			this.handleConnection(socket);
		});
	}

	private async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once('error', reject);
			this.server.listen(this.options.socketPath, () => {
				this.server.removeListener('error', reject);
				resolve();
			});
		});

		try {
			// The invocation directory excludes other users while the fresh socket
			// briefly has its umask-derived mode.
			await (this.options.setSocketMode?.(this.options.socketPath) ??
				chmod(this.options.socketPath, 0o600));
		} catch (error) {
			await withCleanups(() => {
				throw error;
			}, [() => this.close()]);
		}
	}

	private handleConnection(socket: Socket): void {
		if (this.draining) {
			socket.destroy();
			return;
		}

		this.unsettledSockets.add(socket);

		const chunks: Buffer[] = [];
		let bufferedBytes = 0;
		let isSettled = false;
		let isProcessing = false;
		const handling = new AbortController();
		const settle = (): void => {
			if (isSettled) {
				return;
			}

			isSettled = true;
			this.unsettledSockets.delete(socket);
			this.notifySettled?.();
		};

		// A torn connection is a delivery failure the hook has already warned
		// about; the connection is dropped and the listener stays up.
		socket.on('error', () => {
			socket.destroy();
		});

		// Destruction is terminal however it occurs. Stop any local work that was
		// waiting to acknowledge the event, then let drain continue.
		socket.on('close', () => {
			if (isSettled) {
				return;
			}

			handling.abort(new BuildEventConnectionClosedError());
			settle();
		});

		socket.on('data', (chunk: string | Buffer) => {
			if (isSettled || isProcessing) {
				return;
			}

			const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
			const newline = buffer.indexOf(newlineByte);
			const lineChunk = newline === -1 ? buffer : buffer.subarray(0, newline);
			const observedBytes = bufferedBytes + lineChunk.byteLength;

			if (observedBytes > maximumBuildEventBytes) {
				this.options.onRejected(
					new BuildEventTooLargeError(maximumBuildEventBytes, observedBytes)
				);
				socket.destroy();
				settle();
				return;
			}

			if (newline === -1) {
				chunks.push(buffer);
				bufferedBytes = observedBytes;
				return;
			}

			const line =
				bufferedBytes === 0
					? lineChunk
					: Buffer.concat([...chunks, lineChunk], observedBytes);

			isProcessing = true;
			void this.accept(line.toString('utf8'), handling.signal)
				.then((accepted) => {
					if (accepted) {
						socket.end(Buffer.from([acceptedByte]));
					} else {
						socket.destroy();
					}
				})
				.catch((error: unknown) => {
					this.options.onRejected(new BuildEventHandlingError(error));
					socket.destroy();
				})
				.finally(() => {
					settle();
				});
		});

		socket.on('end', () => {
			if (isSettled || isProcessing) {
				return;
			}

			socket.destroy();
			settle();
			this.options.onRejected(new BuildEventMalformedError('missing-line'));
		});
	}

	private async accept(line: string, signal: AbortSignal): Promise<boolean> {
		let payload: unknown;

		try {
			payload = JSON.parse(line);
		} catch {
			this.options.onRejected(new BuildEventMalformedError('invalid-json'));
			return false;
		}

		const event = buildEventSchema.safeParse(payload);

		if (!event.success) {
			this.options.onRejected(new BuildEventMalformedError('invalid-event'));
			return false;
		}

		// The schema guarantees that StorePath construction succeeds. Compare the
		// parsed directories instead of the raw strings.
		const outside = event.data.outputPaths.find(
			(outputPath) =>
				new StorePath(outputPath).storeDirectory !== this.options.storeDirectory
		);

		if (outside !== undefined) {
			this.options.onRejected(
				new BuildEventOutsideStoreError(outside, this.options.storeDirectory)
			);
			return false;
		}

		this.acceptedEvents.push(event.data);

		try {
			await this.options.onEvent(event.data, signal);
			return true;
		} catch (error) {
			this.options.onRejected(new BuildEventHandlingError(error));
			return false;
		}
	}

	get accepted(): readonly BuildEvent[] {
		return this.acceptedEvents;
	}

	/**
	 * Quiesces the endpoint: refuses connections arriving from here on and
	 * resolves once every accepted connection has reached its terminal state,
	 * with its message recorded, its rejection reported, or the connection
	 * closed. A connection that never settles is destroyed once the drain
	 * timeout elapses. Closing a connection also cancels any output protection
	 * that was waiting to acknowledge its event. After drain resolves the accepted
	 * set is complete.
	 */
	async drain(): Promise<void> {
		// A helper that connected before this call may still be waiting for its
		// connection to be dispatched, so the queued arrivals are accepted
		// before the endpoint starts refusing them.
		await afterNextPoll();

		this.draining = true;

		if (this.unsettledSockets.size === 0) {
			return;
		}

		const deadline = setTimeout(() => {
			for (const socket of this.unsettledSockets) {
				socket.destroy();
			}
		}, this.options.drainTimeoutMs ?? defaultDrainTimeoutMs);

		try {
			while (this.unsettledSockets.size > 0) {
				await new Promise<void>((resolve) => {
					this.notifySettled = resolve;
				});
			}
		} finally {
			this.notifySettled = undefined;
			clearTimeout(deadline);
		}
	}

	async close(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => {
				if (error === undefined) {
					resolve();
					return;
				}

				reject(error);
			});
		});
	}
}
