import { type Stats, watch } from 'node:fs';
import { chmod, lstat, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
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

// `fs.watch` reports every change in the containing directory, so a directory
// that other processes are also writing to can produce far more events than the
// watcher delivers. The event for the awaited file is then lost and the caller
// waits for ever. Re-check on this interval as well, so a lost event costs a
// short delay instead of a hang.
const missedEventCheckIntervalMs = 50;

/**
Resolves once a file exists. Filesystem events report it promptly, and a
periodic check covers an event the watcher does not deliver.
*/
export async function waitForFile(
	filePath: string,
	signal?: AbortSignal
): Promise<void> {
	signal?.throwIfAborted();

	try {
		await stat(filePath);
		signal?.throwIfAborted();
		return;
	} catch (error) {
		if (!isMissingFile(error)) {
			throw error;
		}
	}

	await new Promise<void>((resolve, reject) => {
		const expectedName = path.basename(filePath);
		const watcher = watch(path.dirname(filePath));
		let isSettled = false;

		const finish = (error?: Error): void => {
			if (isSettled) {
				return;
			}

			isSettled = true;
			signal?.removeEventListener('abort', onAbort);
			clearInterval(missedEventCheck);
			watcher.close();

			if (error === undefined) {
				resolve();
				return;
			}

			reject(error);
		};
		const onAbort = (): void => {
			finish(errorForRejection(signal?.reason));
		};
		const observeFile = async (): Promise<void> => {
			try {
				await stat(filePath);
				finish();
			} catch (error) {
				if (!isMissingFile(error)) {
					finish(errorForRejection(error));
				}
			}
		};

		const missedEventCheck = setInterval(() => {
			void observeFile();
		}, missedEventCheckIntervalMs);

		watcher.on('change', (_event, filename) => {
			if (shouldObserveFile(filename, expectedName)) {
				void observeFile();
			}
		});
		watcher.on('error', finish);
		signal?.addEventListener('abort', onAbort, { once: true });

		if (signal?.aborted === true) {
			onAbort();
			return;
		}

		// Close the gap between the first stat and registering the watcher.
		void observeFile();
	});
}

function shouldObserveFile(
	filename: string | Buffer | null,
	expectedName: string
): boolean {
	return filename === null || filename.toString() === expectedName;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorForRejection(error: unknown): Error {
	return error instanceof Error
		? error
		: new Error('The file watcher failed', { cause: error });
}
