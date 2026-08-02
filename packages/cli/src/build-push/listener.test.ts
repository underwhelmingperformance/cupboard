import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process, { platform } from 'node:process';

import { storeDirectorySchema } from '@cupboard/nix-store/scalars';
import type { ParsedBuildEvent } from '@cupboard/protocol/build';
import { afterEach, describe, expect, it } from 'vitest';

import {
	BuildEventMalformedError,
	BuildEventOutsideStoreError,
	type BuildEventRejectedError
} from '../errors.ts';

import { BuildEventListener } from './listener.ts';

const storeDirectory = storeDirectorySchema.parse('/nix/store');
const outputPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const otherOutputPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';
const derivation = '/nix/store/4123456789abcdfghijklmnpqrsvwxyz-app.drv';

function buildEvent(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		invocationId: 'invocation-1',
		derivation,
		outputPaths: [outputPath],
		...overrides
	};
}

const directories: string[] = [];
const listeners: BuildEventListener[] = [];

afterEach(async () => {
	const open = [...listeners];
	const created = [...directories];
	listeners.length = 0;
	directories.length = 0;

	await Promise.all(open.map((listener) => listener.close()));
	await Promise.all(
		created.map((directory) => rm(directory, { recursive: true, force: true }))
	);
});

async function startListener(options: { drainTimeoutMs?: number } = {}) {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-hook-'));
	directories.push(directory);

	const socketPath = path.join(directory, 'hook.sock');
	const events: ParsedBuildEvent[] = [];
	const rejections: BuildEventRejectedError[] = [];
	let notify: (() => void) | undefined;

	const listener = await BuildEventListener.listen({
		socketPath,
		storeDirectory,
		...(options.drainTimeoutMs !== undefined && {
			drainTimeoutMs: options.drainTimeoutMs
		}),
		onEvent: (event) => {
			events.push(event);
			notify?.();
		},
		onRejected: (error) => {
			rejections.push(error);
			notify?.();
		}
	});
	listeners.push(listener);

	// Callbacks only fire from IO events, so the count cannot move between the
	// check and arming the notifier.
	const settledCount = async (total: number) => {
		while (events.length + rejections.length < total) {
			const waiter = Promise.withResolvers<boolean>();
			notify = () => {
				waiter.resolve(true);
			};
			await waiter.promise;
		}
	};

	return { listener, socketPath, events, rejections, settledCount };
}

// A helper standing in for the hook's: it connects, writes one message and
// exits as soon as the bytes have left it. Run synchronously, it completes
// while the listener's event loop is blocked, so its connection is still
// queued on the listening socket when the run comes to drain.
const helperScript = [
	"const net = require('net');",
	'const [socketPath, line] = process.argv.slice(1);',
	'const socket = net.connect(socketPath, () => {',
	"\tsocket.write(line + '\\n', () => process.exit(0));",
	'});',
	"socket.on('error', () => process.exit(1));"
].join('\n');

function runHelper(socketPath: string, payload: string): number | null {
	return spawnSync(process.execPath, ['-e', helperScript, socketPath, payload])
		.status;
}

function send(socketPath: string, payload: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const client = createConnection(socketPath, () => {
			client.end(payload, () => {
				resolve();
			});
		});
		client.on('error', reject);
	});
}

