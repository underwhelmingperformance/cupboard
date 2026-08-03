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
 * This is the only module in the fixture that runs `nix`. Evaluating a flake
 * attribute and copying a derivation closure are not operations the store
 * protocol offers, so both go through the `nix` command; everything the
 * measurement itself reads comes back over the store protocol, through this
 * repository's own daemon client.
 *
 * Three invocations make up a run:
 *
 * - `nix path-info --derivation <flake>#<attr>` resolves a target to the
 *   derivation the store plans against.
 * - `nix copy --derivation --to <diverted store>` puts those derivations
 *   within the empty store's reach. A store with no derivations cannot plan
 *   at all. A CI runner never pays for this: it evaluates into the same store
 *   it builds in.
 * - `nix daemon --stdio` serves the diverted store, and
 *   {@link NixDaemonStoreClient} speaks the worker protocol to it over the
 *   child's pipes.
 *
 * Every one of them carries `--substituters`, which replaces the substituter
 * list rather than adding to it. A developer machine may have an `ssh://`
 * substituter configured, and an availability query against it opens an ssh
 * connection per invocation; replacing the list is what makes the numbers the
 * same on any machine.
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

// execFile rejects with the child's captured output on the error itself, and
// what nix wrote is the only account of why it stopped.
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
 * A store whose logical directory is the real one but whose contents live
 * somewhere empty. The logical directory has to stay `/nix/store` (or
 * whatever this machine's is), because a store path's hash covers it: point
 * `--store` at a plain directory instead and every derivation changes, so
 * nothing substitutes and the measurement describes a store no runner has.
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
 * Prepares the diverted store's directories and answers with the location
 * every later command must name. A fresh directory per run is what makes the
 * measurement a cold one: the store starts with no realisation of anything
 * the manifest names.
 *
 * The answer is the resolved path. Nix refuses a store whose directory or any
 * parent of it is a symlink, and the usual temporary directory on macOS sits
 * under `/var`, which is one.
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
 * A planner that answers from a store holding nothing but the derivations it
 * was seeded with, so every measurement is what a runner starting cold would
 * pay.
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
		// The discovered configuration is deliberately not forwarded: a
		// SetOptions frame carrying this machine's substituters would put back
		// the very list the daemon's own arguments replaced.
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
 * The derivation `nix path-info --derivation` printed. It prints one store
 * path per line, and a target names exactly one root derivation, so the first
 * line is the answer and anything that is not a derivation path is refused.
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
