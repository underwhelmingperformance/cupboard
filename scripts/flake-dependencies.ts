import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createCliUi, resolveReporterMode } from '@cupboard/cli-ui';
import type { Reporter } from '@cupboard/reporter';
import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import { Command } from 'commander';
import { z } from 'zod';

// The pnpm store is a fixed-output derivation, so Nix discovers a stale hash
// only after fetching the store. Record the lockfile digest beside the store
// hash so `check` can detect drift without that fetch.
export const hashesFileName = 'pnpm-deps-hash.json';

const sriSha256Hash = z.string().regex(/^sha256-[\d+/A-Za-z]{43}=$/);

const dependenciesHashesSchema = z.object({
	lockfile: sriSha256Hash,
	store: sriSha256Hash
});

export type DependenciesHashes = z.infer<typeof dependenciesHashesSchema>;

export interface Workspace {
	readLockfile(): Uint8Array;
	readHashesFile(): string;
	writeHashesFile(text: string): void;
}

export type FetchPurpose = 'resolve' | 'confirm';

export interface StoreFetcher {
	/**
	 * Fetch the store against the recorded hash, returning the corrected hash
	 * when the recorded one no longer matches, and undefined when it still
	 * does.
	 */
	resolveHash(purpose: FetchPurpose): Promise<string | undefined>;
}

export class UnparsableHashesFileError extends CodedError {
	constructor(options: { cause: unknown }) {
		super(`${hashesFileName} is not valid JSON`, options);
		this.name = 'UnparsableHashesFileError';
	}
}

export class InvalidHashesFileError extends CodedError {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super(`${hashesFileName} does not have the expected shape`);
		this.name = 'InvalidHashesFileError';
	}
}

export class LockfileDriftError extends CodedError {
	constructor(
		public readonly recorded: string,
		public readonly actual: string
	) {
		super(
			`${hashesFileName} records this pnpm-lock.yaml digest:\n` +
				`${recorded}\nThe current lockfile has this digest:\n` +
				`${actual}.\n` +
				'The flake would fetch a pnpm store that no longer matches the ' +
				'lockfile. Run `pnpm update:flake-deps` to refresh it.'
		);
		this.name = 'LockfileDriftError';
	}
}

export class FakeHashRecordedError extends CodedError {
	constructor() {
		super(
			`${hashesFileName} records the placeholder store hash left by an ` +
				'interrupted update. Run `pnpm update:flake-deps` to refresh it.'
		);
		this.name = 'FakeHashRecordedError';
	}
}

export class StoreFetchFailedError extends CodedError {
	constructor(public readonly output: string) {
		super(`fetching the pnpm store failed:\n${output}`);
		this.name = 'StoreFetchFailedError';
	}
}

export class UnstableStoreHashError extends CodedError {
	constructor(
		public readonly first: string,
		public readonly second: string
	) {
		super(
			'the pnpm store hash changed between two consecutive fetches: ' +
				`${first} and then ${second}`
		);
		this.name = 'UnstableStoreHashError';
	}
}

export class FakeHashMatchedError extends CodedError {
	constructor() {
		super(
			'Nix accepted the placeholder hash, so the store hash was not resolved'
		);
		this.name = 'FakeHashMatchedError';
	}
}

export function sriSha256(bytes: Uint8Array): string {
	return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

export function parseDependenciesHashes(text: string): DependenciesHashes {
	let parsed: unknown;

	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UnparsableHashesFileError({ cause: error });
	}

	const result = dependenciesHashesSchema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidHashesFileError(result.error.issues);
	}

	return result.data;
}

export function serialiseDependenciesHashes(
	hashes: DependenciesHashes
): string {
	return `${JSON.stringify(hashes, undefined, '\t')}\n`;
}

export function checkFlakeDependencies(workspace: Workspace): void {
	const digest = sriSha256(workspace.readLockfile());
	const hashes = parseDependenciesHashes(workspace.readHashesFile());

	if (hashes.store === fakeStoreHash) {
		throw new FakeHashRecordedError();
	}

	if (hashes.lockfile !== digest) {
		throw new LockfileDriftError(hashes.lockfile, digest);
	}
}

export type UpdateOutcome =
	| { kind: 'already-current'; store: string }
	| { kind: 'store-unchanged'; store: string }
	| { kind: 'store-updated'; store: string };

// Nix rejects this placeholder and includes the actual fixed-output hash in the
// mismatch diagnostic.
export const fakeStoreHash = `sha256-${'A'.repeat(43)}=`;

// The fetch runs against the fake hash: building against the recorded hash
// would be satisfied by a store output already realised for it, masking a
// stale hash on any machine that has fetched before.
export async function updateFlakeDependencies(
	workspace: Workspace,
	fetcher: StoreFetcher
): Promise<UpdateOutcome> {
	const digest = sriSha256(workspace.readLockfile());
	const originalText = workspace.readHashesFile();
	const current = parseDependenciesHashes(originalText);

	if (current.lockfile === digest && current.store !== fakeStoreHash) {
		return { kind: 'already-current', store: current.store };
	}

	try {
		return await refetchStoreHash(workspace, fetcher, digest, current);
	} catch (error) {
		// A failure must not leave the placeholder or an unverified hash on
		// disk: whatever ran the update may commit the file regardless.
		workspace.writeHashesFile(originalText);
		throw error;
	}
}

