import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	type StoreDirectory,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { bestEffort } from '@cupboard/shared/cleanup';
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

const requiredFeatures = [
	'--extra-experimental-features',
	'nix-command flakes'
];

/**
 * A diverted store whose logical store directory matches the host but whose
 * files live in a separate directory. The logical directory participates in
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

export interface DivertedStoreDirectory {
	readonly directory: string;
	readonly workDirectory: string;
	readonly directoryIdentity: string;
	readonly ownershipToken: string;
}

type DivertedStoreDirectoryInitialiser = (
	owned: DivertedStoreDirectory
) => Promise<void>;
type DivertedStoreDirectoryResolver = (directory: string) => Promise<string>;
type DivertedStoreDirectoryHook = (directory: string) => Promise<void>;

const noDivertedStoreDirectoryHook: DivertedStoreDirectoryHook = () =>
	Promise.resolve();

const ownershipFile = '.cupboard-diverted-store';

/**
 * Creates a fresh work directory and puts the diverted store in an
 * unpredictable child. Cleanup recursively removes only that private child.
 * It removes the work directory with `rmdir` after the child is gone. Another
 * process running as the same user must not change the private child while
 * cleanup traverses it.
 *
 * Resolve the path because Nix rejects a store below a symlink. On macOS, the
 * normal temporary directory is reached through `/var`, which is a symlink.
 */
export async function createDivertedStoreDirectory(
	directory?: string,
	initialise: DivertedStoreDirectoryInitialiser = initialiseDivertedStoreDirectory,
	resolve: DivertedStoreDirectoryResolver = realpath,
	beforeOwnershipMarker: DivertedStoreDirectoryHook = noDivertedStoreDirectoryHook,
	afterWorkDirectoryCreation: DivertedStoreDirectoryHook = noDivertedStoreDirectoryHook
): Promise<DivertedStoreDirectory> {
	const workDirectory =
		directory === undefined
			? await mkdtemp(path.join(tmpdir(), 'cupboard-realisation-'))
			: await createExplicitDirectory(directory);
	let privateDirectory: string | undefined;
	let directoryIdentity: string | undefined;
	let owned: DivertedStoreDirectory | undefined;

	try {
		await afterWorkDirectoryCreation(workDirectory);
		privateDirectory = await mkdtemp(
			path.join(workDirectory, '.cupboard-store-')
		);
		directoryIdentity = await readDirectoryIdentity(privateDirectory);
		const resolvedDirectory = await resolve(privateDirectory);
		await verifyDirectoryIdentity(resolvedDirectory, directoryIdentity);
		await beforeOwnershipMarker(resolvedDirectory);
		await verifyDirectoryIdentity(resolvedDirectory, directoryIdentity);
		const ownershipToken = randomUUID();
		await writeOwnershipMarker(resolvedDirectory, ownershipToken);
		await verifyDirectoryIdentity(resolvedDirectory, directoryIdentity);
		await verifyOwnershipMarker(resolvedDirectory, ownershipToken);
		owned = {
			directory: resolvedDirectory,
			workDirectory,
			directoryIdentity,
			ownershipToken
		};
		await initialise(owned);
		await verifyDirectoryIdentity(resolvedDirectory, directoryIdentity);
		await verifyOwnershipMarker(resolvedDirectory, ownershipToken);

		return owned;
	} catch (error) {
		if (privateDirectory !== undefined && directoryIdentity !== undefined) {
			await removeFailedDivertedStoreDirectory(
				privateDirectory,
				directoryIdentity,
				owned
			);
		}
		await bestEffort(() => rmdir(workDirectory));

		throw error;
	}
}

async function readDirectoryIdentity(directory: string): Promise<string> {
	const metadata = await lstat(directory, { bigint: true });

	if (!metadata.isDirectory()) {
		throw new Error('Refusing a replaced diverted-store directory');
	}

	return `${String(metadata.dev)}:${String(metadata.ino)}`;
}

async function verifyDirectoryIdentity(
	directory: string,
	expectedIdentity: string
): Promise<void> {
	let actualIdentity: string;

	try {
		actualIdentity = await readDirectoryIdentity(directory);
	} catch (error) {
		throw new Error('Refusing a replaced diverted-store directory', {
			cause: error
		});
	}

	if (actualIdentity !== expectedIdentity) {
		throw new Error('Refusing a replaced diverted-store directory');
	}
}

async function writeOwnershipMarker(
	directory: string,
	ownershipToken: string
): Promise<void> {
	await writeFile(path.join(directory, ownershipFile), ownershipToken, {
		encoding: 'utf8',
		flag: 'wx',
		mode: 0o600
	});
}

