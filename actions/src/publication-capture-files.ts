import { randomUUID } from 'node:crypto';
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	rmdir
} from 'node:fs/promises';
import path from 'node:path';

import { publicationRequestIdSchema } from '@cupboard/protocol/publication-manifests';
import {
	type PublicationCaptureEnvelope,
	publicationCaptureEnvelopeSchema
} from '@cupboard/protocol/publication-workflow';
import { withCleanup } from '@cupboard/shared/cleanup';

export class PublicationFileOwnershipError extends Error {
	constructor(
		readonly directory: string,
		options?: ErrorOptions
	) {
		super(
			`Publication file ownership is unavailable at '${directory}'. Preserve journals and capture envelopes; verify the original writer is inactive before removing only this lock directory.`,
			options
		);
		this.name = 'PublicationFileOwnershipError';
	}
}

export class PublicationCaptureFileError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'PublicationCaptureFileError';
	}
}

/**
No stale reclamation: only the acquiring callback may release this directory.
*/
export async function acquirePublicationFile(
	file: string,
	signal?: AbortSignal
): Promise<() => Promise<void>> {
	signal?.throwIfAborted();
	await mkdir(path.dirname(file), { recursive: true });
	const directory = `${file}.publication-lock`;
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		throw new PublicationFileOwnershipError(directory, { cause: error });
	}
	let isReleased = false;
	return async () => {
		if (isReleased) {
			return;
		}
		isReleased = true;
		await rmdir(directory);
	};
}

export async function withPublicationCaptureFile<T>(
	file: string,
	action: () => Promise<T>,
	signal?: AbortSignal
): Promise<T> {
	const release = await acquirePublicationFile(file, signal);
	let hasFailed = false;
	return withCleanup(
		async () => {
			try {
				return await action();
			} catch (error) {
				hasFailed = true;
				throw error;
			}
		},
		async () => {
			try {
				await release();
			} catch (error) {
				if (hasFailed) {
					process.stderr.write(
						`Could not release publication file ownership '${file}.publication-lock': ${String(error)}\n`
					);
				}
				throw error;
			}
		}
	);
}

export function publicationCaptureFile(
	receiptFile: string,
	requestId: string
): string {
	return `${receiptFile}.publication-capture-${publicationRequestIdSchema.parse(requestId)}.json`;
}

export async function assertNoOrphanPublicationFiles(
	receiptFile: string
): Promise<void> {
	const names = await readdir(path.dirname(receiptFile));
	const prefix = `${path.basename(receiptFile)}.publication-capture-`;
	const ordinary = `${path.basename(receiptFile)}.publication-request.json`;
	if (names.some((name) => name.startsWith(prefix) || name === ordinary)) {
		throw new PublicationCaptureFileError(
			'Publication files remain without their ownership state. Preserve the files; missing invocation state cannot be treated as a fresh capture.'
		);
	}
}

export async function readPublicationCaptureFile(
	file: string
): Promise<PublicationCaptureEnvelope> {
	return publicationCaptureEnvelopeSchema.parse(
		JSON.parse(await readFile(file, 'utf8'))
	);
}

export async function syncPublicationDirectory(file: string): Promise<void> {
	const directory = await open(path.dirname(file), 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

export async function syncPublicationCaptureFile(file: string): Promise<void> {
	const handle = await open(file, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
	await syncPublicationDirectory(file);
}

/**
Exclusive creation is used only for preparing capture files, never ready ones.
*/
export async function writePublicationStateFile(
	file: string,
	contents: string,
	isExclusive = false
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = isExclusive ? file : `${file}.${randomUUID()}`;
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(contents);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!isExclusive) {
			await rename(temporary, file);
		}
		await syncPublicationDirectory(file);
	} finally {
		if (!isExclusive) {
			await rm(temporary, { force: true });
		}
	}
}
