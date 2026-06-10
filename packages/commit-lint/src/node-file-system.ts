import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';

import type { FileStat, FileSystem } from 'just-git';

/** Node filesystem adapter for just-git. */
export class NodeFileSystem implements FileSystem {
	async exists(path: string): Promise<boolean> {
		try {
			await fs.access(path, constants.F_OK);
			return true;
		} catch {
			return false;
		}
	}

	async lstat(path: string): Promise<FileStat> {
		return fileStat(await fs.lstat(path));
	}

	async mkdir(
		path: string,
		options?: {
			readonly recursive?: boolean;
		}
	): Promise<void> {
		await fs.mkdir(path, { recursive: options?.recursive });
	}

	async readFile(path: string): Promise<string> {
		return fs.readFile(path, 'utf8');
	}

	async readFileBuffer(path: string): Promise<Uint8Array> {
		return fs.readFile(path);
	}

	async readdir(path: string): Promise<string[]> {
		return fs.readdir(path);
	}

	async readlink(path: string): Promise<string> {
		return fs.readlink(path);
	}

	async rm(
		path: string,
		options?: {
			readonly force?: boolean;
			readonly recursive?: boolean;
		}
	): Promise<void> {
		await fs.rm(path, {
			force: options?.force,
			recursive: options?.recursive
		});
	}

	async stat(path: string): Promise<FileStat> {
		return fileStat(await fs.stat(path));
	}

	async symlink(target: string, path: string): Promise<void> {
		await fs.symlink(target, path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		await fs.writeFile(path, content);
	}
}

function fileStat(stat: Stats): FileStat {
	return {
		isDirectory: stat.isDirectory(),
		isFile: stat.isFile(),
		isSymbolicLink: stat.isSymbolicLink(),
		mode: stat.mode,
		mtime: stat.mtime,
		size: stat.size
	};
}
