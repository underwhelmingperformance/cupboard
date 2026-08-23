import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeSecretFile } from './secret-file.ts';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-secret-file-'));
	temporaryDirectories.push(directory);

	return directory;
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
			writeSecretFile(path.join(linked, 'session'), 'secret')
		).rejects.toThrow(/symbolic link/u);

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
			writeSecretFile(path.join(linked, 'nested', 'session'), 'secret')
		).rejects.toThrow(/symbolic link/u);

		expect(await readdir(target)).toStrictEqual([]);
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
			).rejects.toThrow(/not owned/u);
		} finally {
			process.getuid = originalGetuid;
		}
	});
});
