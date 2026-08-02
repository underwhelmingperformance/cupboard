import { chmod } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';

import type { StoreDirectory } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	buildEventSchema,
	type ParsedBuildEvent
} from '@cupboard/protocol/build';

import {
	BuildEventMalformedError,
	BuildEventOutsideStoreError,
	type BuildEventRejectedError
} from '../errors.ts';

const newlineByte = 0x0a;

// The hook helper abandons a transfer after three seconds of inactivity, so a
// connection still unsettled this long after the child exits has no writer
// left behind it.
const defaultDrainTimeoutMs = 3000;

// Resolves with a poll phase behind it: the timer turn runs before the event
// loop polls again, and the immediate that turn schedules runs after it, so
// every connection already queued on a listening socket has been accepted by
// the time the promise settles.
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
	readonly onEvent: (event: ParsedBuildEvent) => void;
	readonly onRejected: (error: BuildEventRejectedError) => void;
	/** Bounds the drain wait on a connection that never settles. */
	readonly drainTimeoutMs?: number;
}

/**
 * The invocation's hook endpoint: a Unix-socket listener accepting the
 * post-build hook's events. One connection carries one newline-terminated
 * message, so concurrent hook firings cannot interleave. Every valid event is
 * recorded immediately; the accepted set is unbounded by design, since even an
 * enormous build is tens of thousands of paths and backpressure lives in the
 * bounded upload pool consuming the set, never in the hook.
 */
export class BuildEventListener {
	static async listen(
		options: BuildEventListenerOptions
	): Promise<BuildEventListener> {
		const listener = new BuildEventListener(options);
		await listener.start();

		return listener;
	}

	private readonly acceptedEvents: ParsedBuildEvent[] = [];
	private readonly unsettledSockets = new Set<Socket>();
	private readonly server: Server;
	private draining = false;
	private notifySettled: (() => void) | undefined;

	private constructor(private readonly options: BuildEventListenerOptions) {
		this.server = createServer((socket) => {
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

		// The owner-only invocation directory already excludes other users while
		// the fresh socket briefly carries its umask-derived mode.
		await chmod(this.options.socketPath, 0o600);
	}

	private handleConnection(socket: Socket): void {
		if (this.draining) {
			socket.destroy();
			return;
		}

		this.unsettledSockets.add(socket);

		const chunks: Buffer[] = [];
		let isSettled = false;
		const settle = (): void => {
			isSettled = true;
			this.unsettledSockets.delete(socket);
			this.notifySettled?.();
		};

		// A torn connection is a delivery failure the hook has already warned
		// about; the connection is dropped and the listener stays up.
		socket.on('error', () => {
			socket.destroy();
		});

		// Destruction is terminal however it comes about, so the close event
		// settles any connection nothing else has.
		socket.on('close', () => {
			if (isSettled) {
				return;
			}

			settle();
		});

		socket.on('data', (chunk: string | Buffer) => {
			if (isSettled) {
				return;
			}

			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			const buffered = Buffer.concat(chunks);
			const newline = buffered.indexOf(newlineByte);

			if (newline === -1) {
				return;
			}

			this.accept(buffered.subarray(0, newline).toString('utf8'));
			socket.end();
			settle();
		});

		socket.on('end', () => {
			if (isSettled) {
				return;
			}

			settle();
			this.options.onRejected(new BuildEventMalformedError('missing-line'));
		});
	}

	private accept(line: string): void {
		let payload: unknown;

		try {
			payload = JSON.parse(line);
		} catch {
			this.options.onRejected(new BuildEventMalformedError('invalid-json'));
			return;
		}

		const event = buildEventSchema.safeParse(payload);

		if (!event.success) {
			this.options.onRejected(new BuildEventMalformedError('invalid-event'));
			return;
		}

		// A schema-valid store path always constructs, so the containment check
		// compares parsed directories, never raw strings.
		const outside = event.data.outputPaths.find(
			(outputPath) =>
				new StorePath(outputPath).storeDirectory !== this.options.storeDirectory
		);

		if (outside !== undefined) {
			this.options.onRejected(
				new BuildEventOutsideStoreError(outside, this.options.storeDirectory)
			);
			return;
		}

		this.acceptedEvents.push(event.data);
		this.options.onEvent(event.data);
	}

	get accepted(): readonly ParsedBuildEvent[] {
		return this.acceptedEvents;
	}

	/**
	 * Quiesces the endpoint: refuses connections arriving from here on and
	 * resolves once every accepted connection has reached its terminal state,
	 * with its message recorded, its rejection reported, or the connection
	 * closed. A connection that never settles is destroyed once the drain
	 * timeout elapses, so the wait is always bounded. After drain resolves the
	 * accepted set is complete.
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
