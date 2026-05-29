import { type FileHandle, open } from 'node:fs/promises';

const fileChunkSize = 64 * 1024;

export function readFileByteStream(path: string): ReadableStream<Uint8Array> {
	let file: FileHandle | undefined;
	let position = 0;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			file ??= await open(path, 'r');

			const buffer = Buffer.allocUnsafe(fileChunkSize);
			const { bytesRead } = await file.read(
				buffer,
				0,
				buffer.byteLength,
				position
			);

			if (bytesRead === 0) {
				await closeFile(file);
				file = undefined;
				controller.close();
				return;
			}

			position += bytesRead;
			controller.enqueue(buffer.subarray(0, bytesRead));
		},
		async cancel() {
			await closeFile(file);
			file = undefined;
		}
	});
}

export function writeFileByteStream(path: string): WritableStream<Uint8Array> {
	let file: FileHandle | undefined;
	let position = 0;

	return new WritableStream<Uint8Array>({
		async start() {
			file = await open(path, 'w');
		},
		async write(chunk) {
			if (file === undefined) {
				throw new FileStreamClosedError(path);
			}

			await file.write(chunk, 0, chunk.byteLength, position);
			position += chunk.byteLength;
		},
		async close() {
			await closeFile(file);
			file = undefined;
		},
		async abort() {
			await closeFile(file);
			file = undefined;
		}
	});
}

async function closeFile(file: FileHandle | undefined): Promise<void> {
	if (file === undefined) {
		return;
	}

	await file.close();
}

class FileStreamClosedError extends Error {
	constructor(public readonly path: string) {
		super(`File stream is closed: ${path}`);
		this.name = 'FileStreamClosedError';
	}
}
