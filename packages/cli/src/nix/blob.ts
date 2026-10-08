import { createHash, type Hash } from 'node:crypto';
import type { Transform } from 'node:stream';
import { constants, createZstdCompress } from 'node:zlib';

import { abortable } from '../abort.ts';
import { type ByteSource, byteStream } from '../io/byte-stream.ts';

import type { NarDigest } from './nar.ts';
import { NarError, NixSha256Hash } from './nar.ts';
import type { NarSource } from './nar-source.ts';

// A NAR compressed on the fly: the compressed bytes stream straight to the
// uploader, and the uncompressed NAR's hash and size, accumulated as the bytes
// pass through, are read once the stream is fully consumed. Nothing is written
// to disk, so a large closure cannot exhaust a runner's temporary space.
export interface NarUploadStream {
	readonly body: ReadableStream<Uint8Array>;
	digest(): NarDigest;
	/**
	 * Returns the NAR's compression facts. They are complete once the body has
	 * been read to the end.
	 */
	compression?(): NarCompressionFacts;
}

export interface NarCompressionFacts {
	readonly narBytes: number;
	readonly compressedBytes: number;
	readonly frames: number;
	/**
	 * How long the body's reader waited for the NAR to be read and compressed,
	 * in milliseconds.
	 */
	readonly compressionMs: number;
}

/**
 * Creates the stream that compresses one frame of a NAR, given the number of
 * NAR bytes that will be written to it.
 */
export type ZstdFrameCompressorFactory = (frameLength: number) => Transform;

export interface NarCompressionOptions {
	readonly createFrameCompressor: ZstdFrameCompressorFactory;
	/**
	 * Returns the current time in milliseconds.
	 */
	readonly now: () => number;
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
		}),
	now: () => performance.now()
};

/**
 * Compresses a NAR of `narSize` bytes into one independent zstd frame for
 * every 16 MiB of NAR, the layout that Nix 2.35 writes, and returns the
 * compressed bytes as a stream. `FramedNarCompressor` describes the frames.
 */
export function compressNarToStream(
	nar: NarSource,
	narSize: number,
	options: NarCompressionOptions = defaultNarCompression
): NarUploadStream {
	const compressor = new FramedNarCompressor(nar, narSize, options);

	return {
		body: byteStream(compressedChunks(compressor)),
		digest: () => compressor.digest(),
		compression: () => compressor.compression()
	};
}

async function* compressedChunks(
	compressor: FramedNarCompressor
): AsyncIterable<Uint8Array> {
	try {
		for (
			let chunk = await compressor.read(Infinity);
			chunk !== undefined;
			chunk = await compressor.read(Infinity)
		) {
			yield chunk;
		}
	} finally {
		await compressor.close();
	}
}

/**
 * Raised when recompressed bytes differ from the bytes that the first read
 * produced. `frame` is the frame whose bytes differ, and `position` is the
 * compressed offset at which the difference was found. The NAR or its source
 * changed between the two reads.
 */
export class RecompressedNarMismatchError extends NarError {
	constructor(
		public readonly frame: number,
		public readonly position: number
	) {
		super(
			`The recompressed bytes of frame ${String(frame)} differ from the first read at compressed offset ${String(position)}`
		);
		this.name = 'RecompressedNarMismatchError';
	}
}

/**
 * Fails `FramedNarCompressor.checkpoint` when no compressed byte follows
 * `position`. A checkpoint is taken only after `hasMore` resolves to true.
 */
export class CheckpointUnavailableError extends NarError {
	constructor(public readonly position: number) {
		super(
			`No compressed byte follows position ${String(position)}, so it cannot be a checkpoint`
		);
		this.name = 'CheckpointUnavailableError';
	}
}

/**
 * Fails a rewind to the frame that starts at NAR offset `offset` when the NAR
 * hash has not reached that frame, so its state there is unknown.
 */
export class NarHashStateMissingError extends NarError {
	constructor(public readonly offset: number) {
		super(`The NAR hash has not reached the frame at offset ${String(offset)}`);
		this.name = 'NarHashStateMissingError';
	}
}

