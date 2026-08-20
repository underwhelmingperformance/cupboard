import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { CodedError } from '@cupboard/shared/errors';
import { z } from 'zod';

import type { PublishTarget } from '../../actions/src/publish-plan.ts';
import {
	createProcessNixDaemonConnector,
	type DaemonCommandRunner,
	NixDaemonStoreClient,
	type NixDerivedPathString,
	type NixMissingPartition,
	spawnDaemonProcess
} from '../../packages/nix/src/index.ts';

import type { RealisationPlanner, ResolvedDerivation } from './measurement.ts';

/**
 * Only this module invokes `nix`. The store protocol cannot evaluate a flake
 * attribute or copy a derivation closure, so those operations use the CLI.
 * Measurements use this repository's daemon client over `nix daemon --stdio`.
 *
 * Three invocations make up a run:
 *
 * - `nix path-info --derivation <flake>#<attr>` resolves a target to the
 *   derivation the store plans against.
 * - `nix copy --derivation --to <diverted store>` adds those derivations to the
 *   empty store. A store without the derivations cannot plan the installables.
 *   A CI runner does not incur this cost because it evaluates and builds in the
 *   same store.
 * - `nix daemon --stdio` serves the diverted store, and
 *   {@link NixDaemonStoreClient} speaks the worker protocol to it over the
 *   child's pipes.
 *
 * Pass `--substituters` to all three commands to replace the configured list. A
 * developer machine can have an `ssh://` substituter that opens an SSH
 * connection for each availability query. Replacing the list prevents host
 * configuration from changing measurements between machines.
 */
export class NixCommandError extends CodedError {
	constructor(
		readonly command: string,
		readonly commandArguments: readonly string[],
		override readonly cause: unknown
	) {
		super(
			`${command} ${commandArguments.join(' ')} failed\n${reportedOutput(cause)}`
		);
		this.name = 'NixCommandError';
	}
}

// execFile includes captured child output on its rejection. Report stderr
// because it explains why nix failed.
const commandOutputSchema = z.looseObject({ stderr: z.string().optional() });

function reportedOutput(cause: unknown): string {
	const parsed = commandOutputSchema.safeParse(cause);

	return parsed.success ? (parsed.data.stderr ?? '') : '';
}

export class DerivationNotResolvedError extends CodedError {
	constructor(
		readonly attribute: string,
		readonly output: string
	) {
		super(`nix reported no derivation for ${attribute}: ${output}`);
		this.name = 'DerivationNotResolvedError';
	}
}

export type CommandRunner = (
	command: string,
	commandArguments: readonly string[]
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

const defaultCommandRunner: CommandRunner = (command, commandArguments) =>
	execFileAsync(command, [...commandArguments], {
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024
	});

// The fixture drives `nix` through its flake and store URI interfaces, so it
// asks for those features explicitly rather than depending on how the host
// happens to be configured. Extending the set leaves whatever else the host
// enables in place.
const requiredFeatures = [
	'--extra-experimental-features',
	'nix-command flakes'
];

/**
 * A diverted store whose logical store directory matches the host but whose
 * files live in an empty directory. The logical directory participates in
 * store-path hashes and must remain unchanged. Using the temporary directory
 * as `--store` would change every derivation and prevent substitution, so the
 * measurements would not represent a runner.
 */
export function divertedStoreUri(options: {
	readonly storeDirectory: StoreDirectory;
	readonly directory: string;
}): string {
	const parameters = new URLSearchParams({
		store: options.storeDirectory,
		real: path.join(options.directory, 'store'),
		state: path.join(options.directory, 'state')
	});

	return `local?${parameters.toString()}`;
}

export function derivationArguments(options: {
	readonly flake: string;
	readonly attr: string;
	readonly substituters: readonly string[];
}): readonly string[] {
	return [
		'path-info',
		...requiredFeatures,
		'--substituters',
		options.substituters.join(' '),
		'--derivation',
		`${options.flake}#${options.attr}`
	];
}

export function seedArguments(options: {
	readonly storeUri: string;
	readonly drvPaths: readonly StorePathString[];
	readonly substituters: readonly string[];
}): readonly string[] {
	return [
		'copy',
		...requiredFeatures,
		'--substituters',
		options.substituters.join(' '),
		'--derivation',
		'--no-check-sigs',
		'--to',
		options.storeUri,
		...options.drvPaths
	];
}

export function daemonArguments(options: {
	readonly storeUri: string;
	readonly substituters: readonly string[];
}): readonly string[] {
	return [
		'daemon',
		...requiredFeatures,
		'--stdio',
		'--store',
		options.storeUri,
		'--substituters',
		options.substituters.join(' ')
	];
}

export interface DivertedStoreOptions {
	readonly flake: string;
	readonly storeDirectory: StoreDirectory;
	readonly directory: string;
	readonly substituters: readonly string[];
	readonly nixCommand?: string;
	readonly run?: CommandRunner;
	readonly spawnDaemon?: DaemonCommandRunner;
	readonly now?: () => number;
}

/**
 * Creates the diverted store directories and returns their resolved parent
 * path. Each run uses a fresh directory, so no manifest target is already
 * realised.
 *
 * Resolve the path because Nix rejects a store below a symlink. On macOS, the
 * normal temporary directory is reached through `/var`, which is a symlink.
 */
export async function createDivertedStoreDirectory(
	directory: string
): Promise<string> {
	const resolved = await realpath(await mkdirIfNeeded(directory));

	await mkdir(path.join(resolved, 'store'), { recursive: true });
	await mkdir(path.join(resolved, 'state'), { recursive: true });

	return resolved;
}

async function mkdirIfNeeded(directory: string): Promise<string> {
	await mkdir(directory, { recursive: true });

	return directory;
}

/**
 * Removes a diverted store. Nix makes everything it writes read-only, and a
 * read-only directory cannot have its entries unlinked, so every entry is
 * made writable on the way out.
 */
export async function removeDivertedStore(directory: string): Promise<void> {
	await makeWritable(directory);
	await rm(directory, { recursive: true, force: true });
}

async function makeWritable(directory: string): Promise<void> {
	await chmod(directory, 0o755);

	const entries = await readdir(directory, {
		recursive: true,
		withFileTypes: true
	});

	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			continue;
		}

		await chmod(
			path.join(entry.parentPath, entry.name),
			entry.isDirectory() ? 0o755 : 0o644
		);
	}
}

