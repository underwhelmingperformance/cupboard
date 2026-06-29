import type { Transform } from 'node:stream';
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib';

import { ZstdDecodeError } from './errors.ts';

export interface ByteTransformPair {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

type ZstdFactory = () => Transform;

const maxQueuedChunks = 16;

export function zstdCompressionStream(): ByteTransformPair {
	// Embed a content checksum in the frame epilogue: every decompressor, the
	// server's verify pass and the client's Nix alike, then rejects a corrupted
	// frame on its own, independent of the narHash check.
	return zstdTransformStream(() =>
		createZstdCompress({ params: { [constants.ZSTD_c_checksumFlag]: 1 } })
	);
}

export function zstdDecompressionStream(): ByteTransformPair {
	return zstdTransformStream(createZstdDecompress, true);
}

function zstdTransformStream(
	createTransform: ZstdFactory,
	shouldTagDecodeErrors = false
): ByteTransformPair {
	const zstd = createTransform();
	const queue: Uint8Array[] = [];
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let isClosed = false;
	let failed: unknown;
	let wasDestroyedExternally = false;

	const readable = new ReadableStream<Uint8Array>({
		start(readableController) {
			controller = readableController;
			zstd.on('data', (chunk: Buffer) => {
				queue.push(chunk);
				drain();
			});
			zstd.once('end', () => {
				isClosed = true;
				drain();
			});
			zstd.once('error', (error) => {
				// A transform error with no external destroy is a genuine decode
				// failure (the bytes are not a valid frame); an abort or cancel routes
				// through destroyZstd carrying the source's own error, which must stay
				// untagged so the caller can treat it as a transient read fault.
				failed =
					shouldTagDecodeErrors && !wasDestroyedExternally
						? new ZstdDecodeError({ cause: error })
						: error;
				drain();
			});
		},
		pull() {
			drain();
		},
		cancel(reason) {
			wasDestroyedExternally = true;
			destroyZstd(zstd, reason);
		}
	});

	const writable = new WritableStream<Uint8Array>({
		write: (chunk) => writeChunk(zstd, chunk),
		close() {
			zstd.end();
		},
		abort(reason) {
			wasDestroyedExternally = true;
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

		if (isClosed && queue.length === 0) {
			controller.close();
		}
	}

	return { readable, writable };
}

function writeChunk(stream: Transform, chunk: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		let wasWritten = false;
		let isReady = false;

		// Resolve only once the write has completed AND the transform can take
		// more. Waiting for the callback means a late write error is still
		// reported; waiting for `drain` when the buffer is full honours write-side
		// backpressure.
		const settle = (): void => {
			if (wasWritten && isReady) {
				resolve();
			}
		};

		isReady = stream.write(chunk, (error?: Error | null) => {
			if (error !== undefined && error !== null) {
				reject(error);
				return;
			}

			wasWritten = true;
			settle();
		});

		if (isReady) {
			settle();
			return;
		}

		stream.once('drain', () => {
			isReady = true;
			settle();
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
