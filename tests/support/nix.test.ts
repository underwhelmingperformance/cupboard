import { type ChildProcess, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { temporaryRoot, withTemporaryDirectory } from './filesystem.ts';
import {
	isolatedEnvironment,
	NixDaemonStartError,
	waitForDaemonSocket
} from './nix.ts';

const delayedInheritedError = [
	"const { spawn } = require('node:child_process');",
	`const descendant = spawn(${JSON.stringify(process.execPath)}, [`,
	"\t'-e',",
	`\t${JSON.stringify("setTimeout(() => process.stderr.write('late daemon error'), 250)")}`,
	'], {',
	'\tdetached: true,',
	"\tstdio: ['ignore', 'ignore', process.stderr]",
	'});',
	'descendant.unref();'
].join('\n');

function waitForClose(child: ChildProcess): Promise<void> {
	if (
		(child.exitCode !== null || child.signalCode !== null) &&
		(child.stdout === null || child.stdout.closed) &&
		(child.stderr === null || child.stderr.closed)
	) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		child.once('close', () => {
			resolve();
		});
	});
}

describe('waitForDaemonSocket', () => {
	it('resolves when the daemon socket appears', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-ready-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				const child = spawn(
					process.execPath,
					[
						'-e',
						"require('node:net').createServer().listen(process.argv[1])",
						socketPath
					],
					{
						stdio: 'ignore'
					}
				);

				try {
					const ready = waitForDaemonSocket(child, socketPath, () => '');

					await expect(ready).resolves.toBeUndefined();
				} finally {
					const closed = waitForClose(child);
					child.kill();
					await closed;
				}
			}
		);
	});

	it('reports a daemon that exits before opening its socket', async () => {
		await withTemporaryDirectory('cupboard-daemon-exit-', async (directory) => {
			const socketPath = path.join(directory, 'socket');
			const child = spawn(process.execPath, ['-e', 'process.exit(23)'], {
				stdio: 'ignore'
			});

			await expect(
				waitForDaemonSocket(child, socketPath, () => 'daemon exploded')
			).rejects.toStrictEqual(
				new NixDaemonStartError(socketPath, 'daemon exploded')
			);
		});
	});

	it('waits for daemon diagnostics to close after process exit', async () => {
		await withTemporaryDirectory(
			'cupboard-daemon-diagnostics-',
			async (directory) => {
				const socketPath = path.join(directory, 'socket');
				const child = spawn(process.execPath, ['-e', delayedInheritedError], {
					stdio: ['ignore', 'ignore', 'pipe']
				});
				const stderr: Buffer[] = [];
				child.stderr.on('data', (chunk: Buffer) => {
					stderr.push(chunk);
				});

				await expect(
					waitForDaemonSocket(child, socketPath, () =>
						Buffer.concat(stderr).toString('utf8')
					)
				).rejects.toStrictEqual(
					new NixDaemonStartError(socketPath, 'late daemon error')
				);
			}
		);
	});
});

describe('isolatedEnvironment', () => {
	it('writes the command features required by the test harness', async () => {
		await withTemporaryDirectory('cupboard-nix-environment-', async (home) => {
			const configDirectory = path.join(home, 'nix-conf');
			const environment = await isolatedEnvironment(home);

			expect({
				environment,
				configuration: await readFile(
					path.join(configDirectory, 'nix.conf'),
					'utf8'
				)
			}).toStrictEqual({
				environment: {
					HOME: home,
					NIX_CONF_DIR: configDirectory,
					NIX_USER_CONF_FILES: '/dev/null',
					PATH: process.env.PATH ?? '',
					TMPDIR: temporaryRoot
				},
				configuration: 'experimental-features = nix-command flakes\n'
			});
		});
	});
});
