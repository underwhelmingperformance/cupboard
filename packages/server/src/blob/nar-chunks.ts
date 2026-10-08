import {
	hasSubrequestsFor,
	holdSubrequests,
	type SubrequestHold
} from '../do/subrequest-slice.ts';
import {
	StoredObjectInconsistentError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { type R2ObjectKey } from '../http/http.ts';

import {
	type NarReadBufferLease,
	type NarReadBufferPool
} from './nar-read-buffers.ts';

/**
 * The largest chunk that a source returns. The verifier decodes one chunk at a
 * time.
 */
export const narChunkSize = 1024 * 1024;

// A source never keeps more buffers than this, however large the pool is.
const maxRangeBuffersPerSource = 4;

/**
 * Bytes of a stored object, in object order. `bytes` stays valid until
 * `release` is called. Call `release` once every consumer has finished with
 * the bytes; a second call has no effect.
 */
export interface NarChunk {
	readonly bytes: Uint8Array;
	release(): void;
}

/**
 * Returns the bytes of one object as chunks of at most {@link narChunkSize}.
 */
export interface NarChunkSource {
	/**
	 * Resolves with the next chunk, or with `undefined` after the last one. Call
	 * it again only after the previous call has settled.
	 */
	read(): Promise<NarChunk | undefined>;
	/**
	 * Stops every read and returns the source's buffers to their pool. Call it
	 * on every exit, once no consumer uses the chunks any more.
	 */
	close(reason?: unknown): Promise<void>;
}

/**
 * Tracks progress for a stall timeout. `restart` is called whenever a read
 * completes and `stop` once the object has been read. When `signal` aborts,
 * every R2 get and every read of the source stops at once.
 */
export interface ReadWatch {
	readonly signal: AbortSignal;
	restart(): void;
	stop(): void;
}

/**
 * Counts for one stored object's ranged reads.
 */
export interface RangeReadProgress {
	/**
	 * The ranged reads started into a pooled buffer.
	 */
	ranges: number;
	/**
	 * The blocks that found every pooled buffer in use at least once. A block
	 * can still get a range later, when a buffer becomes free first.
	 */
	rangeBufferMisses: number;
	/**
	 * The blocks that found, at least once, that the invocation's subrequest
	 * slice could not cover a ranged get and a later get for the head.
	 */
	rangeBudgetSkips: number;
	/**
	 * The pooled buffers that a cancelled read kept. The pool allocates a new
	 * buffer in place of each one.
	 */
	lostRangeBuffers: number;
	/**
	 * The largest number of pooled buffers that the source kept at once.
	 */
	peakRangeBuffers: number;
}

export interface StoredNarChunksOptions {
	readonly buffers: NarReadBufferPool;
	readonly watch: ReadWatch;
	readonly progress: RangeReadProgress;
	/**
	 * The subrequest that the pass set aside for the first get. The source
	 * releases it just before it makes the get.
	 */
	readonly firstGet?: SubrequestHold;
}

const releaseNothing = (): void => {
	// Head chunks use their own memory, so there is no buffer to return.
};

/**
 * Cancels a body or reader and waits for it, ignoring a rejection. The caller
 * no longer reads the stream, so a stream that has already failed cannot
 * change the outcome.
 */
async function cancelQuietly(cancel: Promise<void>): Promise<void> {
	await Promise.allSettled([cancel]);
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException('The operation was aborted.', 'AbortError')
	);
}

async function cancelObjectBody(
	object: R2ObjectBody | R2Object | null,
	reason: unknown
): Promise<void> {
	if (object === null || !('body' in object)) {
		return;
	}

	await object.body.cancel(reason);
}

/**
 * Waits for an R2 get until `signal` aborts. If the get finishes after the
 * abort, the returned body is cancelled without being read.
 */
async function abortableGet<T extends R2ObjectBody | R2Object | null>(
	get: () => Promise<T>,
	signal: AbortSignal
): Promise<T> {
	signal.throwIfAborted();
	const pending = get();
	const { promise: aborted, reject: rejectAbort } =
		Promise.withResolvers<never>();
	const onAbort = (): void => {
		rejectAbort(abortReason(signal));
	};
	signal.addEventListener('abort', onAbort, { once: true });

	try {
		const object = await Promise.race([pending, aborted]);

		if (signal.aborted) {
			await cancelObjectBody(object, abortReason(signal));
			signal.throwIfAborted();
		}

		return object;
	} catch (error) {
		if (signal.aborted) {
			void pending
				.then((object) => cancelObjectBody(object, abortReason(signal)))
				.catch(() => {
					// The original timeout remains authoritative if the late R2 call fails.
				});
		}

		throw error;
	} finally {
		signal.removeEventListener('abort', onAbort);
	}
}