describe('BuildEventListener', () => {
	it('accepts a valid event and records it', async () => {
		const harness = await startListener();
		const event = buildEvent();

		await send(harness.socketPath, `${JSON.stringify(event)}\n`);
		await harness.settledCount(1);

		expect({
			events: harness.events,
			rejections: harness.rejections,
			accepted: [...harness.listener.accepted]
		}).toStrictEqual({
			events: [event],
			rejections: [],
			accepted: [event]
		});
	});

	it.runIf(platform === 'darwin' || platform === 'linux')(
		'listens at an owner-only socket',
		async () => {
			const harness = await startListener();
			const socketStat = await stat(harness.socketPath);

			expect(socketStat.mode & 0o777).toBe(0o600);
		}
	);

	it.each([
		{
			name: 'an event with an unknown format version',
			payload: `${JSON.stringify(buildEvent({ version: 2 }))}\n`,
			kind: 'invalid-event'
		},
		{
			name: 'an event missing its output paths',
			payload: `${JSON.stringify(buildEvent({ outputPaths: [] }))}\n`,
			kind: 'invalid-event'
		},
		{
			name: 'a line that is not JSON',
			payload: '{not json\n',
			kind: 'invalid-json'
		},
		{
			name: 'a connection closed without a newline',
			payload: JSON.stringify(buildEvent()),
			kind: 'missing-line'
		}
	])('rejects $name', async ({ payload, kind }) => {
		const harness = await startListener();

		await send(harness.socketPath, payload);
		await harness.settledCount(1);

		expect({
			events: harness.events,
			rejections: harness.rejections.map((error) => ({
				malformed: error instanceof BuildEventMalformedError,
				kind: error instanceof BuildEventMalformedError ? error.kind : undefined
			}))
		}).toStrictEqual({
			events: [],
			rejections: [{ malformed: true, kind }]
		});
	});

	it('rejects an event naming a path outside the selected store', async () => {
		const harness = await startListener();
		const foreignPath = '/nix/other/0123456789abcdfghijklmnpqrsvwxyz-app';
		const event = buildEvent({ outputPaths: [outputPath, foreignPath] });

		await send(harness.socketPath, `${JSON.stringify(event)}\n`);
		await harness.settledCount(1);

		const [rejection] = harness.rejections;
		expect(rejection).toBeInstanceOf(BuildEventOutsideStoreError);
		expect(
			rejection instanceof BuildEventOutsideStoreError
				? {
						storePath: rejection.storePath,
						storeDirectory: rejection.storeDirectory
					}
				: undefined
		).toStrictEqual({
			storePath: foreignPath,
			storeDirectory: '/nix/store'
		});
		expect(harness.events).toStrictEqual([]);
	});

	it('delivers two whole messages over concurrent connections', async () => {
		const harness = await startListener();
		const first = JSON.stringify(buildEvent({ invocationId: 'invocation-1' }));
		const second = JSON.stringify(
			buildEvent({
				invocationId: 'invocation-2',
				outputPaths: [otherOutputPath]
			})
		);

		const clientA = createConnection(harness.socketPath);
		const clientB = createConnection(harness.socketPath);
		await Promise.all([once(clientA, 'connect'), once(clientB, 'connect')]);

		// Interleave partial writes so each connection's framing stands alone.
		clientA.write(first.slice(0, 10));
		clientB.write(second.slice(0, 10));
		clientA.write(`${first.slice(10)}\n`);
		clientB.write(`${second.slice(10)}\n`);
		await harness.settledCount(2);
		clientA.destroy();
		clientB.destroy();

		expect({
			events: harness.events.toSorted((left, right) =>
				left.invocationId.localeCompare(right.invocationId)
			),
			rejections: harness.rejections
		}).toStrictEqual({
			events: [
				buildEvent({ invocationId: 'invocation-1' }),
				buildEvent({
					invocationId: 'invocation-2',
					outputPaths: [otherOutputPath]
				})
			],
			rejections: []
		});
	});

	describe('drain', () => {
		it('includes an event whose message lands after drain begins', async () => {
			const harness = await startListener();
			const event = buildEvent();
			const client = createConnection(harness.socketPath);
			await once(client, 'connect');

			const drained = harness.listener.drain();
			setTimeout(() => {
				client.end(`${JSON.stringify(event)}\n`);
			}, 10);
			await drained;

			expect({
				events: harness.events,
				rejections: harness.rejections,
				accepted: [...harness.listener.accepted]
			}).toStrictEqual({
				events: [event],
				rejections: [],
				accepted: [event]
			});
		});

		it('accepts a connection queued while the listener was blocked', async () => {
			const harness = await startListener();
			const event = buildEvent();
			const status = runHelper(harness.socketPath, JSON.stringify(event));

			await harness.listener.drain();

			expect({
				status,
				events: harness.events,
				rejections: harness.rejections,
				accepted: [...harness.listener.accepted]
			}).toStrictEqual({
				status: 0,
				events: [event],
				rejections: [],
				accepted: [event]
			});
		});

		it('resolves when no connection is pending', async () => {
			const harness = await startListener();

			await harness.listener.drain();

			expect({
				events: harness.events,
				rejections: harness.rejections
			}).toStrictEqual({ events: [], rejections: [] });
		});

		it('cuts off a connection that never settles once the timeout elapses', async () => {
			const harness = await startListener({ drainTimeoutMs: 50 });
			const client = createConnection(harness.socketPath);
			client.on('error', () => {
				return;
			});
			await once(client, 'connect');
			client.write(JSON.stringify(buildEvent()).slice(0, 5));
			const closed = once(client, 'close');

			await harness.listener.drain();
			await closed;

			expect({
				events: harness.events,
				rejections: harness.rejections
			}).toStrictEqual({ events: [], rejections: [] });
		});

		it('refuses a connection arriving after drain', async () => {
			const harness = await startListener();

			await harness.listener.drain();

			const client = createConnection(harness.socketPath, () => {
				client.write(`${JSON.stringify(buildEvent())}\n`);
			});
			client.on('error', () => {
				return;
			});
			await new Promise<void>((resolve) => {
				client.on('close', () => {
					resolve();
				});
			});

			expect({
				events: harness.events,
				rejections: harness.rejections,
				accepted: [...harness.listener.accepted]
			}).toStrictEqual({ events: [], rejections: [], accepted: [] });
		});
	});
});
