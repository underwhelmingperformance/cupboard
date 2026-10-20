import { execFile, spawn } from 'node:child_process';
import { access, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { withTemporaryDirectory } from '../../../tests/support/filesystem.ts';

import {
	BuilderHookCleanupError,
	BuilderHookTrustError,
	prepareBuilderHook,
	removeBuilderHook
} from './hook.ts';

const execute = promisify(execFile);
const probeWorkerPath = fileURLToPath(
	new URL('../../prepare-builders/dist/probe-worker.cjs', import.meta.url)
);
const localStore = {
	storeKind: 'local-filesystem' as const,
	daemonTrust: () => Promise.resolve('unknown' as const)
};

it('preserves the hook arguments, SSH options and protocol file descriptors', async () => {
	await withTemporaryDirectory("cupboard-hook 'quoted' ", async (directory) => {
		const command = path.join(directory, 'custom hook');
		await writeFile(
			command,
			'#!/bin/sh\nprintf "%s\\n" "$NIX_SSHOPTS" "$@"\nprintf builder-output >&4\nread -r line <&5\nprintf "%s" "$line" >&4\nexit 23\n',
			{ mode: 0o700 }
		);
		const sshOptions = `-F '${directory}/ssh config'`;
		const result = await prepareBuilderHook(
			{ ...process.env, NIX_SSHOPTS: sshOptions, NIX_CONFIG: 'max-jobs = 0' },
			{
				store: localStore,
				probeWorkerPath,
				readHook: () => Promise.resolve([command, "argument 'with quotes'"]),
				executeProbe: async (hook) => {
					await execute(hook);
				}
			}
		);
		try {
			const hook = path.join(result.directory, 'build-hook');
			const child = spawn(hook, ['17'], {
				stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'pipe', 'pipe'],
				env: { ...process.env, NIX_SSHOPTS: 'daemon-global-options' }
			});
			const output = child.stdio.at(4);
			const input = child.stdio.at(5);
			if (
				!(output instanceof Readable) ||
				!(input instanceof Writable) ||
				child.stdout === null
			) {
				throw new TypeError(
					'The hook fixture did not open its protocol descriptors'
				);
			}
			input.end('protocol-input\n');
			const [stdout, protocol, status] = await Promise.all([
				text(child.stdout),
				text(output),
				new Promise<number | null>((resolve, reject) => {
					child.once('error', reject);
					child.once('close', resolve);
				})
			]);
			const directoryMetadata = await stat(result.directory);
			const hookMetadata = await stat(hook);
			expect({
				stdout,
				protocol,
				status,
				configuration: result.nixConfig,
				directoryMode: directoryMetadata.mode & 0o777,
				hookMode: hookMetadata.mode & 0o777
			}).toStrictEqual({
				stdout: `${sshOptions}\nargument 'with quotes'\n17\n`,
				protocol: 'builder-outputprotocol-input',
				status: 23,
				configuration: `max-jobs = 0\nbuild-hook = ${hook}\n`,
				directoryMode: 0o700,
				hookMode: 0o700
			});
		} finally {
			await removeBuilderHook(result.directory);
		}
		await expect(access(result.directory)).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});
});

it('keeps concurrent jobs independent and resolves the existing hook through PATH', async () => {
	const results = await Promise.all(
		['first-job', 'second-job'].map((sshOptions) =>
			prepareBuilderHook(
				{ ...process.env, NIX_SSHOPTS: sshOptions },
				{
					probeWorkerPath,
					store: {
						storeKind: 'daemon',
						daemonTrust: () => Promise.resolve('trusted')
					},
					readHook: () => Promise.resolve(['printenv', 'NIX_SSHOPTS']),
					executeProbe: async (hook) => {
						await execute(hook);
					}
				}
			)
		)
	);
	try {
		const output = await Promise.all(
			results.map(async (result) => {
				const { stdout } = await execute(
					path.join(result.directory, 'build-hook')
				);
				return stdout;
			})
		);
		expect(output).toStrictEqual(['first-job\n', 'second-job\n']);
	} finally {
		await Promise.all(
			results.map((result) => removeBuilderHook(result.directory))
		);
	}
});

it.each(['not-trusted', 'unknown'] as const)(
	'refuses a daemon whose trust result is %s',
	async (trust) => {
		await expect(
			prepareBuilderHook(
				{ NIX_SSHOPTS: '-F /fixture/config' },
				{
					probeWorkerPath,
					store: {
						storeKind: 'daemon',
						daemonTrust: () => Promise.resolve(trust)
					},
					readHook: () => Promise.resolve(['/bin/false'])
				}
			)
		).rejects.toBeInstanceOf(BuilderHookTrustError);
	}
);

it.each(['/tmp', '/tmp/cupboard-builder-invalid/child', '/home/runner'])(
	'refuses an unrelated cleanup path %s',
	async (directory) => {
		await expect(removeBuilderHook(directory)).rejects.toBeInstanceOf(
			BuilderHookCleanupError
		);
	}
);

it('resolves the hook in the store process instead of the action PATH', async () => {
	await withTemporaryDirectory('cupboard-store-path-', async (directory) => {
		const command = path.join(directory, 'store-only-hook');
		await writeFile(command, '#!/bin/sh\nprintf "%s" "$NIX_SSHOPTS"\n', {
			mode: 0o700
		});
		const result = await prepareBuilderHook(
			{
				...process.env,
				PATH: '/missing-action-path',
				NIX_SSHOPTS: 'job-options'
			},
			{
				store: localStore,
				probeWorkerPath,
				readHook: () => Promise.resolve(['store-only-hook']),
				executeProbe: async (hook) => {
					await execute(hook, [], { env: { PATH: directory } });
				}
			}
		);
		try {
			const { stdout } = await execute(
				path.join(result.directory, 'build-hook')
			);
			expect(stdout).toBe('job-options');
		} finally {
			await removeBuilderHook(result.directory);
		}
	});
});

it('refuses a store that cannot execute the adapter and removes its files', async () => {
	let directory = '';
	await expect(
		prepareBuilderHook(
			{ ...process.env, NIX_SSHOPTS: 'job-options' },
			{
				store: localStore,
				probeWorkerPath,
				readHook: () => Promise.resolve(['/usr/bin/true']),
				executeProbe: (hook) => {
					directory = path.dirname(hook);
					return Promise.resolve();
				}
			}
		)
	).rejects.toMatchObject({ name: 'BuilderHookCapabilityError' });
	await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preserves the Nix error when the store cannot start the probe', async () => {
	const failure = Object.assign(
		new Error('The fixture could not evaluate the probe'),
		{ code: 1 }
	);
	await expect(
		prepareBuilderHook(
			{ ...process.env, NIX_SSHOPTS: 'job-options' },
			{
				store: localStore,
				readHook: () => Promise.resolve(['/usr/bin/true']),
				executeProbe: () => Promise.reject(failure)
			}
		)
	).rejects.toMatchObject({
		name: 'BuilderHookCapabilityError',
		cause: failure
	});
});