/**
 * The object that the first get returned. Every later get asks for this ETag,
 * so all parts come from the same object.
 */
interface StoredObject {
	readonly blobs: R2Bucket;
	readonly r2Key: R2ObjectKey;
	readonly etag: string;
	readonly size: number;
}

/**
 * The bytes of a later get: `length` bytes from `offset`, or the rest of the
 * object when `length` is absent.
 */
interface PartRange {
	readonly offset: number;
	readonly length?: number;
}

async function getStoredPart(
	object: StoredObject,
	range: PartRange,
	signal: AbortSignal
): Promise<R2ObjectBody> {
	const part = await abortableGet(
		() =>
			object.blobs.get(object.r2Key, {
				range,
				onlyIf: { etagMatches: object.etag }
			}),
		signal
	);

	// The first get found the object, so a missing object is a change during
	// verification. The next pass decides whether the upload is missing.
	if (part === null) {
		throw new StoredObjectInconsistentError(
			object.r2Key,
			range.offset,
			'deleted'
		);
	}

	if (!('body' in part)) {
		throw new StoredObjectInconsistentError(
			object.r2Key,
			range.offset,
			'etag-changed'
		);
	}

	return part;
}

/**
 * A sequential read of a body from a given offset. Each read allocates a new
 * buffer, because the decoder can still be using the previous chunk while the
 * next read runs.
 */
class SequentialBody {
	private readonly reader: ReadableStreamBYOBReader;
	private position: number;

	constructor(body: ReadableStream, offset: number) {
		this.reader = body.getReader({ mode: 'byob' });
		this.position = offset;
	}

	get offset(): number {
		return this.position;
	}

	async read(size: number): Promise<Uint8Array | undefined> {
		const { done, value } = await this.reader.readAtLeast(
			size,
			new Uint8Array(size)
		);

		if (done) {
			return undefined;
		}

		this.position += value.byteLength;

		return value;
	}

	async cancel(reason?: unknown): Promise<void> {
		await cancelQuietly(this.reader.cancel(reason));
	}
}

/**
 * Returns a body's bytes in chunks of up to {@link narChunkSize}, without a
 * buffer pool.
 */
export class BodyChunks implements NarChunkSource {
	private readonly body: SequentialBody;
	private hasEnded = false;

	constructor(body: ReadableStream) {
		this.body = new SequentialBody(body, 0);
	}

	async read(): Promise<NarChunk | undefined> {
		const bytes = await this.body.read(narChunkSize);

		if (bytes === undefined) {
			this.hasEnded = true;
			return undefined;
		}

		return { bytes, release: releaseNothing };
	}

	async close(reason?: unknown): Promise<void> {
		if (this.hasEnded) {
			return;
		}

		await this.body.cancel(reason);
	}
}

/**
 * One ranged get into a pooled buffer. The range is delivered only once all of
 * its bytes are in the buffer: every BYOB read detaches the buffer that it
 * fills, which would also detach chunks already given to the decoder.
 */
class RangeRead {
	private releasedBytes = 0;
	private isReleased = false;
	readonly filled: Promise<ArrayBuffer>;

	constructor(
		object: StoredObject,
		readonly offset: number,
		readonly length: number,
		private readonly lease: NarReadBufferLease,
		watch: ReadWatch,
		signal: AbortSignal,
		private readonly onReleased: (range: RangeRead, isLost: boolean) => void
	) {
		this.filled = this.fill(object, watch, signal);
		void this.filled.catch(() => {
			// `StoredNarChunks.readRange` or `stop` observes the outcome later.
		});
	}

