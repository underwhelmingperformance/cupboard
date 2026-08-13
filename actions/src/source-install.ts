import { execFile } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { CodedError } from '@cupboard/shared/errors';

import type { ResolvedCupboard } from './cupboard-resolution.ts';
import { parseLines } from './inputs.ts';

export type ResolvedSourceCupboard = Extract<
	ResolvedCupboard,
	{ readonly kind: 'source' }
>;

/** The Nix-built executable and the immutable source coordinate that produced it. */
export interface AcquiredSourceCupboard {
	readonly binaryPath: string;
	readonly cupboard: ResolvedSourceCupboard;
}

/** A checked-out workflow source tree to acquire as a Nix-built Cupboard. */
export interface AcquireSourceCupboardOptions {
	readonly checkoutDirectory: string;
	readonly cupboard: ResolvedSourceCupboard;
}

/** The captured command contract needed to verify and build a source checkout. */
export type SourceCommandRunner = (
	command: string,
	arguments_: readonly string[]
) => Promise<{ readonly stdout: string }>;

/** Filesystem seams used to validate the immutable Nix result. */
export interface SourceInstallDependencies {
	readonly runCommand?: SourceCommandRunner;
	readonly isExecutableFile?: (candidate: string) => Promise<boolean>;
}

export class SourceCheckoutRepositoryMismatchError extends CodedError {
	constructor(
		public readonly expectedRepository: string,
		public readonly remote: string
	) {
		super(
			`source checkout remote '${remote}' does not identify ${expectedRepository}`
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
			`source-built Cupboard should report version '${expected}', but reported '${actual}'`
		);
		this.name = 'SourceInstallationVersionMismatchError';
	}
}

const execFileAsync = promisify(execFile);

const defaultSourceCommandRunner: SourceCommandRunner = (command, arguments_) =>
	execFileAsync(command, [...arguments_], {
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024
	});

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
	const remoteResult = await runCommand('git', [
		...gitPrefix,
		'remote',
		'get-url',
		'origin'
	]);
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

	const commitResult = await runCommand('git', [
		...gitPrefix,
		'rev-parse',
		'HEAD'
	]);
	const actualCommit = commitResult.stdout.trim().toLowerCase();

	if (actualCommit !== options.cupboard.sourceCommit) {
		throw new SourceCheckoutCommitMismatchError(
			options.cupboard.sourceCommit,
			actualCommit
		);
	}

	const statusResult = await runCommand('git', [
		...gitPrefix,
		'status',
		'--porcelain',
		'--untracked-files=no'
	]);
	const changes = parseLines(statusResult.stdout);

	if (changes.length > 0) {
		throw new SourceCheckoutDirtyError(changes);
	}
}

/**
 * Build Cupboard from an already checked-out immutable workflow revision.
 * The checkout identity and tracked cleanliness are verified before Nix reads
 * it, then the result must contain both the CLI and its post-build hook relay.
 */
export async function acquireSourceCupboard(
	options: AcquireSourceCupboardOptions,
	dependencies: SourceInstallDependencies = {}
): Promise<AcquiredSourceCupboard> {
	const runCommand = dependencies.runCommand ?? defaultSourceCommandRunner;
	const inspectExecutable = dependencies.isExecutableFile ?? isExecutableFile;
	const checkoutDirectory = path.resolve(options.checkoutDirectory);
	const resolvedOptions = { ...options, checkoutDirectory };

	await assertCheckout(resolvedOptions, runCommand);

	const buildResult = await runCommand('nix', [
		'build',
		'--no-link',
		'--print-out-paths',
		`${checkoutDirectory}#cupboard`
	]);
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
	const versionResult = await runCommand(binaryPath, ['--version']);
	const actualVersion = versionResult.stdout.trim();

	if (actualVersion !== expectedVersion) {
		throw new SourceInstallationVersionMismatchError(
			expectedVersion,
			actualVersion
		);
	}

	return { binaryPath, cupboard: options.cupboard };
}