/**
 * A compressed position, the frame that contains the byte at that position,
 * the number of the frame's bytes before the position, and the SHA-256
 * digest, in hex, of those bytes.
 */
export interface CompressedCheckpoint {
	readonly position: number;
	readonly frame: number;
	readonly frameOffset: number;
	readonly digest: string;
}

interface FrameRecord {
	readonly start: number;
	hash: Hash;
	length?: number;
	digest?: string;
}

type FrameChunk = Extract<FrameEvent, { readonly kind: 'chunk' }>;

// The bytes being recompressed after a rewind: the frame being read again,
// the hash of its bytes so far, and the position that the first read reached.
interface Replay {
	frame: number;
	hash: Hash;
	readonly until: CompressedCheckpoint;
	readonly narStart: number;
}

/**
 * Compresses a NAR of `narSize` bytes into one independent zstd frame for
 * every 16 MiB of NAR, the layout that Nix 2.35 writes, and returns the
 * compressed bytes as the caller reads them. Each frame has its content size
 * in its header and, unlike Nix's frames, a content checksum. Decoders that
 * follow RFC 8878, including Nix's decoder and the server's verifier, decode
 * the concatenated frames as one stream. Node's zstd decompressor stops after
 * the first frame.
 *
 * The frames are compressed one after another, each by its own zstd stream,
 * and the NAR's bytes go into the current frame's stream as they are read.
 * Compressing a NAR therefore keeps one zstd context and a few 1 MiB chunks in
 * memory. Reading fails with `NarSizeChangedError` when the source has more or
 * fewer bytes than `narSize`.
 *
 * The compressor hashes the NAR bytes as it reads them, and records each
 * frame's compressed offset and the SHA-256 digest of its compressed bytes.
 * `rewind` moves back to a checkpoint: it closes the source, opens it again at
 * the start of the checkpoint's frame, and recompresses from there. The bytes
 * up to the position that the first read reached are checked against the
 * recorded digests, and reading then continues past it. The NAR hash returns
 * to its state at the start of that frame and hashes the bytes that are read
 * again, so the digest always describes the NAR that the returned compressed
 * bytes decode to. The source is never open twice at once.
 */
export class FramedNarCompressor {
	private hasher = new NarHasher();

	private reader: NarReader;

	private events: AsyncIterator<FrameEvent>;

	private readonly records: FrameRecord[] = [];

	private pending: FrameChunk | undefined;

	private isDone = false;

	private consumed = 0;

	private reached = 0;

	private lastFrame = 0;

	private compressionMs = 0;

	private replay: Replay | undefined;

	private replayedNarBytes = 0;

	private narReached = 0;

	readonly frames: NarFrames;

	constructor(
		private readonly source: NarSource,
		narSize: number,
		private readonly options: NarCompressionOptions = defaultNarCompression
	) {
		this.frames = new NarFrames(narSize);
		this.reader = new NarReader(source.open(0), narSize, 0, this.hasher);
		this.events = frameEvents(this.reader, this.frames, 0, options)[
			Symbol.asyncIterator
		]();
	}

	// The checkpoint at the end of the bytes that the first read has returned,
	// in the frame of the last of those bytes.
	private tail(): CompressedCheckpoint {
		if (this.replay !== undefined) {
			return this.replay.until;
		}

		const record = this.record(this.lastFrame);
		const frameOffset = this.consumed - record.start;

		return {
			position: this.consumed,
			frame: this.lastFrame,
			frameOffset,
			digest:
				record.digest !== undefined && record.length === frameOffset
					? record.digest
					: record.hash.copy().digest('hex')
		};
	}

	private record(frame: number): FrameRecord {
		const existing = this.records[frame];

		if (existing !== undefined) {
			return existing;
		}

		const created: FrameRecord = {
			start: this.consumed,
			hash: createHash('sha256')
		};
		this.records[frame] = created;

		return created;
	}

