import type { Transform } from 'node:stream';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';

interface ByteTransformPair {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

type ZstdFactory = () => Transform;

const maxQueuedChunks = 16;

export function zstdCompressionStream(): ByteTransformPair {
	return zstdTransformStream(createZstdCompress);
}

export function zstdDecompressionStream(): ByteTransformPair {
	return zstdTransformStream(createZstdDecompress);
}

function zstdTransformStream(createTransform: ZstdFactory): ByteTransformPair {
	const zstd = createTransform();
	const queue: Uint8Array[] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let closed = false;
	let failed: unknown;

	const readable = new ReadableStream<Uint8Array>({
		start(readableController) {
			controller = readableController;
			zstd.on('data', (chunk: Buffer) => {
				queue.push(chunk);
				drain();
			});
			zstd.once('end', () => {
				closed = true;
				drain();
			});
			zstd.once('error', (error) => {
				failed = error;
				drain();
			});
		},
		pull() {
			drain();
		},
		cancel(reason) {
			destroyZstd(zstd, reason);
		}
	});

	const writable = new WritableStream<Uint8Array>({
		write(chunk) {
			return writeChunk(zstd, chunk);
		},
		close() {
			zstd.end();
		},
		abort(reason) {
			destroyZstd(zstd, reason);
		}
	});

	function drain(): void {
		if (controller === undefined) {
			return;
		}

		if (failed !== undefined) {
			controller.error(failed);
			return;
		}

		while (queue.length > 0 && (controller.desiredSize ?? 0) > 0) {
			const chunk = queue.shift();

			if (chunk === undefined) {
				return;
			}

			controller.enqueue(chunk);
		}

		if (queue.length >= maxQueuedChunks || (controller.desiredSize ?? 0) <= 0) {
			zstd.pause();
		}

		if (queue.length < maxQueuedChunks && (controller.desiredSize ?? 0) > 0) {
			zstd.resume();
		}

		if (closed && queue.length === 0) {
			controller.close();
		}
	}

	return { readable, writable };
}

function writeChunk(stream: Transform, chunk: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(chunk, (error?: Error | null) => {
			if (error !== undefined && error !== null) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

function destroyZstd(stream: Transform, reason: unknown): void {
	if (reason instanceof Error) {
		stream.destroy(reason);
		return;
	}

	stream.destroy();
}
