import type { Transform } from 'node:stream';
import {
	constants,
	createZstdCompress,
	createZstdDecompress,
	type ZstdDecompress
} from 'node:zlib';

import { ZstdDecodeError } from './errors.ts';

export interface ByteTransformPair {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
}

type ZstdFactory = () => Transform;

const maxQueuedChunks = 16;

export function zstdCompressionStream(): ByteTransformPair {
	// Embed a content checksum in the frame epilogue. Every decompressor, the
	// server's verify pass and the Nix client alike, then rejects a corrupted
	// frame on its own, independently of the narHash check.
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

export interface ZstdDecoderOptions {
	/**
	 * The largest size of a chunk of decompressed output.
	 */
	readonly chunkSize: number;
	/**
	 * The base-2 logarithm of the largest window that a frame may require.
	 */
	readonly windowLogMax: number;
	/**
	 * Receives each chunk of decompressed output. When it returns a promise, the
	 * decoder produces no more output until the promise settles.
	 */
	readonly onOutput: (chunk: Uint8Array) => Promise<void> | undefined;
}

interface ZstdRun {
	readonly zstd: ZstdDecompress;
	readonly ended: Promise<undefined>;
}

interface ZstdFailure {
	readonly error: unknown;
}

/**
 * Decompresses concatenated zstd frames that the caller writes one chunk at a
 * time. `write` and `end` reject with `ZstdDecodeError` when the bytes do not
 * decode, and with `onOutput`'s rejection reason when the promise from
 * `onOutput` rejects.
 */
export class ZstdDecoder {
	private readonly failure = Promise.withResolvers<ZstdFailure>();
	private run: ZstdRun;

	constructor(private readonly options: ZstdDecoderOptions) {
		this.run = this.startRun();
	}

	private startRun(): ZstdRun {
		const zstd = createZstdDecompress({
			chunkSize: this.options.chunkSize,
			params: { [constants.ZSTD_d_windowLogMax]: this.options.windowLogMax }
		});
		const ended = Promise.withResolvers<undefined>();

		zstd.on('data', (chunk: Uint8Array) => {
			const handled = this.options.onOutput(chunk);

			if (handled === undefined) {
				return;
			}

			zstd.pause();
			void this.resumeAfter(zstd, handled);
		});
		zstd.once('error', (error) => {
			this.failure.resolve({ error: new ZstdDecodeError({ cause: error }) });
		});
		zstd.once('end', () => {
			ended.resolve(undefined);
		});

		return { zstd, ended: ended.promise };
	}

	private async resumeAfter(
		zstd: ZstdDecompress,
		handled: Promise<void>
	): Promise<void> {
		try {
			await handled;
			zstd.resume();
		} catch (error) {
			this.failure.resolve({ error });
		}
	}

	private async unlessFailed(operation: Promise<unknown>): Promise<void> {
		const failure = await Promise.race([
			this.failure.promise,
			completion(operation)
		]);

		if (failure === undefined) {
			return;
		}

		throw failure.error;
	}

	/**
	 * Resolves once the decoder has consumed the whole chunk.
	 */
	async write(chunk: Uint8Array): Promise<void> {
		let input = chunk;

		for (;;) {
			const { zstd, ended } = this.run;
			const consumedBefore = zstd.bytesWritten;
			// workerd's zlib ends the stream when a frame ends before the end of a
			// write, and drops the rest of that write. If the output is paused at
			// that point, zlib never calls the write callback, so treat the stream's
			// `end` event as completing the write too.
			await this.unlessFailed(Promise.race([processed(zstd, input), ended]));
			const consumed = zstd.bytesWritten - consumedBefore;

			if (consumed === input.byteLength) {
				return;
			}

			// A decoder that consumes nothing cannot make progress on this input.
			if (consumed === 0) {
				throw new ZstdDecodeError();
			}

			// The ended stream never completes a later write. Let it deliver its
			// output, then start a new decoder at the first byte that it did not
			// consume.
			await this.unlessFailed(ended);
			zstd.destroy();
			input = input.subarray(consumed);
			this.run = this.startRun();
		}
	}

	/**
	 * Resolves once the decoder has delivered all of its output.
	 */
	async end(): Promise<void> {
		this.run.zstd.end();
		await this.unlessFailed(this.run.ended);
	}

	destroy(): void {
		this.run.zstd.destroy();
	}
}

async function completion(operation: Promise<unknown>): Promise<undefined> {
	await operation;
}

function processed(stream: Transform, chunk: Uint8Array): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.write(chunk, (error?: Error | null) => {
			if (error !== undefined && error !== null) {
				reject(new ZstdDecodeError({ cause: error }));
				return;
			}

			resolve();
		});
	});
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
