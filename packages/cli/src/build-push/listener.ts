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

export interface BuildEventListenerOptions {
	readonly socketPath: string;
	readonly storeDirectory: StoreDirectory;
	readonly onEvent: (event: ParsedBuildEvent) => void;
	readonly onRejected: (error: BuildEventRejectedError) => void;
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
	private readonly server: Server;

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
		const chunks: Buffer[] = [];
		let isSettled = false;

		// A torn connection is a delivery failure the hook has already warned
		// about; the connection is dropped and the listener stays up.
		socket.on('error', () => {
			socket.destroy();
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

			isSettled = true;
			this.accept(buffered.subarray(0, newline).toString('utf8'));
			socket.end();
		});

		socket.on('end', () => {
			if (isSettled) {
				return;
			}

			isSettled = true;
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
