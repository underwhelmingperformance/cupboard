import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
	access,
	chmod,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	prepareBuilderHook,
	removeBuilderHook
} from '../../actions/src/prepare-builders/hook.ts';
import { Nix } from '../../packages/nix/src/nix.ts';

const execute = promisify(execFile);
const transportScript = new URL(
	'../../actions/prepare/ssh-transport.sh',
	import.meta.url
);
const alias = 'cupboard-installer-trial.invalid';
const outputsSchema = z.object({ out: z.string() });
const buildResultSchema = z.array(z.object({ outputs: outputsSchema }));
const builderAction = new URL(
	'../../actions/prepare-builders/dist/',
	import.meta.url
);

async function run(
	command: string,
	arguments_: readonly string[],
	environment = process.env
) {
	return execute(command, arguments_, {
		env: environment,
		timeout: 120_000,
		maxBuffer: 4 * 1024 * 1024
	});
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('The SSH fixture did not obtain a TCP port');
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error !== undefined) {
				reject(error);
				return;
			}
			resolve();
		});
	});
	return address.port;
}

class LoopbackSsh {
	private child: ChildProcess | undefined;
	private stopped: Promise<unknown> | undefined;
	private stderr = '';
	private startError: Error | undefined;
	readonly username = userInfo().username;
	readonly identity: string;
	readonly hostKey: string;
	readonly otherKey: string;
	readonly commands: string;
	readonly outputLock: string;

	constructor(
		readonly directory: string,
		readonly port: number
	) {
		this.identity = path.join(directory, 'identity');
		this.hostKey = path.join(directory, 'host-key');
		this.otherKey = path.join(directory, 'other-key');
		this.commands = path.join(directory, 'commands');
		this.outputLock = path.join(directory, 'output-lock');
	}

	private async directKnownHosts(): Promise<string> {
		const file = path.join(this.directory, 'direct_known_hosts');
		await writeFile(file, await this.knownHosts());
		return file;
	}

	get builderUri(): string {
		return `ssh-ng://${this.username}@${alias}:${String(this.port)}?remote-program=/nix/var/nix/profiles/default/bin/nix-daemon`;
	}

