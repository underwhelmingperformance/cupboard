import { Writable } from 'node:stream';

import { storePathSchema } from '@cupboard/nix-store/scalars';
import { terminationGracePeriodMs } from '@cupboard/shared/child-process';
import { describe, expect, it, vi } from 'vitest';

import { CommandFailedError } from './errors.ts';
import { copyNixPaths, type NixCopyProcess } from './nix-copy.ts';

const paths = [
	storePathSchema.parse('/nix/store/11111111111111111111111111111111-first'),
	storePathSchema.parse('/nix/store/22222222222222222222222222222222-second')
];
const destination = 'ssh-ng://builder?remote-store=/srv/nix';

class ControlledCopyProcess implements NixCopyProcess {
	#onError: ((error: Error) => void) | undefined;
	#onClose:
		| ((status: number | null, signal: NodeJS.Signals | undefined) => void)
		| undefined;

	readonly signals: NodeJS.Signals[] = [];

	constructor(readonly stdin: Writable) {}

	kill(signal: NodeJS.Signals): boolean {
		this.signals.push(signal);
		return true;
	}

	onceError(listener: (error: Error) => void): void {
		this.#onError = listener;
	}

	onceClose(
		listener: (
			status: number | null,
			signal: NodeJS.Signals | undefined
		) => void
	): void {
		this.#onClose = listener;
	}

	emitError(error: Error): void {
		if (this.#onError === undefined) {
			throw new Error('Expected the copy to observe child errors');
		}
		this.#onError(error);
	}

	emitClose(status: number | null, signal?: NodeJS.Signals): void {
		if (this.#onClose === undefined) {
			throw new Error('Expected the copy to observe child closure');
		}
		this.#onClose(status, signal);
	}
}

function acceptingInput(input: string[]): Writable {
	return new Writable({
		write(chunk: Uint8Array, _encoding, callback) {
			input.push(Buffer.from(chunk).toString('utf8'));
			callback();
		}
	});
}

describe('copyNixPaths', () => {
	it.each([undefined, 'local'])(
		'preserves the source %s and exact destination',
		async (from) => {
			const input: string[] = [];
			const child = new ControlledCopyProcess(acceptingInput(input));
			const start = vi.fn(() => child);
			const finished = new Promise<void>((resolve) =>
				child.stdin.once('finish', resolve)
			);
			const copy = copyNixPaths(
				{ paths, to: destination, ...(from && { from }) },
				undefined,
				{ start }
			);
			await finished;
			child.emitClose(0);
			await copy;
			expect({
				start: start.mock.calls,
				input,
				signals: child.signals
			}).toStrictEqual({
				start: [
					[
						[
							'copy',
							...(from === undefined ? [] : ['--from', from]),
							'--to',
							destination,
							'--stdin'
						],
						undefined
					]
				],
				input: paths.map((path) => `${path}\n`),
				signals: []
			});
		}
	);

	it('waits for backpressure before writing more paths', async () => {
		const input: string[] = [];
		const callbacks: (() => void)[] = [];
		let isBlocked = true;
		const first = Promise.withResolvers<undefined>();
		const second = Promise.withResolvers<undefined>();
		const child = new ControlledCopyProcess(
			new Writable({
				highWaterMark: 1,
				write(chunk: Uint8Array, _encoding, callback) {
					input.push(Buffer.from(chunk).toString('utf8'));
					if (!isBlocked) {
						callback();
						return;
					}
					callbacks.push(callback);
					(input.length === 1 ? first : second).resolve(undefined);
				}
			})
		);
		const finished = new Promise<void>((resolve) =>
			child.stdin.once('finish', resolve)
		);
		const copy = copyNixPaths({ paths, to: destination }, undefined, {
			start: () => child
		});
		await first.promise;
		expect(input).toStrictEqual([`${String(paths[0])}\n`]);
		const releaseFirst = callbacks[0];
		if (releaseFirst === undefined) {
			throw new Error('Expected one pending stdin write');
		}
		releaseFirst();
		await second.promise;
		isBlocked = false;
		const releaseSecond = callbacks[1];
		if (releaseSecond === undefined) {
			throw new Error('Expected the next pending stdin write');
		}
		releaseSecond();
		await finished;
		child.emitClose(0);
		await copy;
		expect({ input, signals: child.signals }).toStrictEqual({
			input: paths.map((path) => `${path}\n`),
			signals: []
		});
	});

	it('terminates and reaps a live child when stdin fails', async () => {
		vi.useFakeTimers();
		const writing = Promise.withResolvers<undefined>();
		const child = new ControlledCopyProcess(
			new Writable({
				write() {
					writing.resolve(undefined);
				}
			})
		);
		const error = new Error('stdin rejected the path list');
		const settled = vi.fn();
		const copy = copyNixPaths({ paths, to: destination }, undefined, {
			start: () => child
		});
		void copy.then(settled).catch(settled);
		try {
			await writing.promise;
			const failed = new Promise<void>((resolve) =>
				child.stdin.once('error', () => {
					resolve();
				})
			);
			child.stdin.destroy(error);
			await failed;
			expect({
				signals: child.signals,
				settled: settled.mock.calls
			}).toStrictEqual({ signals: ['SIGTERM'], settled: [] });
			vi.advanceTimersByTime(terminationGracePeriodMs);
			expect({
				signals: child.signals,
				settled: settled.mock.calls
			}).toStrictEqual({ signals: ['SIGTERM', 'SIGKILL'], settled: [] });
			child.emitClose(0);
			await expect(copy).rejects.toBe(error);
		} finally {
			vi.useRealTimers();
		}
	});

	it('preserves a spawn failure ahead of a secondary pipe error', async () => {
		const child = new ControlledCopyProcess(acceptingInput([]));
		const spawnError = new Error('Nix could not start');
		const pipeError = new Error('stdin closed after the spawn failure');
		const copy = copyNixPaths({ paths, to: destination }, undefined, {
			start: () => child
		});
		child.emitError(spawnError);
		child.stdin.destroy(pipeError);
		child.emitClose(-2);
		await expect(copy).rejects.toBe(spawnError);
		expect(child.signals).toStrictEqual([]);
	});

	it('reports a nonzero exit ahead of a secondary pipe error', async () => {
		const child = new ControlledCopyProcess(acceptingInput([]));
		const copy = copyNixPaths({ paths, to: destination }, undefined, {
			start: () => child
		});
		child.emitClose(17);
		child.stdin.destroy(new Error('stdin closed after the early exit'));
		await expect(copy).rejects.toStrictEqual(
			new CommandFailedError('nix copy', 17)
		);
		expect(child.signals).toStrictEqual([]);
	});

	it('does not start a copy after cancellation', async () => {
		const controller = new AbortController();
		const reason = new Error('copy cancelled before launch');
		controller.abort(reason);
		const start = vi.fn(() => new ControlledCopyProcess(acceptingInput([])));
		await expect(
			copyNixPaths({ paths, to: destination }, controller.signal, { start })
		).rejects.toBe(reason);
		expect(start.mock.calls).toStrictEqual([]);
	});
});
