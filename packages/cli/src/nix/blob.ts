import { createHash } from 'node:crypto';
import type { Transform } from 'node:stream';
import { constants, createZstdCompress } from 'node:zlib';

import { type ByteSource, byteStream } from '../io/byte-stream.ts';

import type { NarDigest } from './nar.ts';
import { NarError, NixSha256Hash } from './nar.ts';

// A NAR compressed on the fly: the compressed bytes stream straight to the
// uploader, and the uncompressed NAR's hash and size, accumulated as the bytes
// pass through, are read once the stream is fully consumed. Nothing is written
// to disk, so a large closure cannot exhaust a runner's temporary space.
export interface NarUploadStream {
	readonly body: ReadableStream<Uint8Array>;
	digest(): NarDigest;
}

/**
 * Creates the stream that compresses one frame of a NAR, given the number of
 * NAR bytes that will be written to it.
 */
export type ZstdFrameCompressorFactory = (frameLength: number) => Transform;

export interface NarCompressionOptions {
	readonly createFrameCompressor: ZstdFrameCompressorFactory;
}

/**
 * Fails a NAR whose size differs from its declared size. With `ending` set to
 * `ended`, the NAR ended after exactly `actual` bytes. With `continued`, it had
 * at least `actual` bytes.
 */
export class NarSizeChangedError extends NarError {
	constructor(
		public readonly expected: number,
		public readonly actual: number,
		public readonly ending: 'ended' | 'continued'
	) {
		super(
			ending === 'ended'
				? `The NAR ended after ${String(actual)} bytes, but its declared size is ${String(expected)}`
				: `The NAR has at least ${String(actual)} bytes, but its declared size is ${String(expected)}`
		);
		this.name = 'NarSizeChangedError';
	}
}

const frameSize = 16 * 1024 * 1024;

const outputChunkSize = 1024 * 1024;

export const defaultNarCompression: NarCompressionOptions = {
	createFrameCompressor: (frameLength) =>
		createZstdCompress({
			chunkSize: outputChunkSize,
			// Without a pledged size, the frame header has no content size.
			pledgedSrcSize: frameLength,
			// Do not set ZSTD_c_nbWorkers. With it set, Node's asynchronous and
			// streaming zstd APIs return empty or truncated output without an error.
			params: { [constants.ZSTD_c_checksumFlag]: 1 }
		})
};

/**
 * Compresses a NAR of `narSize` bytes into one independent zstd frame for
 * every 16 MiB of NAR, the layout that Nix 2.35 writes. Each frame has its
 * content size in its header and, unlike Nix's frames, a content checksum.
 * Decoders that follow RFC 8878, including Nix's decoder and the server's
 * verifier, decode the concatenated frames as one stream. Node's zstd
 * decompressor stops after the first frame.
 *
 * The frames are compressed one after another, each by its own zstd stream,
 * and the NAR's bytes go into the current frame's stream as they are read.
 * Compressing a NAR therefore keeps one zstd context and a few 1 MiB chunks in
 * memory. The body fails with `NarSizeChangedError` when the source has more
 * or fewer bytes than `narSize`.
 */
export function compressNarToStream(
	nar: ByteSource,
	narSize: number,
	options: NarCompressionOptions = defaultNarCompression
): NarUploadStream {
	const hasher = new NarHasher();
	const frames = compressedFrames(new NarReader(nar, narSize, hasher), options);

	return {
		body: byteStream(frames),
		digest: () => {
			const digest = hasher.digest();

			return { narHash: digest.hash, narSize: digest.size };
		}
	};
}

/**
 * Sends a compressed NAR's body with `send`. When sending fails, it cancels the
 * body and rethrows the error. Cancelling the body stops the compressor and
 * closes the NAR's open files.
 */
export async function sendCompressedNar<T>(
	body: ReadableStream<Uint8Array>,
	send: (body: ReadableStream<Uint8Array>) => Promise<T>
): Promise<T> {
	try {
		return await send(body);
	} catch (error) {
		// While an uploader still has a reader, the body is locked and only that
		// uploader can cancel it.
		if (!body.locked) {
			await body.cancel(error);
		}

		throw error;
	}
}

async function* compressedFrames(
	reader: NarReader,
	options: NarCompressionOptions
): AsyncIterable<Uint8Array> {
	try {
		for (const frameLength of frameLengths(reader.narSize)) {
			yield* compressedFrame(
				reader,
				options.createFrameCompressor(frameLength),
				frameLength
			);
		}

		await reader.expectEnd();
	} finally {
		await reader.close();
	}
}