	async start(): Promise<void> {
		for (const key of [this.identity, this.hostKey, this.otherKey]) {
			await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
		}
		await writeFile(this.commands, '');
		await writeFile(this.outputLock, '');
		const wrapper = path.join(this.directory, 'command.cjs');
		await writeFile(
			wrapper,
			`#!${process.execPath}\nconst fs = require('node:fs');\nconst { spawnSync } = require('node:child_process');\nconst command = process.env.SSH_ORIGINAL_COMMAND;\nif (!command) process.exit(1);\nfs.appendFileSync(${JSON.stringify(this.commands)}, command + '\\n');\nconst lock = fs.readFileSync(${JSON.stringify(this.outputLock)}, 'utf8');\nif (command.includes('nix-daemon') && lock && fs.existsSync(lock)) {\n  const moved = spawnSync('sudo', ['-n', 'mv', '-f', lock, ${JSON.stringify(path.join(this.directory, 'scheduled-output.lock'))}], { stdio: 'inherit' });\n  if (moved.status !== 0) process.exit(moved.status ?? 1);\n}\nconst child = spawnSync('/bin/sh', ['-c', command], { stdio: 'inherit' });\nprocess.exit(child.status ?? 1);\n`,
			{ mode: 0o700 }
		);
		const authorisedKeys = path.join(this.directory, 'authorized_keys');
		await writeFile(
			authorisedKeys,
			`command="${wrapper}" ${await readFile(`${this.identity}.pub`, 'utf8')}`,
			{ mode: 0o600 }
		);
		const config = path.join(this.directory, 'sshd_config');
		await writeFile(
			config,
			[
				`Port ${String(this.port)}`,
				'ListenAddress 127.0.0.1',
				`HostKey ${this.hostKey}`,
				`PidFile ${path.join(this.directory, 'sshd.pid')}`,
				`AuthorizedKeysFile ${authorisedKeys}`,
				`AllowUsers ${this.username}`,
				'PasswordAuthentication no',
				'KbdInteractiveAuthentication no',
				`UsePAM ${process.platform === 'linux' ? 'yes' : 'no'}`,
				'LogLevel VERBOSE',
				''
			].join('\n')
		);
		const effectiveConfig = await run('sudo', [
			'-n',
			'/usr/sbin/sshd',
			'-T',
			'-f',
			config
		]);
		// Intentional authentication failures must not throttle later loopback cases.
		const penaltyOptions = effectiveConfig.stdout
			.split('\n')
			.some((line) => line.startsWith('persourcepenalties '))
			? ['-o', 'PerSourcePenalties=no']
			: [];
		this.child = spawn(
			'sudo',
			['-n', '/usr/sbin/sshd', '-D', '-e', '-f', config, ...penaltyOptions],
			{ stdio: ['ignore', 'ignore', 'pipe'] }
		);
		this.child.on('error', (error) => {
			this.startError = error;
		});
		this.child.stderr?.on('data', (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});
		const child = this.child;
		this.stopped = new Promise((resolve) => {
			child.once('close', resolve);
		});
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (this.startError !== undefined || this.child.exitCode !== null) {
				throw new Error(`The loopback SSH server failed: ${this.stderr}`, {
					cause: this.startError
				});
			}
			try {
				await run('ssh', [
					'-F',
					'/dev/null',
					'-oBatchMode=yes',
					'-oIdentitiesOnly=yes',
					'-oStrictHostKeyChecking=yes',
					`-oUserKnownHostsFile=${await this.directKnownHosts()}`,
					'-oConnectTimeout=1',
					'-i',
					this.identity,
					'-p',
					String(this.port),
					`${this.username}@127.0.0.1`,
					'true'
				]);
				return;
			} catch {
				await setTimeout(100);
			}
		}
		throw new Error(
			`The loopback SSH server did not become ready: ${this.stderr}`
		);
	}

	get connectionLog(): string {
		return this.stderr;
	}

	async expectRefusal(
		before: string,
		scenario: 'wrong key' | 'wrong host pin'
	): Promise<void> {
		await expect
			.poll(() => {
				const events = this.stderr.slice(before.length);
				return {
					connected: /^Connection from 127\.0\.0\.1 /mu.test(events),
					refused:
						scenario === 'wrong key'
							? /^Failed publickey /mu.test(events)
							: /^Connection closed by 127\.0\.0\.1 .*\[preauth\]/mu.test(
									events
								),
					authenticated: /^Accepted publickey /mu.test(events)
				};
			})
			.toStrictEqual({ connected: true, refused: true, authenticated: false });
	}

	async knownHosts(key = this.hostKey): Promise<string> {
		return `[127.0.0.1]:${String(this.port)} ${await readFile(`${key}.pub`, 'utf8')}`;
	}

	async close(): Promise<void> {
		this.child?.kill('SIGTERM');
		if (this.stopped !== undefined) {
			await this.stopped;
		}
		const results = process.env.TRIAL_RESULTS;
		if (results === undefined) {
			return;
		}
		await writeFile(path.join(results, 'sshd.txt'), this.stderr);
		if (this.child === undefined) {
			return;
		}
		await copyFile(this.commands, path.join(results, 'ssh-commands.txt'));
	}

	async environment(
		mode: 'input' | 'builder',
		key = this.identity,
		hostKey = this.hostKey
	): Promise<NodeJS.ProcessEnv> {
		const directory = await mkdtemp(path.join(this.directory, `${mode}-`));
		const environmentFile = path.join(directory, 'github-env');
		await writeFile(environmentFile, '');
		const environment = {
			...process.env,
			RUNNER_TEMP: directory,
			GITHUB_ENV: environmentFile,
			INPUT_SSH_KEY: await readFile(key, 'utf8'),
			INPUT_KNOWN_HOSTS: await this.knownHosts(hostKey),
			REMOTE: mode === 'builder' ? 'true' : 'false',
			STORE: '',
			BUILDERS: `${this.builderUri} ${process.env.NIX_SYSTEM ?? ''} - 1 1`,
			BUILDER_SSH_KEY: await readFile(key, 'utf8'),
			BUILDER_KNOWN_HOSTS: await this.knownHosts(hostKey),
			BUILDER_SSH_CONFIG: `Host ${alias}\n  HostName 127.0.0.1\n`,
			STORE_SSH_KEY: '',
			STORE_SSH_CONFIG: '',
			STORE_KNOWN_HOSTS: '',
			STORE_AMBIENT_IDENTITY: 'false'
		};
		await run(
			'bash',
			[
				transportScript.pathname,
				mode === 'input' ? 'configure-input' : 'configure'
			],
			environment
		);
		const contents = await readFile(environmentFile, 'utf8');
		const exported = Object.fromEntries(
			contents
				.trim()
				.split('\n')
				.map((line) => {
					const separator = line.indexOf('=');
					return [line.slice(0, separator), line.slice(separator + 1)];
				})
		);
		return { ...process.env, ...exported, XDG_CACHE_HOME: directory };
	}
}