async function refetchStoreHash(
	workspace: Workspace,
	fetcher: StoreFetcher,
	digest: string,
	current: DependenciesHashes
): Promise<UpdateOutcome> {
	workspace.writeHashesFile(
		serialiseDependenciesHashes({ lockfile: digest, store: fakeStoreHash })
	);

	const resolved = await fetcher.resolveHash('resolve');

	if (resolved === undefined) {
		throw new FakeHashMatchedError();
	}

	workspace.writeHashesFile(
		serialiseDependenciesHashes({ lockfile: digest, store: resolved })
	);

	const confirming = await fetcher.resolveHash('confirm');

	if (confirming !== undefined) {
		throw new UnstableStoreHashError(resolved, confirming);
	}

	return {
		kind: resolved === current.store ? 'store-unchanged' : 'store-updated',
		store: resolved
	};
}

const repoRoot = path.resolve(import.meta.dirname, '..');

function repositoryWorkspace(root: string): Workspace {
	const hashesPath = path.join(root, hashesFileName);

	return {
		readLockfile: () => readFileSync(path.join(root, 'pnpm-lock.yaml')),
		readHashesFile: () => readFileSync(hashesPath, 'utf8'),
		writeHashesFile: (text) => {
			writeFileSync(hashesPath, text);
		}
	};
}

const fetchLabels: Record<FetchPurpose, string> = {
	resolve: 'Fetching the pnpm store to resolve its hash',
	confirm: 'Fetching the pnpm store again to confirm the hash'
};

// Builds the store with the recorded hash; Nix reports the real hash in its
// mismatch error, which is the supported way to resolve a fixed-output hash.
function nixStoreFetcher(root: string, reporter: Reporter): StoreFetcher {
	return {
		resolveHash: (purpose) =>
			reporter.phase(fetchLabels[purpose], async (context) => {
				const build = await runNixBuild(root);

				if (build.status === 0) {
					return;
				}

				const mismatch = /got: {4}(?<hash>sha256-[\d+/A-Za-z]{43}=)/.exec(
					build.stderr
				);

				if (mismatch?.groups?.hash === undefined) {
					throw new StoreFetchFailedError(build.stderr);
				}

				context.fact('store', mismatch.groups.hash);

				return mismatch.groups.hash;
			})
	};
}

interface NixBuildResult {
	readonly status: number | null;
	readonly stderr: string;
}

function runNixBuild(root: string): Promise<NixBuildResult> {
	return new Promise((resolve, reject) => {
		const build = spawn('nix', ['build', '.#cupboard.pnpmDeps', '--no-link'], {
			cwd: root,
			stdio: ['ignore', 'ignore', 'pipe']
		});

		let stderr = '';
		build.stderr.setEncoding('utf8');
		build.stderr.on('data', (chunk: string) => {
			stderr += chunk;
		});

		build.on('error', (error) => {
			reject(new StoreFetchFailedError(String(error)));
		});
		build.on('close', (status) => {
			resolve({ status, stderr });
		});
	});
}

const updateMessages: Record<UpdateOutcome['kind'], (store: string) => string> =
	{
		'already-current': () =>
			`${hashesFileName} already matches pnpm-lock.yaml.`,
		'store-unchanged': () =>
			'The pnpm store is unchanged; recorded the new lockfile digest.',
		'store-updated': (store) => `Recorded the new pnpm store hash ${store}.`
	};

function scriptReporter(): Reporter {
	return createCliUi({ mode: resolveReporterMode() }).reporter();
}

function buildProgram(): Command {
	const program = new Command('flake-dependencies');

	program.description(
		'Keep the flake pnpm store hash in step with pnpm-lock.yaml.'
	);

	program
		.command('check')
		.description(
			`fail when ${hashesFileName} was resolved from a different lockfile`
		)
		.action(() => {
			checkFlakeDependencies(repositoryWorkspace(repoRoot));
			scriptReporter().success(
				'The flake pnpm store hash matches pnpm-lock.yaml.'
			);
		});

	program
		.command('update')
		.description(
			`refetch the pnpm store and record its hash in ${hashesFileName}`
		)
		.action(async () => {
			const reporter = scriptReporter();
			const outcome = await updateFlakeDependencies(
				repositoryWorkspace(repoRoot),
				nixStoreFetcher(repoRoot, reporter)
			);

			const message = updateMessages[outcome.kind](outcome.store);

			if (outcome.kind === 'already-current') {
				reporter.step(message);
				return;
			}

			reporter.success(message);
		});

	return program;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		await buildProgram().parseAsync();
	} catch (error: unknown) {
		scriptReporter().error(error);
		process.exitCode =
			error instanceof CodedError ? error.exitCode : genericExitCode;
	}
}