function frameLengths(narSize: number): number[] {
	const lengths = Array.from(
		{ length: Math.floor(narSize / frameSize) },
		() => frameSize
	);
	const remainder = narSize % frameSize;

	return remainder > 0 || lengths.length === 0
		? [...lengths, remainder]
		: lengths;
}

async function* compressedFrame(
	reader: NarReader,
	zstd: Transform,
	frameLength: number
): AsyncIterable<Uint8Array> {
	const writing = writeFrameInput(reader, zstd, frameLength);

	try {
		for await (const chunk of zstd) {
			if (chunk instanceof Uint8Array) {
				yield chunk;
			}
		}
	} finally {
		zstd.destroy();
		await writing;
	}
}

// Never rejects: a failure destroys `zstd` with the error, which ends the
// iteration of its output with that error.
async function writeFrameInput(
	reader: NarReader,
	zstd: Transform,
	frameLength: number
): Promise<void> {
	try {
		for (let written = 0; written < frameLength && !zstd.destroyed;) {
			const bytes = await reader.read(frameLength - written);
			written += bytes.byteLength;

			if (!zstd.write(bytes)) {
				await drained(zstd);
			}
		}

		zstd.end();
	} catch (error) {
		zstd.destroy(error instanceof Error ? error : undefined);
	}
}

function drained(stream: Transform): Promise<void> {
	return new Promise((resolve) => {
		const settle = (): void => {
			stream.off('drain', settle);
			stream.off('close', settle);
			resolve();
		};

		stream.once('drain', settle);
		stream.once('close', settle);
	});
}

/**
 * Returns the NAR's bytes in slices no longer than the caller's limit, so no
 * slice crosses a frame boundary, and hashes each byte once as it is read.
 */
class NarReader {
	private readonly chunks: AsyncIterator<Uint8Array>;

	private pending: Uint8Array | undefined;

	private total = 0;

	constructor(
		source: ByteSource,
		readonly narSize: number,
		private readonly hasher: NarHasher
	) {
		this.chunks = chunksOf(source)[Symbol.asyncIterator]();
	}

	private async nextChunk(): Promise<Uint8Array | undefined> {
		for (;;) {
			const next = await this.chunks.next();

			if (next.done === true) {
				return undefined;
			}

			if (next.value.byteLength > 0) {
				return next.value;
			}
		}
	}

	/**
	 * Returns between one and `limit` bytes, or fails with
	 * `NarSizeChangedError` when the source has ended.
	 */
	async read(limit: number): Promise<Uint8Array> {
		const chunk = this.pending ?? (await this.nextChunk());

		if (chunk === undefined) {
			throw new NarSizeChangedError(this.narSize, this.total, 'ended');
		}

		const bytes = chunk.subarray(0, limit);
		this.pending = chunk.byteLength > limit ? chunk.subarray(limit) : undefined;
		this.total += bytes.byteLength;
		this.hasher.update(bytes);

		return bytes;
	}

	/**
	 * Fails with `NarSizeChangedError` when the source has more bytes.
	 */
	async expectEnd(): Promise<void> {
		const chunk = this.pending ?? (await this.nextChunk());

		if (chunk === undefined) {
			return;
		}

		throw new NarSizeChangedError(
			this.narSize,
			this.total + chunk.byteLength,
			'continued'
		);
	}

	async close(): Promise<void> {
		await this.chunks.return?.();
	}
}

async function* chunksOf(source: ByteSource): AsyncIterable<Uint8Array> {
	yield* source;
}

class NarHasher {
	private readonly hash = createHash('sha256');

	private size = 0;

	// `createHash` can be finalised only once, so the result is cached: a stream
	// whose hash is read more than once (a fake, or a retry) gets the same value.
	private finalised:
		{ readonly hash: NixSha256Hash; readonly size: number } | undefined;

	update(chunk: Uint8Array): void {
		this.hash.update(chunk);
		this.size += chunk.byteLength;
	}

	digest(): {
		readonly hash: NixSha256Hash;
		readonly size: number;
	} {
		this.finalised ??= {
			hash: NixSha256Hash.fromDigest(this.hash.digest()),
			size: this.size
		};

		return this.finalised;
	}
}