	private async advance(signal: AbortSignal | undefined): Promise<void> {
		if (this.pending !== undefined || this.isDone) {
			return;
		}

		const startedAt = this.options.now();

		try {
			for (;;) {
				const next = await abortable(this.events.next(), signal);

				if (next.done === true) {
					this.isDone = true;
					return;
				}

				const event = next.value;

				if (event.kind === 'end') {
					this.endFrame(event.frame);
					continue;
				}

				this.record(event.frame);

				if (event.bytes.byteLength > 0) {
					this.pending = event;
					return;
				}
			}
		} finally {
			this.compressionMs += this.options.now() - startedAt;
		}
	}

	private endFrame(frame: number): void {
		const record = this.record(frame);

		// The first read completed this frame, so the replay checked all of its
		// bytes before it finished.
		if (this.replay === undefined && record.digest !== undefined) {
			return;
		}

		if (this.replay === undefined) {
			record.length = this.consumed - record.start;
			record.digest = record.hash.digest('hex');
			return;
		}

		if (this.replay.hash.digest('hex') !== record.digest) {
			throw new RecompressedNarMismatchError(frame, this.consumed);
		}

		this.replay.frame = frame + 1;
		this.replay.hash = createHash('sha256');
	}

	// Ends a replay once it reaches the position that the first read reached.
	// The check runs before those last bytes are returned, so a request that
	// sends them cannot complete with bytes that differ.
	private finishReplay(replay: Replay): void {
		if (
			replay.frame !== replay.until.frame ||
			replay.hash.copy().digest('hex') !== replay.until.digest
		) {
			throw new RecompressedNarMismatchError(replay.frame, this.consumed);
		}

		this.record(replay.frame).hash = replay.hash;
		this.replayedNarBytes = this.reader.position - replay.narStart;
		this.replay = undefined;
	}

	private replayDigest(): string | undefined {
		return this.replay?.hash.copy().digest('hex');
	}

	private finishReplayIfReached(): void {
		const replay = this.replay;

		if (this.consumed !== replay?.until.position) {
			return;
		}

		this.finishReplay(replay);
	}

	/**
	 * The number of compressed bytes read so far.
	 */
	get position(): number {
		return this.consumed;
	}

	/**
	 * The furthest compressed position that the first read has reached.
	 */
	get reachedPosition(): number {
		return this.reached;
	}

	/**
	 * Whether the compressor is recompressing bytes that the first read has
	 * already returned.
	 */
	get isReplaying(): boolean {
		return this.replay !== undefined;
	}

	/**
	 * The number of NAR bytes that the last completed replay recompressed.
	 */
	get lastReplayNarBytes(): number {
		return this.replayedNarBytes;
	}

	/**
	 * Resolves to whether there are compressed bytes left to read. It rejects
	 * with the signal's reason when `signal` aborts first.
	 */
	async hasMore(signal?: AbortSignal): Promise<boolean> {
		await this.advance(signal);

		return this.pending !== undefined;
	}

	/**
	 * Returns up to `limit` compressed bytes from one chunk, or `undefined`
	 * once every byte has been read. While it recompresses, it rejects with
	 * `RecompressedNarMismatchError` at the end of a frame whose bytes differ
	 * from the first read, or before it returns the last bytes up to the
	 * position that the first read reached. It rejects with the signal's
	 * reason when `signal` aborts first.
	 */
	async read(
		limit: number,
		signal?: AbortSignal
	): Promise<Uint8Array | undefined> {
		await this.advance(signal);

		const chunk = this.pending;

		if (chunk === undefined) {
			return undefined;
		}

		const replay = this.replay;
		const bytes = chunk.bytes.subarray(
			0,
			replay === undefined
				? limit
				: Math.min(limit, replay.until.position - this.consumed)
		);
		this.pending =
			bytes.byteLength < chunk.bytes.byteLength
				? { ...chunk, bytes: chunk.bytes.subarray(bytes.byteLength) }
				: undefined;
		this.consumed += bytes.byteLength;
		this.lastFrame = chunk.frame;

		if (replay === undefined) {
			this.record(chunk.frame).hash.update(bytes);
			this.reached = this.consumed;

			return bytes;
		}

		replay.hash.update(bytes);

		this.finishReplayIfReached();

		return bytes;
	}