function derivation(marker: string): string {
	return `derivation { name = "cupboard-installer-${marker}"; system = builtins.currentSystem; builder = "/bin/sh"; args = [ "-c" "printf '${marker}' > $out" ]; preferLocalBuild = false; allowSubstitutes = false; }`;
}

async function actionFileValue(file: string, key: string): Promise<string> {
	const contents = await readFile(file, 'utf8');
	const headerEnd = contents.indexOf('\n');
	const header = contents.slice(0, headerEnd);
	const delimiter = header.slice(`${key}<<`.length);
	const end = contents.lastIndexOf(`\n${delimiter}\n`);
	if (delimiter === '' || end < headerEnd || !header.startsWith(`${key}<<`)) {
		throw new Error(`The builder action did not export ${key}`);
	}
	return contents.slice(headerEnd + 1, end);
}

describe('NixOS installer compatibility', () => {
	beforeAll(() => {
		if (
			process.env.CUPBOARD_NIX_INSTALLER_TRIAL !== '1' ||
			process.env.GITHUB_ACTIONS !== 'true'
		) {
			throw new Error(
				'Run this installation trial only in its disposable GitHub Actions jobs'
			);
		}
	});

	it('uses the exact installed version through a trusted daemon', async () => {
		const nix = Nix.open();
		const version = await run('nix', ['--version']);
		const system = await run('nix', [
			'eval',
			'--impure',
			'--raw',
			'--expr',
			'builtins.currentSystem'
		]);
		expect({
			version: version.stdout.trim(),
			system: system.stdout,
			store: nix.storeKind,
			trust: await nix.daemonTrust(),
			nonRoot: process.getuid?.() !== 0
		}).toStrictEqual({
			version: 'nix (Nix) 2.35.3',
			system: process.env.NIX_SYSTEM,
			store: 'daemon',
			trust: 'trusted',
			nonRoot: true
		});
	});

	it('accepts a hook executable available only to the trusted daemon', async () => {
		const directory = await mkdtemp('/tmp/cupboard-root-hook-');
		try {
			const command = path.join(directory, 'root-only');
			await writeFile(command, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
			await run('sudo', ['chown', '0', command]);
			const hook = await prepareBuilderHook(
				{
					...process.env,
					NIX_SSHOPTS: '-F /dev/null',
					NIX_CONFIG: `${process.env.NIX_CONFIG ?? ''}\nbuild-hook = ${command}\n`
				},
				{ probeWorkerPath: new URL('probe-worker.cjs', builderAction).pathname }
			);
			assert.ok(hook !== undefined);
			try {
				await expect(
					access(path.join(hook.directory, 'build-hook'))
				).resolves.toBeUndefined();
			} finally {
				await removeBuilderHook(hook.directory);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it('builds and realises a local derivation as the runner user', async () => {
		const marker = randomUUID();
		const result = await run('nix', [
			'build',
			'--no-link',
			'--json',
			'--impure',
			'--expr',
			derivation(marker),
			'--option',
			'builders',
			'',
			'--option',
			'sandbox',
			'false'
		]);
		const [built] = buildResultSchema.parse(JSON.parse(result.stdout));
		if (built === undefined) {
			throw new Error('The local build returned no output');
		}
		expect(await readFile(built.outputs.out, 'utf8')).toBe(marker);
	});

	it('connects to the official cache with the installed certificate configuration', async () => {
		await run('nix', [
			'store',
			'info',
			'--json',
			'--store',
			'https://cache.nixos.org'
		]);
	});

	describe('job-scoped SSH', () => {
		const state: { workspace?: string; ssh?: LoopbackSsh; input?: string } = {};

		function prepared(): { ssh: LoopbackSsh; input: string } {
			if (state.ssh === undefined || state.input === undefined) {
				throw new Error('The loopback SSH fixture was not prepared');
			}
			return { ssh: state.ssh, input: state.input };
		}

		beforeAll(async () => {
			const workspace = await mkdtemp(
				path.join(userInfo().homedir, '.cupboard-installer-')
			);
			await chmod(workspace, 0o700);
			const ssh = new LoopbackSsh(workspace, await unusedPort());
			state.workspace = workspace;
			state.ssh = ssh;
			await ssh.start();
			const input = path.join(workspace, 'private-input');
			state.input = input;
			await mkdir(input);
			await writeFile(
				path.join(input, 'flake.nix'),
				'{ outputs = { self }: { value = "authenticated-private-input"; }; }\n'
			);
			await run('git', ['init', '--initial-branch=main', input]);
			await run('git', ['-C', input, 'add', 'flake.nix']);
			await run('git', [
				'-C',
				input,
				'-c',
				'user.name=Cupboard fixture',
				'-c',
				'user.email=fixture@cupboard.invalid',
				'-c',
				'commit.gpgsign=false',
				'commit',
				'-m',
				'Create the private input fixture'
			]);
		}, 120_000);

		afterAll(async () => {
			await state.ssh?.close();
			if (state.workspace !== undefined) {
				await rm(state.workspace, { recursive: true, force: true });
			}
		});

		it.each(['wrong key', 'wrong host pin', 'valid credentials'] as const)(
			'evaluates a private Git input with %s',
			async (scenario) => {
				const { ssh, input } = prepared();
				const environment = await ssh.environment(
					'input',
					scenario === 'wrong key' ? ssh.otherKey : ssh.identity,
					scenario === 'wrong host pin' ? ssh.otherKey : ssh.hostKey
				);
				const uri = `git+ssh://${ssh.username}@127.0.0.1:${String(ssh.port)}${input}?ref=main`;
				const before = ssh.connectionLog;
				const evaluation = run(
					'nix',
					['eval', '--refresh', '--raw', `${uri}#value`],
					environment
				);
				if (scenario !== 'valid credentials') {
					await expect(evaluation).rejects.toMatchObject({ code: 1 });
					await ssh.expectRefusal(before, scenario);
					return;
				}
				const result = await evaluation;
				expect(result.stdout).toBe('authenticated-private-input');
			}
		);

		it.each(['wrong key', 'wrong host pin', 'valid credentials'] as const)(
			'builds through job-scoped SSH configuration with local builds disabled and %s',
			async (scenario) => {
				const { ssh } = prepared();
				const configured = await ssh.environment(
					'builder',
					scenario === 'wrong key' ? ssh.otherKey : ssh.identity,
					scenario === 'wrong host pin' ? ssh.otherKey : ssh.hostKey
				);
				const directory = configured.RUNNER_TEMP;
				if (directory === undefined) {
					throw new Error('The SSH fixture did not configure RUNNER_TEMP');
				}
				const stateFile = path.join(directory, 'hook-state');
				const environmentFile = path.join(directory, 'hook-environment');
				await writeFile(stateFile, '');
				await writeFile(environmentFile, '');
				const actionEnvironment = {
					...configured,
					GITHUB_ENV: environmentFile,
					GITHUB_STATE: stateFile
				};
				await run(
					process.execPath,
					[new URL('main.cjs', builderAction).pathname],
					actionEnvironment
				);
				const hookDirectory = await actionFileValue(
					stateFile,
					'cupboard-builder-hook'
				);
				const environment = {
					...actionEnvironment,
					NIX_CONFIG: await actionFileValue(environmentFile, 'NIX_CONFIG')
				};
				try {
					const marker = randomUUID();
					const expression = derivation(marker);
					const output = await run(
						'nix',
						['eval', '--impure', '--raw', '--expr', `(${expression}).outPath`],
						environment
					);
					// Both sides share /nix/store. Give the remote build its own lock inode
					// for this fresh fixture output; the scheduler keeps its original lock.
					await writeFile(ssh.outputLock, `${output.stdout}.lock`);
					if (scenario === 'valid credentials') {
						await run(
							'nix',
							['store', 'info', '--json', '--store', ssh.builderUri],
							environment
						);
					}
					const connectionLog = ssh.connectionLog;
					const before = await readFile(ssh.commands, 'utf8');
					const build = run(
						'nix',
						[
							'build',
							'--no-link',
							'--json',
							'--impure',
							'--max-jobs',
							'0',
							'--option',
							'sandbox',
							'false',
							'--expr',
							expression
						],
						environment
					);
					if (scenario !== 'valid credentials') {
						await expect(build).rejects.toMatchObject({ code: 1 });
						await ssh.expectRefusal(connectionLog, scenario);
						expect(await readFile(ssh.commands, 'utf8')).toBe(before);
						return;
					}
					const result = await build;
					const [built] = buildResultSchema.parse(JSON.parse(result.stdout));
					if (built === undefined) {
						throw new Error('The remote build returned no output');
					}
					const commands = await readFile(ssh.commands, 'utf8');
					expect({
						output: await readFile(built.outputs.out, 'utf8'),
						usedSsh: commands.slice(before.length).includes('nix-daemon')
					}).toStrictEqual({ output: marker, usedSsh: true });
				} finally {
					await run(
						process.execPath,
						[new URL('post.cjs', builderAction).pathname],
						{ ...environment, 'STATE_cupboard-builder-hook': hookDirectory }
					);
					await expect(access(hookDirectory)).rejects.toMatchObject({
						code: 'ENOENT'
					});
				}
			}
		);
	});
});
