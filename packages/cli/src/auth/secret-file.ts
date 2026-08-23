import { randomBytes } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	readFile,
	rename,
	unlink,
	writeFile
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

import { throwIfAborted } from '../abort.ts';

/**
 * The CLI's configuration directory: under `$XDG_CONFIG_HOME` when set,
 * otherwise `~/.config`, always within a `cupboard` subdirectory.
 */
export function configDirectory(): string {
	const base =
		env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
			? env.XDG_CONFIG_HOME
			: path.join(homedir(), '.config');

	return path.join(base, 'cupboard');
}

/**
 * The CLI's cache directory: under `$XDG_CACHE_HOME` when set, otherwise
 * `~/.cache`, always within a `cupboard` subdirectory. Used for content that can
 * be re-fetched, such as conditional GitHub API responses.
 */
export function cacheDirectory(): string {
	const base =
		env.XDG_CACHE_HOME !== undefined && env.XDG_CACHE_HOME !== ''
			? env.XDG_CACHE_HOME
			: path.join(homedir(), '.cache');

	return path.join(base, 'cupboard');
}

/**
 * Reads a secret file's contents, or undefined when the file does not exist.
 * Other failures (permissions, I/O) propagate.
 */
export async function readSecretFile(
	file: string
): Promise<string | undefined> {
	try {
		return await readFile(file, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}

		throw error;
	}
}

interface SecretFileOperations {
	readonly move?: typeof rename;
	readonly remove?: typeof unlink;
	readonly write?: typeof writeFile;
}

/**
 * Persists a secret in a `0600` file inside a `0700` directory owned by the
 * current user. It creates the temporary file exclusively with its final mode,
 * so an existing path or symlink cannot redirect the write. It then renames the
 * temporary file over the target atomically.
 */
export async function writeSecretFile(
	file: string,
	contents: string,
	signal?: AbortSignal,
	operations: SecretFileOperations = {}
): Promise<void> {
	throwIfAborted(signal);
	const directory = path.dirname(file);

	await ensureSecretDirectory(directory);

	const temporary = path.join(
		directory,
		`.secret.${randomBytes(8).toString('hex')}`
	);
	const move = operations.move ?? rename;
	const remove = operations.remove ?? unlink;
	const write = operations.write ?? writeFile;

	try {
		await write(temporary, contents, { mode: 0o600, flag: 'wx' });
		await verifySecretDirectory(directory);
		throwIfAborted(signal);
		await move(temporary, file);
	} catch (error) {
		try {
			await remove(temporary);
		} catch (cleanupError) {
			if (!isNotFound(cleanupError)) {
				throw new SecretFileCleanupError(temporary, error, cleanupError);
			}
		}

		throw error;
	}
}

class SecretFileCleanupError extends Error {
	constructor(
		public readonly residuePath: string,
		public readonly operationError: unknown,
		public readonly cleanupError: unknown
	) {
		super(
			`${errorMessage(operationError)}. The temporary credential remains at '${residuePath}' because cleanup failed: ${errorMessage(cleanupError)}`,
			{ cause: operationError }
		);
		this.name = 'SecretFileCleanupError';
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the final directory for credential files with mode `0700`, or
 * reasserts that mode when the directory already exists. The final directory
 * must be owned by the current user. A path component may be a symlink only
 * when root owns the symlink.
 */
export async function ensureSecretDirectory(directory: string): Promise<void> {
	await verifyNoSymlinkComponents(directory);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await verifySecretDirectory(directory);
	await chmod(directory, 0o700);
}

async function verifySecretDirectory(directory: string): Promise<void> {
	await verifyNoSymlinkComponents(directory);

	const stats = await lstat(directory);

	if (!stats.isDirectory()) {
		throw new Error(`Secret directory '${directory}' is not a directory`);
	}

	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(
			`Secret directory '${directory}' is not owned by this user`
		);
	}
}

async function verifyNoSymlinkComponents(directory: string): Promise<void> {
	const parsed = path.parse(path.resolve(directory));
	const components = path
		.resolve(directory)
		.slice(parsed.root.length)
		.split(path.sep);
	let current = parsed.root;

	for (const component of components) {
		current = path.join(current, component);
		let stats;
		try {
			stats = await lstat(current);
		} catch (error) {
			if (isNotFound(error)) {
				return;
			}

			throw error;
		}

		if (stats.isSymbolicLink() && stats.uid !== 0) {
			throw new Error(
				`Secret directory component '${current}' is a symbolic link`
			);
		}
	}
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error && (error as { code?: string }).code === 'ENOENT'
	);
}