	/**
	 * Estimates the remaining compressed bytes, using the ratio of compressed
	 * bytes returned so far to NAR bytes compressed so far.
	 */
	estimateRemaining(): number {
		const narRead = Math.max(this.narReached, this.reader.position);

		if (narRead === 0) {
			return this.frames.compressedBound();
		}

		return (this.reached / narRead) * (this.frames.narSize - narRead);
	}

	/**
	 * Returns a checkpoint at the current position. Call it only after
	 * `hasMore` resolves to true.
	 */
	checkpoint(): CompressedCheckpoint {
		const chunk = this.pending;

		if (chunk === undefined) {
			throw new CheckpointUnavailableError(this.consumed);
		}

		const record = this.record(chunk.frame);

		return {
			position: this.consumed,
			frame: chunk.frame,
			frameOffset: this.consumed - record.start,
			digest: (this.replay?.hash ?? record.hash).copy().digest('hex')
		};
	}

	/**
	 * Discards the saved state of the NAR hash for the frames before the
	 * checkpoint's frame. A later rewind must go to `from` or to a later
	 * checkpoint.
	 */
	discardBefore(from: CompressedCheckpoint): void {
		this.hasher.discardBefore(this.frames.narOffset(from.frame));
	}

	/**
	 * Moves back to `from`. It closes the source, opens it again at the start
	 * of the checkpoint's frame and recompresses the frame up to the
	 * checkpoint. It resolves once those bytes match the first read, and
	 * rejects with `RecompressedNarMismatchError` when they do not. Later reads
	 * return the recompressed bytes and then continue past the position that
	 * the first read reached. The NAR hash returns to its state at the start of
	 * the checkpoint's frame. It rejects with the signal's reason when `signal`
	 * aborts first.
	 */
	async rewind(
		from: CompressedCheckpoint,
		signal?: AbortSignal
	): Promise<void> {
		const until =
			this.replay === undefined &&
			from.position === this.consumed &&
			this.pending !== undefined
				? this.checkpoint()
				: this.tail();
		await abortable(this.close(), signal);
		this.narReached = Math.max(this.narReached, this.reader.position);

		const narStart = this.frames.narOffset(from.frame);
		this.hasher = this.hasher.rewoundTo(narStart);
		this.reader = new NarReader(
			this.source.open(narStart),
			this.frames.narSize,
			narStart,
			this.hasher
		);
		this.events = frameEvents(
			this.reader,
			this.frames,
			from.frame,
			this.options
		)[Symbol.asyncIterator]();
		this.pending = undefined;
		this.isDone = false;
		this.consumed = from.position - from.frameOffset;
		this.lastFrame = from.frame;
		this.replay = {
			frame: from.frame,
			hash: createHash('sha256'),
			until,
			narStart
		};

		while (this.consumed < from.position) {
			await this.read(from.position - this.consumed, signal);
		}

		// A replay that has already reached the first read's position checked
		// these bytes against that position's digest.
		const prefix = this.replayDigest();

		if (prefix !== undefined && prefix !== from.digest) {
			throw new RecompressedNarMismatchError(from.frame, this.consumed);
		}

		this.finishReplayIfReached();
	}

	digest(): NarDigest {
		const digest = this.hasher.digest();

		return { narHash: digest.hash, narSize: digest.size };
	}

	/**
	 * Returns the NAR's compression facts. They are complete once every
	 * compressed byte has been read.
	 */
	compression(): NarCompressionFacts {
		return {
			narBytes: this.hasher.digest().size,
			compressedBytes: this.reached,
			frames: this.records.length,
			compressionMs: this.compressionMs
		};
	}

	/**
	 * Stops compressing and closes the source.
	 */
	async close(): Promise<void> {
		await this.events.return?.();
	}
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

/**
 * The frames of a NAR: one for every 16 MiB, and one for the remainder. A NAR
 * of zero bytes has one empty frame.
 */
export class NarFrames {
	readonly lengths: readonly number[];

	constructor(readonly narSize: number) {
		const whole = Array.from(
			{ length: Math.floor(narSize / frameSize) },
			() => frameSize
		);
		const remainder = narSize % frameSize;

		this.lengths =
			remainder > 0 || whole.length === 0 ? [...whole, remainder] : whole;
	}

