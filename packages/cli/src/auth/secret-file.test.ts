import type { Stats } from 'node:fs';
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	SecretDirectoryNotDirectoryError,
	SecretDirectoryOwnerError,
	SecretDirectorySymlinkError,
	writeSecretFile
} from './secret-file.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-secret-file-'));
	temporaryDirectories.push(directory);

	return directory;
}

// The writer accepts a symlink only when root owns it. The owner of a symlink
// that a test creates depends on who runs the tests, so the tests pass an
// `inspect` function that returns the symlink's `lstat` metadata with a chosen
// uid. Both acceptance and rejection are then exercised whether the tests run as
// root or as another user.
const rootUid = 0;
const unprivilegedUid = 65_534;

function reportOwner(
	link: string,
	uid: number
): (file: string) => Promise<Stats> {
	return async (file) => {
		const stats = await lstat(file);

		if (file === link) {
			stats.uid = uid;
		}

		return stats;
	};
}

afterEach(async () => {
	const directories = [...temporaryDirectories];
	temporaryDirectories.length = 0;
	await Promise.all(
		directories.map((directory) =>
			rm(directory, { recursive: true, force: true })
		)
	);
});

describe('writeSecretFile', () => {
	it('removes the temporary secret when the final rename fails', async () => {
		const base = await temporaryDirectory();
		const directory = path.join(base, 'config');
		const destination = path.join(directory, 'session');
		await mkdir(destination, { recursive: true });

		await expect(writeSecretFile(destination, 'secret')).rejects.toThrow();

		expect(await readdir(directory)).toStrictEqual(['session']);
	});

	it('removes a temporary secret when writing it fails after creation', async () => {
		const base = await temporaryDirectory();
		const directory = path.join(base, 'config');
		const destination = path.join(directory, 'session');
		const failure = new Error('secret write failed');

		await expect(
			writeSecretFile(destination, 'secret', undefined, {
				write: async (...arguments_) => {
					await writeFile(...arguments_);
					throw failure;
				}
			})
		).rejects.toBe(failure);
		expect(await readdir(directory)).toStrictEqual([]);
	});

	it('reports a temporary secret that cleanup could not remove', async () => {
		const base = await temporaryDirectory();
		const directory = path.join(base, 'config');
		const destination = path.join(directory, 'session');
		const failure = new Error('secret write failed');
		const cleanupFailure = new Error('temporary removal failed');
		let error: unknown;

		try {
			await writeSecretFile(destination, 'secret', undefined, {
				write: async (...arguments_) => {
					await writeFile(...arguments_);
					throw failure;
				},
				remove: () => Promise.reject(cleanupFailure)
			});
		} catch (error_) {
			error = error_;
		}

		const [residue] = await readdir(directory);

		expect(error).toMatchObject({
			name: 'SecretFileCleanupError',
			message: `${failure.message}. The temporary credential remains at '${path.join(directory, residue ?? '')}' because cleanup failed: ${cleanupFailure.message}`,
			cause: failure,
			residuePath: path.join(directory, residue ?? ''),
			operationError: failure,
			cleanupError: cleanupFailure
		});
		expect(residue).toMatch(/^\.secret\./u);
	});

	it('refuses a symlinked secret directory without changing its target', async () => {
		const base = await temporaryDirectory();
		const target = path.join(base, 'target');
		const linked = path.join(base, 'config');
		await mkdir(target, { mode: 0o755 });
		await symlink(target, linked);

		await expect(
			writeSecretFile(path.join(linked, 'session'), 'secret', undefined, {
				inspect: reportOwner(linked, unprivilegedUid)
			})
		).rejects.toStrictEqual(new SecretDirectorySymlinkError(linked));

		const targetStats = await lstat(target);
		const targetMode = targetStats.mode & 0o777;
		expect({ targetMode, entries: await readdir(target) }).toStrictEqual({
			targetMode: 0o755,
			entries: []
		});
	});

	it('refuses a symlinked parent before creating the secret directory', async () => {
		const base = await temporaryDirectory();
		const target = path.join(base, 'target');
		const linked = path.join(base, 'config');
		await mkdir(target);
		await symlink(target, linked);

		await expect(
			writeSecretFile(
				path.join(linked, 'nested', 'session'),
				'secret',
				undefined,
				{
					inspect: reportOwner(linked, unprivilegedUid)
				}
			)
		).rejects.toStrictEqual(new SecretDirectorySymlinkError(linked));

		expect(await readdir(target)).toStrictEqual([]);
	});

	it('refuses a secret directory that is not a directory', async () => {
		const base = await temporaryDirectory();
		const directory = path.join(base, 'config');
		const regularFile = path.join(base, 'file');
		await writeFile(regularFile, '');

		await expect(
			writeSecretFile(path.join(directory, 'session'), 'secret', undefined, {
				inspect: (file) => lstat(file === directory ? regularFile : file)
			})
		).rejects.toStrictEqual(new SecretDirectoryNotDirectoryError(directory));
	});

	it('writes through a root-owned symlinked parent', async () => {
		const base = await temporaryDirectory();
		const target = path.join(base, 'target');
		const linked = path.join(base, 'config');
		const secret = path.join(target, 'nested', 'session');
		await mkdir(target);
		await symlink(target, linked);

		await writeSecretFile(
			path.join(linked, 'nested', 'session'),
			'secret',
			undefined,
			{
				inspect: reportOwner(linked, rootUid)
			}
		);

		const secretStats = await lstat(secret);
		expect({
			entries: await readdir(path.dirname(secret)),
			contents: await readFile(secret, 'utf8'),
			mode: secretStats.mode & 0o777
		}).toStrictEqual({
			entries: ['session'],
			contents: 'secret',
			mode: 0o600
		});
	});

	it('refuses a secret directory not owned by the current user', async () => {
		const base = await temporaryDirectory();
		const directory = path.join(base, 'config');
		await mkdir(directory);

		const originalGetuid = process.getuid;
		process.getuid = () => (originalGetuid?.() ?? 0) + 1;
		try {
			await expect(
				writeSecretFile(path.join(directory, 'session'), 'secret')
			).rejects.toStrictEqual(new SecretDirectoryOwnerError(directory));
		} finally {
			process.getuid = originalGetuid;
		}
	});
});