/**
 * Creates a planner backed by a store containing only the seeded derivations.
 * The resulting measurements model a cold runner.
 */
export function createDivertedStorePlanner(
	options: DivertedStoreOptions
): RealisationPlanner {
	const run = options.run ?? defaultCommandRunner;
	const nixCommand = options.nixCommand ?? 'nix';
	const now = options.now ?? (() => performance.now());
	const storeUri = divertedStoreUri(options);
	const store = new NixDaemonStoreClient({
		connect: createProcessNixDaemonConnector(
			nixCommand,
			daemonArguments({ storeUri, substituters: options.substituters }),
			options.spawnDaemon ?? spawnDaemonProcess
		),
		// Do not forward the discovered configuration. A SetOptions frame with
		// this machine's substituters would restore the list that the daemon
		// arguments replaced.
		setOptions: {},
		overrides: {}
	});

	return {
		async resolve(target: PublishTarget): Promise<ResolvedDerivation> {
			if (target.rootDrvPath !== undefined) {
				return { drvPath: target.rootDrvPath, evaluationTimeMs: 0 };
			}

			const commandArguments = derivationArguments({
				flake: options.flake,
				attr: target.attr,
				substituters: options.substituters
			});
			const started = now();
			const { stdout } = await runNix(run, nixCommand, commandArguments);

			return {
				drvPath: parseDerivationPath(target.attr, stdout),
				evaluationTimeMs: Math.round(now() - started)
			};
		},

		async seed(drvPaths: readonly StorePathString[]): Promise<void> {
			if (drvPaths.length === 0) {
				return;
			}

			await runNix(
				run,
				nixCommand,
				seedArguments({
					storeUri,
					drvPaths,
					substituters: options.substituters
				})
			);
		},

		plan(
			installables: readonly NixDerivedPathString[]
		): Promise<NixMissingPartition> {
			return store.queryMissing(installables);
		}
	};
}

async function runNix(
	run: CommandRunner,
	command: string,
	commandArguments: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
	try {
		return await run(command, commandArguments);
	} catch (error) {
		throw new NixCommandError(command, commandArguments, error);
	}
}

/**
 * Returns the first non-empty derivation path printed by
 * `nix path-info --derivation`. Rejects output whose first path is missing,
 * malformed, or not a `.drv` path.
 */
export function parseDerivationPath(
	attribute: string,
	stdout: string
): StorePathString {
	const first = stdout
		.split('\n')
		.map((line) => line.trim())
		.find((line) => line !== '');

	if (!first?.endsWith('.drv')) {
		throw new DerivationNotResolvedError(attribute, stdout.trim());
	}

	const parsed = storePathSchema.safeParse(first);

	if (!parsed.success) {
		throw new DerivationNotResolvedError(attribute, stdout.trim());
	}

	return parsed.data;
}
