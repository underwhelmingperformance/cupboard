import type { Stats } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const temporaryRoot =
	process.platform === 'darwin' ? '/private/tmp' : tmpdir();

export interface TemporaryDirectoryOptions {
	readonly root?: string;
	readonly makeWritableBeforeCleanup?: boolean;
}

export async function withTemporaryDirectory<T>(
	prefix: string,
	body: (directory: string) => Promise<T>,
	options: TemporaryDirectoryOptions = {}
): Promise<T> {
	const directory = await mkdtemp(
		path.join(options.root ?? temporaryRoot, prefix)
	);

	try {
		return await body(directory);
	} finally {
		if (options.makeWritableBeforeCleanup === true) {
			await makeWritable(directory);
		}

		await rm(directory, { force: true, recursive: true });
	}
}

export async function makeWritable(target: string): Promise<void> {
	let stats: Stats;

	try {
		stats = await lstat(target);
	} catch {
		return;
	}

	await chmod(target, 0o700);

	if (!stats.isDirectory()) {
		return;
	}

	const entries = await readdir(target);

	await Promise.all(
		entries.map((entry) => makeWritable(path.join(target, entry)))
	);
}
