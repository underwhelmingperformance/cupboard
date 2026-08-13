import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ResolvedCupboard } from './cupboard-resolution.ts';
import {
	acquireSourceCupboard,
	SourceBuildOutputError,
	SourceCheckoutCommitMismatchError,
	SourceCheckoutDirtyError,
	SourceCheckoutRepositoryMismatchError,
	type SourceCommandRunner,
	SourceInstallationIncompleteError,
	SourceInstallationVersionMismatchError
} from './source-install.ts';

const sourceCommit = '0123456789abcdef0123456789abcdef01234567';
const cupboard: Extract<ResolvedCupboard, { kind: 'source' }> = {
	kind: 'source',
	repository: 'underwhelmingperformance/cupboard',
	sourceCommit
};

interface CommandResult {
	readonly stdout: string;
}

interface CommandInvocation {
	readonly command: string;
	readonly arguments_: readonly string[];
}

class RecordingCommandRunner {
	readonly invocations: CommandInvocation[] = [];

	readonly run: SourceCommandRunner = (command, arguments_) => {
		this.invocations.push({ command, arguments_ });
		const result = this.results[this.invocations.length - 1];

		if (result === undefined) {
			return Promise.reject(
				new Error(`Unexpected command: ${command} ${arguments_.join(' ')}`)
			);
		}

		return Promise.resolve(result);
	};

	constructor(private readonly results: readonly CommandResult[]) {}
}

const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix));

	directories.push(directory);

	return directory;
}

async function completeCupboardOutput(): Promise<string> {
	const output = await temporaryDirectory('cupboard-source-output-');
	const binaryPath = path.join(output, 'bin', 'cupboard');
	const helperPath = path.join(
		output,
		'libexec',
		'cupboard',
		'cupboard-hook-relay'
	);

	await mkdir(path.dirname(binaryPath), { recursive: true });
	await mkdir(path.dirname(helperPath), { recursive: true });
	await writeFile(binaryPath, '#!/bin/sh\n');
	await writeFile(helperPath, '#!/bin/sh\n');
	await chmod(binaryPath, 0o755);
	await chmod(helperPath, 0o755);

	return output;
}

function successfulResults(output: string): readonly CommandResult[] {
	return [
		{ stdout: 'https://github.com/underwhelmingperformance/cupboard.git\n' },
		{ stdout: `${sourceCommit}\n` },
		{ stdout: '' },
		{ stdout: `${output}\n` },
		{ stdout: `${sourceCommit.slice(0, 7)}\n` }
	];
}

afterEach(async () => {
	const directoriesToRemove = [...directories];

	directories.length = 0;
	await Promise.all(
		directoriesToRemove.map((directory) =>
			rm(directory, {
				recursive: true,
				force: true
			})
		)
	);
});

