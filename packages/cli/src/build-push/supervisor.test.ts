import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { platform } from 'node:process';

import { describe, expect, it } from 'vitest';

import {
	type ChildExit,
	type SignalSource,
	superviseBuild
} from './supervisor.ts';

async function runtimeDirectory(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), 'cup-sup-'));
}

function recordingSignalSource() {
	const listeners = new Map<string, (() => void)[]>();

	const source: SignalSource = {
		on(signal, listener) {
			listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);

			return source;
		},
		off(signal, listener) {
			listeners.set(
				signal,
				(listeners.get(signal) ?? []).filter((item) => item !== listener)
			);

			return source;
		}
	};

	return {
		source,
		emit(signal: string): void {
			const registered = listeners.get(signal) ?? [];

			for (const listener of registered) {
				listener();
			}
		},
		listenerCount(): number {
			return listeners
				.values()
				.reduce((total, registered) => total + registered.length, 0);
		}
	};
}

async function waitForFile(filePath: string): Promise<void> {
	for (;;) {
		try {
			await stat(filePath);

			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

describe('superviseBuild', () => {
	it.each([
		{
			name: 'a successful child',
			script: 'exit 0',
			expected: { status: 0, signal: undefined }
		},
		{
			name: 'a failing child, preserving its status',
			script: 'exit 7',
			expected: { status: 7, signal: undefined }
		}
	])('passes through the exit of $name', async ({ script, expected }) => {
		const directory = await runtimeDirectory();

		const exit = await superviseBuild({
			command: ['sh', '-c', script],
			environment: {},
			runtimeDirectory: directory
		});

		expect(exit).toStrictEqual(expected);
	});

	it('runs the child with the composed environment', async () => {
		const directory = await runtimeDirectory();
		const outFile = path.join(tmpdir(), `cup-sup-env-${String(Date.now())}`);

		try {
			const exit = await superviseBuild({
				command: ['sh', '-c', 'printf %s "$NIX_CONFIG" > "$CUPBOARD_TEST_OUT"'],
				environment: {
					PATH: '/usr/bin:/bin',
					CUPBOARD_TEST_OUT: outFile,
					NIX_CONFIG: 'post-build-hook = /inv/hook.sh'
				},
				runtimeDirectory: directory
			});

			expect({
				exit,
				written: await readFile(outFile, 'utf8')
			}).toStrictEqual({
				exit: { status: 0, signal: undefined },
				written: 'post-build-hook = /inv/hook.sh'
			});
		} finally {
			await rm(outFile, { force: true });
		}
	});

	it.each([
		{ name: 'a successful child', script: 'exit 0' },
		{ name: 'a failing child', script: 'exit 3' }
	])('removes the runtime directory after $name', async ({ script }) => {
		const directory = await runtimeDirectory();

		await superviseBuild({
			command: ['sh', '-c', script],
			environment: {},
			runtimeDirectory: directory
		});

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('removes the runtime directory when the child cannot start', async () => {
		const directory = await runtimeDirectory();

		await expect(
			superviseBuild({
				command: [path.join(directory, 'missing-executable')],
				environment: {},
				runtimeDirectory: directory
			})
		).rejects.toMatchObject({ code: 'ENOENT' });

		await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('drains through onExit before removing the runtime directory', async () => {
		const directory = await runtimeDirectory();
		const observed: { exit: ChildExit; directoryExisted: boolean }[] = [];

		await superviseBuild({
			command: ['sh', '-c', 'exit 5'],
			environment: {},
			runtimeDirectory: directory,
			onExit: async (exit) => {
				let didDirectoryExist = true;

				try {
					await stat(directory);
				} catch {
					didDirectoryExist = false;
				}

				observed.push({ exit, directoryExisted: didDirectoryExist });
			}
		});

		expect(observed).toStrictEqual([
			{ exit: { status: 5, signal: undefined }, directoryExisted: true }
		]);
	});

	it.runIf(platform === 'darwin' || platform === 'linux').each([
		{ signal: 'SIGINT', trap: 'INT', status: 42 },
		{ signal: 'SIGTERM', trap: 'TERM', status: 43 }
	])('forwards $signal to the child', async ({ signal, trap, status }) => {
		const directory = await runtimeDirectory();
		const readyFile = path.join(
			tmpdir(),
			`cup-sup-ready-${signal}-${String(Date.now())}`
		);
		const signals = recordingSignalSource();

		try {
			const running = superviseBuild({
				command: [
					'sh',
					'-c',
					`trap 'exit ${String(status)}' ${trap}; : > "$CUPBOARD_TEST_READY"; while :; do sleep 0.05; done`
				],
				environment: {
					PATH: '/usr/bin:/bin',
					CUPBOARD_TEST_READY: readyFile
				},
				runtimeDirectory: directory,
				signalSource: signals.source
			});

			await waitForFile(readyFile);
			signals.emit(signal);

			expect({
				exit: await running,
				remainingListeners: signals.listenerCount()
			}).toStrictEqual({
				exit: { status, signal: undefined },
				remainingListeners: 0
			});
		} finally {
			await rm(readyFile, { force: true });
		}
	});
});
