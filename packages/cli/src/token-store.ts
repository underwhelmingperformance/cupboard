import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { env } from 'node:process';

/**
 * Where the cached owner access token lives: under `$XDG_CONFIG_HOME` when set,
 * otherwise `~/.config`. One token per machine; `cupboard login` writes it and
 * the admin commands read it.
 */
export function tokenCachePath(): string {
	const base =
		env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME !== ''
			? env.XDG_CONFIG_HOME
			: path.join(homedir(), '.config');

	return path.join(base, 'cupboard', 'token');
}

export async function readCachedToken(
	target: string = tokenCachePath()
): Promise<string | undefined> {
	let contents: string;

	try {
		contents = await readFile(target, 'utf8');
	} catch (error) {
		if (isNotFound(error)) {
			return undefined;
		}

		throw error;
	}

	const token = contents.trim();

	return token === '' ? undefined : token;
}

/**
 * Persists the token readable only by the current user. It is written to a fresh
 * `0600` temporary file (exclusive create, so a pre-planted symlink is not
 * followed) and renamed over the target atomically; the directory is created and
 * its mode reasserted to `0700`. This avoids the window an in-place write leaves
 * between creating the file and tightening its mode.
 */
export async function writeCachedToken(
	token: string,
	target: string = tokenCachePath()
): Promise<void> {
	const directory = path.dirname(target);

	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);

	const temporary = path.join(
		directory,
		`.token.${randomBytes(8).toString('hex')}`
	);
	await writeFile(temporary, `${token}\n`, { mode: 0o600, flag: 'wx' });
	await rename(temporary, target);
}

function isNotFound(error: unknown): boolean {
	return (
		error instanceof Error && (error as { code?: string }).code === 'ENOENT'
	);
}
