import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

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

/**
 * Persists a secret, readable only by the current user. It is written to a
 * fresh `0600` temporary file (exclusive create, so a pre-planted symlink is
 * not followed) and renamed over the target atomically; the directory is
 * created and its mode reasserted to `0700`. The file is therefore never
 * readable by anyone else, not even for the moment between its creation and
 * its mode being set.
 */
export async function writeSecretFile(
	file: string,
	contents: string
): Promise<void> {
	const directory = path.dirname(file);

	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);

	const temporary = path.join(
		directory,
		`.secret.${randomBytes(8).toString('hex')}`
	);
	await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
	await rename(temporary, file);
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error && (error as { code?: string }).code === 'ENOENT'
	);
}