	/**
	 * The NAR offset at which the frame numbered `index` starts.
	 */
	narOffset(index: number): number {
		return index * frameSize;
	}

	/**
	 * The largest number of bytes that the frames can compress to.
	 */
	compressedBound(): number {
		return this.lengths.reduce(
			(total, length) => total + zstdCompressBound(length),
			0
		);
	}
}

/**
 * The largest size of a zstd frame that compresses `length` bytes, from
 * `ZSTD_COMPRESSBOUND` in zstd.h.
 */
export function zstdCompressBound(length: number): number {
	const smallInputMargin =
		length < 128 * 1024 ? (128 * 1024 - length) >> 11 : 0;

	return length + Math.floor(length / 256) + smallInputMargin;
}

type FrameEvent =
	| {
			readonly kind: 'chunk';
			readonly frame: number;
			readonly bytes: Uint8Array;
	  }
	| { readonly kind: 'end'; readonly frame: number };

// Compresses the frames from `first` to the last one, and reports the end of
// each frame after its last chunk.
async function* frameEvents(
	reader: NarReader,
	frames: NarFrames,
	first: number,
	options: NarCompressionOptions
): AsyncIterable<FrameEvent> {
	try {
		for (let frame = first; frame < frames.lengths.length; frame += 1) {
			const length = frames.lengths[frame] ?? 0;

			const chunks = compressedFrame(
				reader,
				options.createFrameCompressor(length),
				length
			);

			for await (const bytes of chunks) {
				yield { kind: 'chunk', frame, bytes };
			}

			yield { kind: 'end', frame };
		}

		await reader.expectEnd();
	} finally {
		await reader.close();
	}
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
	// The frame can be closed while a read is in progress, and a destroyed
	// stream emits neither event again.
	if (stream.destroyed) {
		return Promise.resolve();
	}

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

	private total: number;

	/**
	 * Reads `source`, which starts at NAR offset `start`, and hashes every byte
	 * that it reads with `hasher`.
	 */
	constructor(
		source: ByteSource,
		readonly narSize: number,
		start: number,
		private readonly hasher: NarHasher
	) {
		this.total = start;
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
	 * The NAR offset after the bytes read so far.
	 */
	get position(): number {
		return this.total;
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

interface NarHashState {
	readonly hash: Hash;
	readonly size: number;
}

class NarHasher {
	// The hash's state at the start of each frame that it has reached, by NAR
	// offset. A reader never reads across the end of a frame, so each frame
	// starts at the boundary between two updates.
	private readonly frameStarts = new Map<number, NarHashState>();

	// `createHash` can be finalised only once, so the result is cached: a stream
	// whose hash is read more than once (a fake, or a retry) gets the same value.
	private finalised:
		{ readonly hash: NixSha256Hash; readonly size: number } | undefined;

	constructor(
		private readonly hash: Hash = createHash('sha256'),
		private size = 0
	) {}

	update(chunk: Uint8Array): void {
		if (this.size % frameSize === 0 && !this.frameStarts.has(this.size)) {
			this.frameStarts.set(this.size, {
				hash: this.hash.copy(),
				size: this.size
			});
		}

		this.hash.update(chunk);
		this.size += chunk.byteLength;
	}

	/**
	 * Discards the saved states for the frames that start before NAR offset
	 * `offset`.
	 */
	discardBefore(offset: number): void {
		for (const start of this.frameStarts.keys()) {
			if (start < offset) {
				this.frameStarts.delete(start);
			}
		}
	}

	/**
	 * Returns a new hasher in the state that this one had at NAR offset
	 * `offset`, the start of a frame that this one has reached.
	 */
	rewoundTo(offset: number): NarHasher {
		const state = this.frameStarts.get(offset);

		if (state === undefined) {
			throw new NarHashStateMissingError(offset);
		}

		const hasher = new NarHasher(state.hash.copy(), state.size);

		for (const [start, saved] of this.frameStarts) {
			if (start <= offset) {
				hasher.frameStarts.set(start, saved);
			}
		}

		return hasher;
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