	private async fill(
		object: StoredObject,
		watch: ReadWatch,
		signal: AbortSignal
	): Promise<ArrayBuffer> {
		const part = await getStoredPart(
			object,
			{ offset: this.offset, length: this.length },
			signal
		);

		if (signal.aborted) {
			await cancelQuietly(part.body.cancel(abortReason(signal)));
			signal.throwIfAborted();
		}

		const reader = part.body.getReader({ mode: 'byob' });
		// A reader cancelled during a read can keep the buffer that the read was
		// given. Only a stall or an outer abort cancels the read in progress. When
		// the source closes for any other reason, `signal` stops the loop after
		// that read, and the read returns the buffer.
		const cancelOnStall = (): void => {
			void cancelQuietly(reader.cancel(abortReason(watch.signal)));
		};
		watch.signal.addEventListener('abort', cancelOnStall, { once: true });

		try {
			let filled = 0;

			while (filled < this.length) {
				signal.throwIfAborted();
				const size = Math.min(narChunkSize, this.length - filled);
				// Read the buffer through views of at most one chunk, because workerd
				// allocates a native buffer of the requested size for every read.
				const { done, value } = await reader.readAtLeast(
					size,
					new Uint8Array(this.lease.buffer, filled, size)
				);

				if (value !== undefined) {
					this.lease.replaceBuffer(value.buffer);
				}

				signal.throwIfAborted();

				if (done) {
					throw new StoredObjectInconsistentError(
						object.r2Key,
						this.offset + filled,
						'truncated'
					);
				}

				filled += value.byteLength;
				watch.restart();
			}

			return this.lease.buffer;
		} finally {
			watch.signal.removeEventListener('abort', cancelOnStall);
			await cancelQuietly(reader.cancel());
		}
	}

	/**
	 * Returns `bytes`, a view of this range's buffer, as a chunk. The buffer goes
	 * back to the pool once every byte of the range has been released.
	 */
	chunk(bytes: Uint8Array): NarChunk {
		let isReleased = false;

		return {
			bytes,
			release: () => {
				if (isReleased) {
					return;
				}

				isReleased = true;
				this.releasedBytes += bytes.byteLength;

				if (this.releasedBytes === this.length) {
					this.release();
				}
			}
		};
	}

	release(): void {
		if (this.isReleased) {
			return;
		}

		this.isReleased = true;
		const isLost = this.lease.buffer.detached;
		this.lease.release();
		this.onReleased(this, isLost);
	}

	/**
	 * Waits for the fill to end, then returns the buffer. The caller has already
	 * aborted the signal that the fill checks between reads.
	 */
	async stop(): Promise<void> {
		await Promise.allSettled([this.filled]);
		this.release();
	}
}

/**
 * Reads a stored object in order. A sequential stream, the head, reads the
 * bytes that are needed next. Before each read, the source starts ranged gets
 * for the following parts of the object into pooled buffers, if the pool has a
 * free buffer and the invocation's subrequest slice can cover the gets. The
 * source never waits for a buffer or for subrequests, so the head always makes
 * progress.
 *
 * Ranges are aligned to the pool's buffer size. When the next byte is in a
 * prefetched range, the source cancels the head and returns that range's
 * buffer in chunks. When the next byte is not prefetched, the head reads it. If
 * the source cancelled the head for an earlier range, it first opens a new head
 * at that byte.
 */
