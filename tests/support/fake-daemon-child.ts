import type { ByteStreamSource } from '../../packages/nix/src/nix-daemon.ts';
import type { DaemonChildProcess } from '../../packages/nix/src/nix-daemon-process.ts';

import type { FakeDaemonTransport } from './fake-daemon-transport.ts';

export class FakeByteSource implements ByteStreamSource {
	private dataListener: ((chunk: Buffer) => void) | undefined;

	private readonly pendingData: Buffer[] = [];

	private isPaused = false;

	private endListener: ((error: Error) => void) | undefined;

	private closeListener: ((error: Error) => void) | undefined;

	private deliverPendingData(): void {
		while (!this.isPaused) {
			const chunk = this.pendingData.shift();

			if (chunk === undefined) {
				return;
			}

			this.dataListener?.(chunk);
		}
	}

	on(_event: 'data', listener: (chunk: Buffer) => void): void {
		this.dataListener = listener;
	}

	once(
		event: 'end' | 'close' | 'error',
		listener: (error: Error) => void
	): void {
		if (event === 'end') {
			this.endListener = listener;
			return;
		}

		if (event === 'close') {
			this.closeListener = listener;
		}
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		this.deliverPendingData();
	}

	emitData(chunk: Buffer): void {
		this.pendingData.push(chunk);
		this.deliverPendingData();
	}

	emitClose(): void {
		const streamClosed = new Error('stream closed');
		this.closeListener?.(streamClosed);
		this.endListener?.(streamClosed);
	}
}

/**
 * A scripted daemon child: bytes written to its stdin drive the shared fake
 * daemon, whose buffered responses come back as stdout data events, so the
 * bridged pipes carry the same protocol as the socket transport.
 */
export class FakeDaemonChild implements DaemonChildProcess {
	private exitListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	killed = 0;

	readonly stdin = {
		write: (
			chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			void this.pump(chunk, callback);
		}
	};

	constructor(private readonly daemon: FakeDaemonTransport) {}

	private async pump(
		chunk: Uint8Array,
		callback: (error?: Error | null) => void
	): Promise<void> {
		try {
			await this.daemon.write(chunk);

			for (const frame of this.daemon.takeResponses()) {
				this.stdout.emitData(frame);
			}

			callback();
		} catch (error) {
			callback(error instanceof Error ? error : new Error(String(error)));
		}
	}

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'exit') {
			this.exitListener = listener;
		}
	}

	kill(): void {
		this.killed += 1;
		this.exitListener?.(new Error('child exited'));
	}
}

/**
 * A daemon that dies as soon as it is spoken to: stdout closes before the
 * handshake's first reply arrives.
 */
export class DyingDaemonChild implements DaemonChildProcess {
	private exitListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	readonly stdin = {
		write: (
			_chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			this.stdout.emitClose();
			callback();
		}
	};

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'exit') {
			this.exitListener = listener;
		}
	}

	kill(): void {
		this.exitListener?.(new Error('child exited'));
	}
}

/**
 * A command that cannot start: the child reports the spawn failure through
 * its error event and, having never run, emits no exit.
 */
export class UnspawnableDaemonChild implements DaemonChildProcess {
	private errorListener: ((error: Error) => void) | undefined;

	readonly stdout = new FakeByteSource();

	killed = 0;

	readonly stdin = {
		write: (
			_chunk: Uint8Array,
			callback: (error?: Error | null) => void
		): void => {
			this.errorListener?.(this.spawnError);
			callback();
		}
	};

	constructor(private readonly spawnError: Error) {}

	once(event: 'exit' | 'error', listener: (error: Error) => void): void {
		if (event === 'error') {
			this.errorListener = listener;
		}
	}

	kill(): void {
		this.killed += 1;
	}
}
