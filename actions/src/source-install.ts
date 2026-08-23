import { spawn } from 'node:child_process';
import { access, constants, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { CodedError } from '@cupboard/shared/errors';

import {
	observeChildProcess,
	waitForAbortableChildProcess
} from './child-process.ts';
import type { ResolvedCupboard } from './cupboard-resolution.ts';
import { CommandFailedError } from './errors.ts';
import { parseLines } from './inputs.ts';

export type ResolvedSourceCupboard = Extract<
	ResolvedCupboard,
	{ readonly kind: 'source' }
>;

export interface AcquiredSourceCupboard {
	readonly binaryPath: string;
	readonly cupboard: ResolvedSourceCupboard;
}

export interface AcquireSourceCupboardOptions {
	readonly checkoutDirectory: string;
	readonly installDirectory: string;
	readonly cupboard: ResolvedSourceCupboard;
	readonly signal?: AbortSignal;
}

export type SourceCommandRunner = (
	command: string,
	arguments_: readonly string[],
	signal?: AbortSignal
) => Promise<{ readonly stdout: string }>;

export interface SourceInstallDependencies {
	readonly runCommand?: SourceCommandRunner;
	readonly isExecutableFile?: (candidate: string) => Promise<boolean>;
	readonly createRootDirectory?: (installDirectory: string) => Promise<string>;
	readonly removeRootDirectory?: (rootDirectory: string) => Promise<void>;
}

export class SourceCheckoutRepositoryMismatchError extends CodedError {
	constructor(
		public readonly expectedRepository: string,
		public readonly remote: string
	) {
		super(
			`source checkout remote '${remote}' is not for repository ${expectedRepository}`
		);
		this.name = 'SourceCheckoutRepositoryMismatchError';
	}
}

export class SourceCheckoutCommitMismatchError extends CodedError {
	constructor(
		public readonly expectedCommit: string,
		public readonly actualCommit: string
	) {
		super(
			`source checkout is at ${actualCommit}, but ${expectedCommit} was resolved`
		);
		this.name = 'SourceCheckoutCommitMismatchError';
	}
}

export class SourceCheckoutDirtyError extends CodedError {
	constructor(public readonly changes: readonly string[]) {
		super(`source checkout has tracked changes: ${changes.join(', ')}`);
		this.name = 'SourceCheckoutDirtyError';
	}
}

export class SourceBuildOutputError extends CodedError {
	constructor(public readonly outputs: readonly string[]) {
		super(
			`nix build returned ${String(outputs.length)} Cupboard outputs; expected exactly one`
		);
		this.name = 'SourceBuildOutputError';
	}
}

export class SourceInstallationIncompleteError extends CodedError {
	constructor(public readonly path: string) {
		super(`source-built Cupboard is missing executable file ${path}`);
		this.name = 'SourceInstallationIncompleteError';
	}
}

export class SourceInstallationVersionMismatchError extends CodedError {
	constructor(
		public readonly expected: string,
		public readonly actual: string
	) {
		super(
			`source-built Cupboard reported version '${actual}'; expected '${expected}'`
		);
		this.name = 'SourceInstallationVersionMismatchError';
	}
}

const maximumCapturedOutputBytes = 16 * 1024 * 1024;

async function createRootDirectory(installDirectory: string): Promise<string> {
	await mkdir(installDirectory, { recursive: true });

	return mkdtemp(path.join(installDirectory, '.cupboard-source-'));
}

async function removeRootDirectory(rootDirectory: string): Promise<void> {
	await rm(rootDirectory, { recursive: true, force: true });
}

const defaultSourceCommandRunner: SourceCommandRunner = async (
	command,
	arguments_,
	signal
) => {
	signal?.throwIfAborted();

	const child = spawn(command, [...arguments_], {
		stdio: ['ignore', 'pipe', 'inherit']
	});
	const outputLimit = new AbortController();
	const lifecycleSignal =
		signal === undefined
			? outputLimit.signal
			: AbortSignal.any([signal, outputLimit.signal]);
	const chunks: Buffer[] = [];
	let capturedBytes = 0;

	child.stdout.on('data', (chunk: Buffer) => {
		capturedBytes += chunk.byteLength;

		if (capturedBytes > maximumCapturedOutputBytes) {
			outputLimit.abort(
				new Error(
					`${command} stdout exceeded ${String(maximumCapturedOutputBytes)} bytes`
				)
			);
			return;
		}

		chunks.push(chunk);
	});

	const result = await waitForAbortableChildProcess(
		observeChildProcess(child),
		lifecycleSignal
	);

	if (result.error !== undefined || result.status !== 0) {
		throw new CommandFailedError(
			command,
			result.status,
			result.error?.message,
			{
				...(result.error !== undefined && { cause: result.error }),
				...(result.signal !== undefined && { signal: result.signal })
			}
		);
	}

	return { stdout: Buffer.concat(chunks).toString('utf8') };
};

async function isExecutableFile(candidate: string): Promise<boolean> {
	try {
		const metadata = await stat(candidate);

		if (!metadata.isFile()) {
			return false;
		}

		await access(candidate, constants.X_OK);

		return true;
	} catch {
		return false;
	}
}

function stripGitSuffix(repository: string): string {
	return repository.replace(/\.git$/u, '');
}

function repositoryFromRemote(remote: string): string | undefined {
	const trimmed = remote.trim().replace(/\/$/u, '');
	const scpRemote = /^(?:[^@/]+@)?[^:/]+:(?<repository>[^/]+\/[^/]+)$/u.exec(
		trimmed
	);

	if (scpRemote?.groups?.repository !== undefined) {
		return stripGitSuffix(scpRemote.groups.repository);
	}

	let parsed: URL;

	try {
		parsed = new URL(trimmed);
	} catch {
		return undefined;
	}

	if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) {
		return undefined;
	}

	const segments = parsed.pathname
		.split('/')
		.filter((segment) => segment.length > 0);

	if (segments.length < 2) {
		return undefined;
	}

	return stripGitSuffix(segments.slice(-2).join('/'));
}