class StoredNarChunks implements NarChunkSource {
	private position = 0;
	private head: SequentialBody | undefined;
	private headGet: SubrequestHold | undefined;
	private readonly ahead: RangeRead[] = [];
	private readonly held = new Set<RangeRead>();
	private missedOffset: number | undefined;
	private skippedOffset: number | undefined;
	private readonly closing = new AbortController();
	private readonly signal: AbortSignal;
	private reading: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly object: StoredObject,
		body: ReadableStream,
		private readonly buffers: NarReadBufferPool,
		private readonly watch: ReadWatch,
		private readonly progress: RangeReadProgress
	) {
		this.head = new SequentialBody(body, 0);
		this.signal = AbortSignal.any([watch.signal, this.closing.signal]);
	}

	private async next(): Promise<NarChunk | undefined> {
		this.signal.throwIfAborted();

		if (this.position === this.object.size) {
			this.watch.stop();
			await this.closeHead();
			return undefined;
		}

		this.prefetch();
		const range = this.ahead[0];

		if (range !== undefined && range.offset <= this.position) {
			await this.closeHead();
			return this.readRange(range);
		}

		return this.readHead();
	}

	private prefetch(): void {
		while (this.held.size < maxRangeBuffersPerSource) {
			const offset = this.nextRangeOffset();

			if (offset >= this.object.size) {
				return;
			}

			// A range needs its own get. If no get is set aside for the head yet,
			// the range also needs one for the head that reads on after it.
			const subrequests = this.headGet === undefined ? 2 : 1;

			if (!hasSubrequestsFor(subrequests)) {
				if (offset !== this.skippedOffset) {
					this.progress.rangeBudgetSkips += 1;
					this.skippedOffset = offset;
				}

				return;
			}

			const lease = this.buffers.tryAcquire();

			if (lease === undefined) {
				if (offset !== this.missedOffset) {
					this.progress.rangeBufferMisses += 1;
					this.missedOffset = offset;
				}

				return;
			}

			const range = new RangeRead(
				this.object,
				offset,
				Math.min(this.buffers.bufferSize, this.object.size - offset),
				lease,
				this.watch,
				this.signal,
				(released, isLost) => {
					this.held.delete(released);
					this.progress.lostRangeBuffers += isLost ? 1 : 0;
				}
			);
			this.headGet ??= holdSubrequests(1);
			this.ahead.push(range);
			this.held.add(range);
			this.progress.ranges += 1;
			this.progress.peakRangeBuffers = Math.max(
				this.progress.peakRangeBuffers,
				this.held.size
			);
		}
	}

	// The head reads the range-sized block that contains `position`, so
	// prefetching starts at the block after it.
	private nextRangeOffset(): number {
		const last = this.ahead.at(-1);

		if (last !== undefined) {
			return last.offset + last.length;
		}

		const blockSize = this.buffers.bufferSize;

		return (Math.floor(this.position / blockSize) + 1) * blockSize;
	}

	private async readRange(range: RangeRead): Promise<NarChunk> {
		const buffer = await range.filled;
		const start = this.position - range.offset;
		const size = Math.min(narChunkSize, range.length - start);
		this.position += size;

		if (start + size === range.length) {
			this.ahead.shift();
		}

		return range.chunk(new Uint8Array(buffer, start, size));
	}

	private async readHead(): Promise<NarChunk> {
		const head =
			this.head?.offset === this.position ? this.head : await this.openHead();
		const end = this.ahead[0]?.offset ?? this.object.size;
		const bytes = await head.read(Math.min(narChunkSize, end - this.position));
		this.signal.throwIfAborted();

		if (bytes === undefined) {
			throw new StoredObjectInconsistentError(
				this.object.r2Key,
				this.position,
				'truncated'
			);
		}

		this.watch.restart();
		this.position += bytes.byteLength;

		return { bytes, release: releaseNothing };
	}

	private async openHead(): Promise<SequentialBody> {
		await this.closeHead();
		this.headGet?.release();
		this.headGet = undefined;
		const part = await getStoredPart(
			this.object,
			{ offset: this.position },
			this.signal
		);
		const head = new SequentialBody(part.body, this.position);
		this.head = head;

		// `close` cannot cancel a head that it runs before, so cancel it here.
		if (this.signal.aborted) {
			await this.closeHead(abortReason(this.signal));
			this.signal.throwIfAborted();
		}

		return head;
	}

	private async closeHead(reason?: unknown): Promise<void> {
		const head = this.head;
		this.head = undefined;
		await head?.cancel(reason);
	}

	read(): Promise<NarChunk | undefined> {
		const next = this.next();
		this.reading = next;

		return next;
	}

	async close(reason?: unknown): Promise<void> {
		this.closing.abort(reason);
		this.headGet?.release();
		this.headGet = undefined;
		await Promise.allSettled([
			this.closeHead(reason),
			...[...this.held].map((range) => range.stop())
		]);
		await Promise.allSettled([this.reading]);
	}
}

/**
 * Fetches a stored object and returns its bytes in order, reading ahead into
 * pooled buffers when they are free. It fails with
 * `UploadedObjectNotFoundError` when the first get finds no object. A later
 * read fails with `StoredObjectInconsistentError` when a later get finds a
 * different object or none, or when a body ends early.
 */
export async function openStoredNarChunks(
	blobs: R2Bucket,
	r2Key: R2ObjectKey,
	{ buffers, watch, progress, firstGet }: StoredNarChunksOptions
): Promise<NarChunkSource> {
	firstGet?.release();
	const object = await abortableGet(() => blobs.get(r2Key), watch.signal);

	if (object === null) {
		throw new UploadedObjectNotFoundError(r2Key);
	}

	return new StoredNarChunks(
		{ blobs, r2Key, etag: object.etag, size: object.size },
		object.body,
		buffers,
		watch,
		progress
	);
}
