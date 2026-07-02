import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import { Command } from 'commander';
import { z } from 'zod';

/**
 * The flake's pnpm store hash is a fixed-output hash, so Nix only notices a
 * stale one by fetching the whole store. To catch drift without a fetch, the
 * hash lives in `pnpm-deps-hash.json` next to a digest of the `pnpm-lock.yaml`
 * it was resolved from: comparing that digest against the current lockfile is
 * instant and needs no network. `check` does the comparison; `update`
 * refetches the store and refreshes the pair.
 */
export const hashesFileName = 'pnpm-deps-hash.json';

const sriSha256Hash = z.string().regex(/^sha256-[\d+/A-Za-z]{43}=$/);

const dependenciesHashesSchema = z.object({
	lockfile: sriSha256Hash,
	store: sriSha256Hash
});

export type DependenciesHashes = z.infer<typeof dependenciesHashesSchema>;

/** Reads and writes the files the hash pair is derived from and stored in. */
export interface Workspace {
	readLockfile(): Uint8Array;
	readHashesFile(): string;
	writeHashesFile(text: string): void;
}

/** Resolves the store hash for the workspace's current lockfile. */
export interface StoreFetcher {
	/**
	 * Fetch the store against the recorded hash, returning the corrected hash
	 * when the recorded one no longer matches, and undefined when it still
	 * does.
	 */
	resolveHash(): string | undefined;
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
			`${hashesFileName} was resolved from a pnpm-lock.yaml digesting to\n` +
				`${recorded}, but the lockfile now digests to\n` +
				`${actual}.\n` +
				'The flake would fetch a pnpm store that no longer matches the ' +
				'lockfile. Run `pnpm update:flake-deps` to refresh it.'
		);
		this.name = 'LockfileDriftError';
	}
}

export class StoreFetchFailedError extends CodedError {
	constructor(public readonly output: string) {
		super(`fetching the pnpm store failed:\n${output}`);
		this.name = 'StoreFetchFailedError';
	}
}

export class UnstableStoreHashError extends CodedError {
	constructor() {
		super('the pnpm store hash changed between two consecutive fetches');
		this.name = 'UnstableStoreHashError';
	}
}

export class FakeHashMatchedError extends CodedError {
	constructor() {
		super('the fetch succeeded against the fake hash, which cannot happen');
		this.name = 'FakeHashMatchedError';
	}
}

/** Digest file bytes in the SRI form Nix uses for `sha256` hashes. */
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

	if (hashes.lockfile !== digest) {
		throw new LockfileDriftError(hashes.lockfile, digest);
	}
}

export type UpdateOutcome =
	| { kind: 'already-current'; store: string }
	| { kind: 'store-unchanged'; store: string }
	| { kind: 'store-updated'; store: string };

/** A hash no fetch can produce, forcing Nix to report the real one. */
export const fakeStoreHash = `sha256-${'A'.repeat(43)}=`;

// The fetch runs against the fake hash: building against the recorded hash
// would be satisfied by a store output already realised for it, masking a
// stale hash on any machine that has fetched before.
export function updateFlakeDependencies(
	workspace: Workspace,
	fetcher: StoreFetcher
): UpdateOutcome {
	const digest = sriSha256(workspace.readLockfile());
	const current = parseDependenciesHashes(workspace.readHashesFile());

	if (current.lockfile === digest) {
		return { kind: 'already-current', store: current.store };
	}

	workspace.writeHashesFile(
		serialiseDependenciesHashes({ lockfile: digest, store: fakeStoreHash })
	);

	const resolved = fetcher.resolveHash();

	if (resolved === undefined) {
		throw new FakeHashMatchedError();
	}

	workspace.writeHashesFile(
		serialiseDependenciesHashes({ lockfile: digest, store: resolved })
	);

	if (fetcher.resolveHash() !== undefined) {
		throw new UnstableStoreHashError();
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

// Builds the store with the recorded hash; Nix reports the real hash in its
// mismatch error, which is the supported way to resolve a fixed-output hash.
function nixStoreFetcher(root: string): StoreFetcher {
	return {
		resolveHash: () => {
			const build = spawnSync(
				'nix',
				['build', '.#cupboard.pnpmDeps', '--no-link'],
				{ cwd: root, encoding: 'utf8' }
			);

			if (build.error !== undefined) {
				throw new StoreFetchFailedError(String(build.error));
			}

			if (build.status === 0) {
				return;
			}

			const mismatch = /got: {4}(?<hash>sha256-[\d+/A-Za-z]{43}=)/.exec(
				build.stderr
			);

			if (mismatch?.groups?.hash === undefined) {
				throw new StoreFetchFailedError(build.stderr);
			}

			return mismatch.groups.hash;
		}
	};
}

const updateMessages: Record<UpdateOutcome['kind'], (store: string) => string> =
	{
		'already-current': () =>
			`${hashesFileName} already matches pnpm-lock.yaml.`,
		'store-unchanged': () =>
			'The pnpm store is unchanged; recorded the new lockfile digest.',
		'store-updated': (store) => `Recorded the new pnpm store hash ${store}.`
	};

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
			console.log('The flake pnpm store hash matches pnpm-lock.yaml.');
		});

	program
		.command('update')
		.description(
			`refetch the pnpm store and record its hash in ${hashesFileName}`
		)
		.action(() => {
			const outcome = updateFlakeDependencies(
				repositoryWorkspace(repoRoot),
				nixStoreFetcher(repoRoot)
			);

			console.log(updateMessages[outcome.kind](outcome.store));
		});

	return program;
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		buildProgram().parse();
	} catch (error: unknown) {
		if (error instanceof CodedError) {
			console.error(error.message);
			process.exitCode = error.exitCode;
		} else {
			console.error(error);
			process.exitCode = genericExitCode;
		}
	}
}