describe('acquireSourceCupboard', () => {
	it('builds the checked-out source and returns its complete Nix installation', async () => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const output = await completeCupboardOutput();
		const commands = new RecordingCommandRunner(successfulResults(output));

		await expect(
			acquireSourceCupboard(
				{ checkoutDirectory, cupboard },
				{ runCommand: commands.run }
			)
		).resolves.toStrictEqual({
			binaryPath: path.join(output, 'bin', 'cupboard'),
			cupboard
		});
		expect(commands.invocations).toStrictEqual([
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'remote', 'get-url', 'origin']
			},
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'rev-parse', 'HEAD']
			},
			{
				command: 'git',
				arguments_: [
					'-C',
					checkoutDirectory,
					'status',
					'--porcelain',
					'--untracked-files=no'
				]
			},
			{
				command: 'nix',
				arguments_: [
					'build',
					'--no-link',
					'--print-out-paths',
					`${checkoutDirectory}#cupboard`
				]
			},
			{
				command: path.join(output, 'bin', 'cupboard'),
				arguments_: ['--version']
			}
		]);
	});

	it.each([
		'https://github.com/underwhelmingperformance/cupboard',
		'git@github.com:underwhelmingperformance/cupboard.git',
		'ssh://git@github.com/underwhelmingperformance/cupboard.git'
	])('accepts a checkout remote expressed as %s', async (remote) => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const output = await completeCupboardOutput();
		const commands = new RecordingCommandRunner([
			{ stdout: `${remote}\n` },
			...successfulResults(output).slice(1)
		]);

		await expect(
			acquireSourceCupboard(
				{ checkoutDirectory, cupboard },
				{ runCommand: commands.run }
			)
		).resolves.toStrictEqual({
			binaryPath: path.join(output, 'bin', 'cupboard'),
			cupboard
		});
	});

	it('rejects a checkout from another repository before inspecting or building it', async () => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const commands = new RecordingCommandRunner([
			{ stdout: 'https://github.com/someone-else/cupboard.git\n' }
		]);

		const outcome = acquireSourceCupboard(
			{ checkoutDirectory, cupboard },
			{ runCommand: commands.run }
		);

		await expect(outcome).rejects.toBeInstanceOf(
			SourceCheckoutRepositoryMismatchError
		);
		expect(commands.invocations).toStrictEqual([
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'remote', 'get-url', 'origin']
			}
		]);
	});

	it('rejects a checkout at another commit before checking cleanliness or building', async () => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const commands = new RecordingCommandRunner([
			{ stdout: 'https://github.com/underwhelmingperformance/cupboard.git\n' },
			{ stdout: `${'f'.repeat(40)}\n` }
		]);

		const outcome = acquireSourceCupboard(
			{ checkoutDirectory, cupboard },
			{ runCommand: commands.run }
		);

		await expect(outcome).rejects.toBeInstanceOf(
			SourceCheckoutCommitMismatchError
		);
		expect(commands.invocations).toStrictEqual([
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'remote', 'get-url', 'origin']
			},
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'rev-parse', 'HEAD']
			}
		]);
	});

	it('rejects tracked checkout changes before building', async () => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const commands = new RecordingCommandRunner([
			...successfulResults('/unused').slice(0, 2),
			{ stdout: ' M actions/src/source-install.ts\n' }
		]);

		const outcome = acquireSourceCupboard(
			{ checkoutDirectory, cupboard },
			{ runCommand: commands.run }
		);

		await expect(outcome).rejects.toBeInstanceOf(SourceCheckoutDirtyError);
		expect(commands.invocations).toStrictEqual([
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'remote', 'get-url', 'origin']
			},
			{
				command: 'git',
				arguments_: ['-C', checkoutDirectory, 'rev-parse', 'HEAD']
			},
			{
				command: 'git',
				arguments_: [
					'-C',
					checkoutDirectory,
					'status',
					'--porcelain',
					'--untracked-files=no'
				]
			}
		]);
	});

	it.each([
		['no outputs', '\n'],
		['multiple outputs', '/nix/store/one\n/nix/store/two\n']
	])('rejects %s from nix build', async (_description, stdout) => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const commands = new RecordingCommandRunner([
			...successfulResults('/unused').slice(0, 3),
			{ stdout }
		]);

		await expect(
			acquireSourceCupboard(
				{ checkoutDirectory, cupboard },
				{ runCommand: commands.run }
			)
		).rejects.toBeInstanceOf(SourceBuildOutputError);
	});

	it.each([
		['cupboard binary', 'bin/cupboard'],
		['hook relay', 'libexec/cupboard/cupboard-hook-relay']
	])(
		'rejects a result without an executable %s',
		async (_description, missing) => {
			const checkoutDirectory = await temporaryDirectory(
				'cupboard-source-checkout-'
			);
			const output = await completeCupboardOutput();
			const missingPath = path.join(output, missing);

			await chmod(missingPath, 0o644);

			const commands = new RecordingCommandRunner(successfulResults(output));

			await expect(
				acquireSourceCupboard(
					{ checkoutDirectory, cupboard },
					{ runCommand: commands.run }
				)
			).rejects.toBeInstanceOf(SourceInstallationIncompleteError);
		}
	);

	it('rejects a source result which does not identify as the resolved commit', async () => {
		const checkoutDirectory = await temporaryDirectory(
			'cupboard-source-checkout-'
		);
		const output = await completeCupboardOutput();
		const commands = new RecordingCommandRunner([
			...successfulResults(output).slice(0, -1),
			{ stdout: 'deadbee\n' }
		]);

		const outcome = acquireSourceCupboard(
			{ checkoutDirectory, cupboard },
			{ runCommand: commands.run }
		);

		await expect(outcome).rejects.toStrictEqual(
			new SourceInstallationVersionMismatchError(
				sourceCommit.slice(0, 7),
				'deadbee'
			)
		);
	});
});