async function verifyOwnershipMarker(
	directory: string,
	ownershipToken: string
): Promise<void> {
	let recordedToken: string;

	try {
		recordedToken = await readFile(path.join(directory, ownershipFile), 'utf8');
	} catch (error) {
		throw new Error('Refusing a replaced diverted-store directory', {
			cause: error
		});
	}

	if (recordedToken !== ownershipToken) {
		throw new Error('Refusing a replaced diverted-store directory');
	}
}

async function initialiseDivertedStoreDirectory(
	owned: DivertedStoreDirectory
): Promise<void> {
	await mkdir(path.join(owned.directory, 'store'), { recursive: true });
	await mkdir(path.join(owned.directory, 'state'), { recursive: true });
}

async function removeFailedDivertedStoreDirectory(
	created: string,
	directoryIdentity: string,
	owned: DivertedStoreDirectory | undefined
): Promise<void> {
	if (owned !== undefined) {
		await bestEffort(() => removeDivertedStore(owned));
		return;
	}

	await bestEffort(async () => {
		const claimed = await claimDivertedStoreDirectory(
			created,
			directoryIdentity
		);

		try {
			await rm(claimed.directory, { recursive: true, force: true });
		} finally {
			await bestEffort(() => rmdir(claimed.holdingDirectory));
		}
	});
}

async function createExplicitDirectory(directory: string): Promise<string> {
	await mkdir(directory);

	return directory;
}

/**
 * Removes a diverted store. Nix makes everything it writes read-only, and a
 * read-only directory cannot have its entries unlinked, so every entry is
 * made writable on the way out.
 */
export async function removeDivertedStore(
	owned: DivertedStoreDirectory,
	beforeRemoval: DivertedStoreDirectoryHook = noDivertedStoreDirectoryHook,
	afterRemovalClaim: DivertedStoreDirectoryHook = noDivertedStoreDirectoryHook,
	afterCleanupVerification: DivertedStoreDirectoryHook = noDivertedStoreDirectoryHook
): Promise<void> {
	await beforeRemoval(owned.directory);
	const claimed = await claimDivertedStoreDirectory(
		owned.directory,
		owned.directoryIdentity,
		owned.ownershipToken,
		afterRemovalClaim
	);

	try {
		await afterCleanupVerification(claimed.directory);
		await makeWritable(claimed.directory);
		await rm(claimed.directory, { recursive: true, force: true });
	} catch (error) {
		throw directoryRecoveryError(claimed.directory, error);
	} finally {
		await bestEffort(() => rmdir(claimed.holdingDirectory));
	}

	await rmdir(owned.workDirectory);
}

interface ClaimedDivertedStoreDirectory {
	readonly directory: string;
	readonly holdingDirectory: string;
}

async function claimDivertedStoreDirectory(
	directory: string,
	expectedIdentity: string,
	ownershipToken?: string,
	afterClaim: DivertedStoreDirectoryHook = noDivertedStoreDirectoryHook
): Promise<ClaimedDivertedStoreDirectory> {
	const holdingDirectory = await mkdtemp(
		path.join(path.dirname(directory), '.cupboard-cleanup-')
	);
	const claimedDirectory = path.join(holdingDirectory, 'store');
	let isMoved = false;

	try {
		await rename(directory, claimedDirectory);
		isMoved = true;
		await afterClaim(directory);
		await verifyDirectoryIdentity(claimedDirectory, expectedIdentity);

		if (ownershipToken !== undefined) {
			try {
				await verifyOwnershipMarker(claimedDirectory, ownershipToken);
			} catch (error) {
				throw new Error(`Refusing to remove unowned directory: ${directory}`, {
					cause: error
				});
			}
		}

		return {
			directory: claimedDirectory,
			holdingDirectory
		};
	} catch (error) {
		if (!isMoved) {
			await bestEffort(() => rmdir(holdingDirectory));
			throw error;
		}

		throw directoryRecoveryError(claimedDirectory, error);
	}
}

function directoryRecoveryError(
	recoveryPath: string,
	primaryError: unknown
): Error {
	const primaryMessage = reportedError(primaryError);
	const sentence = primaryMessage.endsWith('.')
		? primaryMessage
		: `${primaryMessage}.`;

	return new Error(
		`${sentence} The claimed entry remains at ` +
			`${recoveryPath}; inspect it before moving or removing it.`,
		{ cause: primaryError }
	);
}

function reportedError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
 * Evaluates targets and copies their derivations with the Nix CLI, then plans
 * through a daemon that serves the diverted store. Every Nix process receives
 * the selected substituters so host configuration does not change the result.
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