async function assertCheckout(
	options: AcquireSourceCupboardOptions,
	runCommand: SourceCommandRunner
): Promise<void> {
	const gitPrefix = ['-C', options.checkoutDirectory];
	const remoteResult = await runCommand(
		'git',
		[...gitPrefix, 'remote', 'get-url', 'origin'],
		options.signal
	);
	const remote = remoteResult.stdout.trim();
	const actualRepository = repositoryFromRemote(remote);

	if (
		actualRepository?.toLowerCase() !==
		options.cupboard.repository.toLowerCase()
	) {
		throw new SourceCheckoutRepositoryMismatchError(
			options.cupboard.repository,
			remote
		);
	}

	const commitResult = await runCommand(
		'git',
		[...gitPrefix, 'rev-parse', 'HEAD'],
		options.signal
	);
	const actualCommit = commitResult.stdout.trim().toLowerCase();

	if (actualCommit !== options.cupboard.sourceCommit) {
		throw new SourceCheckoutCommitMismatchError(
			options.cupboard.sourceCommit,
			actualCommit
		);
	}

	const statusResult = await runCommand(
		'git',
		[...gitPrefix, 'status', '--porcelain', '--untracked-files=no'],
		options.signal
	);
	const changes = parseLines(statusResult.stdout);

	if (changes.length > 0) {
		throw new SourceCheckoutDirtyError(changes);
	}
}

/**
 * Verify the checkout's repository and commit, and reject tracked changes,
 * before Nix reads the source. The build must return one output containing the
 * CLI and its hook relay, and the CLI version must match the resolved commit.
 *
 * Keep the successful out-link as a GC root. If validation fails after the
 * root is created, remove only the directory created for this acquisition.
 */
export async function acquireSourceCupboard(
	options: AcquireSourceCupboardOptions,
	dependencies: SourceInstallDependencies = {}
): Promise<AcquiredSourceCupboard> {
	const runCommand = dependencies.runCommand ?? defaultSourceCommandRunner;
	const inspectExecutable = dependencies.isExecutableFile ?? isExecutableFile;
	const createRoot = dependencies.createRootDirectory ?? createRootDirectory;
	const removeRoot = dependencies.removeRootDirectory ?? removeRootDirectory;
	const checkoutDirectory = path.resolve(options.checkoutDirectory);
	const installDirectory = path.resolve(options.installDirectory);
	const resolvedOptions = { ...options, checkoutDirectory };

	await assertCheckout(resolvedOptions, runCommand);

	const rootDirectory = await createRoot(installDirectory);
	let isAcquired = false;

	try {
		const buildResult = await runCommand(
			'nix',
			[
				'build',
				'--out-link',
				path.join(rootDirectory, 'result'),
				'--print-out-paths',
				`${checkoutDirectory}#cupboard`
			],
			options.signal
		);
		const outputs = parseLines(buildResult.stdout);
		const [output] = outputs;

		if (
			output === undefined ||
			outputs.length !== 1 ||
			!path.isAbsolute(output)
		) {
			throw new SourceBuildOutputError(outputs);
		}

		const binaryPath = path.join(output, 'bin', 'cupboard');
		const requiredExecutables = [
			binaryPath,
			path.join(output, 'libexec', 'cupboard', 'cupboard-hook-relay')
		];

		for (const executable of requiredExecutables) {
			if (!(await inspectExecutable(executable))) {
				throw new SourceInstallationIncompleteError(executable);
			}
		}

		const expectedVersion = options.cupboard.sourceCommit.slice(0, 7);
		const versionResult = await runCommand(
			binaryPath,
			['--version'],
			options.signal
		);
		const actualVersion = versionResult.stdout.trim();

		if (actualVersion !== expectedVersion) {
			throw new SourceInstallationVersionMismatchError(
				expectedVersion,
				actualVersion
			);
		}

		isAcquired = true;

		return { binaryPath, cupboard: options.cupboard };
	} finally {
		if (!isAcquired) {
			await removeRoot(rootDirectory);
		}
	}
}
