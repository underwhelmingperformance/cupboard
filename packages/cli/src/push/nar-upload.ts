import { createHash } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';

import { rootLogger } from '@cupboard/logger';
import type { CommitBlobDeclaration } from '@cupboard/protocol/upload';

import { abortable } from '../abort.ts';
import { asyncChunks } from '../io/byte-stream.ts';
import {
	type CompressedCheckpoint,
	defaultNarCompression,
	FramedNarCompressor,
	type NarCompressionFacts,
	type NarCompressionOptions,
	type NarFrames
} from '../nix/blob.ts';
import type { NarDigest } from '../nix/nar.ts';
import type { NarSource } from '../nix/nar-source.ts';

import { CompressedBlobHasher } from './blob-hash.ts';

const mebibyte = 1024 * 1024;

/**
 * The part size for a NAR that fits in 9,999 parts. R2 accepts parts of 5 MiB
 * or more.
 */
export const minimumPartBytes = 8 * mebibyte;

/**
 * The largest number of parts in one multipart upload, which R2 sets.
 */
export const maxPartsPerUpload = 10_000;

/**
 * The largest number of attempts at one request.
 */
export const maxRequestAttempts = 5;

// R2 resets a request whose body sends no bytes for about 15 seconds. A failed
// attempt whose body had produced nothing for 10 seconds or more is reported
// as an idle timeout.
const idleResetMs = 10_000;

const skippableFrameMagic = 0x18_4d_2a_50;

const skippableFrameHeaderBytes = 8;

const zeros = new Uint8Array(mebibyte);

/**
 * Returns the part size for a NAR: 8 MiB, or more when the largest possible
 * compressed NAR would need more than 9,999 parts. One of R2's 10,000 parts is
 * kept in reserve for the last few bytes of a skippable frame that runs past
 * the end of a part.
 */
export function partSizeFor(frames: NarFrames): number {
	const needed =
		Math.ceil(frames.compressedBound() / (maxPartsPerUpload - 1) / mebibyte) *
		mebibyte;

	return Math.max(minimumPartBytes, needed);
}

/**
 * The object-store requests that an upload makes.
 */
export type ObjectStoreOperation =
	| 'PutObject'
	| 'CreateMultipartUpload'
	| 'UploadPart'
	| 'CompleteMultipartUpload'
	| 'AbortMultipartUpload'
	| 'HeadObject';

/**
 * A request to the object store that failed. `isRetryable` is true when the
 * same request can succeed if it is sent again: the connection failed, or the
 * store returned a server error, timed out or asked the client to slow down.
 * `reason` is the store's error code, or the network error's code. `status` is
 * the HTTP status of the store's response, and is `undefined` when the
 * connection failed before a response arrived.
 */
export class ObjectStoreRequestError extends Error {
	constructor(
		public readonly operation: ObjectStoreOperation,
		public readonly isRetryable: boolean,
		public readonly reason: string,
		public readonly status: number | undefined,
		options?: ErrorOptions
	) {
		super(`${operation} failed: ${reason}`, options);
		this.name = 'ObjectStoreRequestError';
	}
}

/**
 * The size and ETag of a stored object.
 */
export interface StoredObject {
	readonly length: number;
	readonly etag: string;
}

/**
 * Raised when a failed completion request left the upload's outcome unknown
 * and the object at `key` does not have the size and multipart ETag of the
 * parts that were sent. `found` is the object at `key`, or `undefined` when
 * there is none.
 */
export class UnverifiedMultipartUploadError extends Error {
	constructor(
		public readonly key: string,
		public readonly expected: StoredObject,
		public readonly found: StoredObject | undefined
	) {
		super(
			`The multipart upload of ${key} may not have completed: the stored object does not match the parts that were sent`
		);
		this.name = 'UnverifiedMultipartUploadError';
	}
}

/**
 * Returns the ETag, without quotes, of a completed multipart upload whose
 * parts have the given ETags, in part order.
 */
export function multipartEtag(partEtags: readonly string[]): string {
	const digests = partEtags.map((etag) =>
		Buffer.from(unquotedEtag(etag), 'hex')
	);
	const digest = createHash('md5').update(Buffer.concat(digests)).digest('hex');

	return `${digest}-${String(partEtags.length)}`;
}

/**
 * Returns an ETag without the quotes that HTTP puts around it.
 */
export function unquotedEtag(etag: string): string {
	return etag.replaceAll('"', '');
}

export interface UploadedPart {
	readonly partNumber: number;
	readonly etag: string;
}

/**
 * A request body of exactly `length` bytes. `signal` stops the request while
 * it is in progress.
 */
export interface ObjectStoreBody {
	readonly body: AsyncIterable<Uint8Array>;
	readonly length: number;
	readonly signal: AbortSignal;
}

/**
 * The object-store requests that an upload makes. Each request fails with
 * `ObjectStoreRequestError` when the store refuses it or the connection fails.
 */
export interface ObjectStore {
	putObject(key: string, body: ObjectStoreBody): Promise<void>;
	createMultipartUpload(key: string, signal: AbortSignal): Promise<string>;
	uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: ObjectStoreBody
	): Promise<string>;
	completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: readonly UploadedPart[],
		signal: AbortSignal
	): Promise<void>;
	abortMultipartUpload(key: string, uploadId: string): Promise<void>;
	/**
	 * Returns the size and unquoted ETag of the object at `key`, or `undefined`
	 * when there is none.
	 */
	headObject(
		key: string,
		signal: AbortSignal
	): Promise<StoredObject | undefined>;
}

/**
 * How a part's bytes were sent. A `single-request` upload sends the whole
 * object with one `PutObject`. A `buffered` part is compressed into memory
 * before its request starts. A `streamed` part is sent as it is compressed.
 */
export type NarPartMode = 'single-request' | 'buffered' | 'streamed';

export interface NarPartReport {
	readonly partNumber: number;
	readonly mode: NarPartMode;
	readonly bytes: number;
	readonly attempts: number;
	readonly durationMs: number;
	readonly outcome: 'sent' | 'failed';
}

/**
 * The request that a retry report is about: one part of the upload, or a
 * request that sends no part.
 */
export type NarRequestTarget =
	| { readonly kind: 'part'; readonly partNumber: number }
	| {
			readonly kind: 'request';
			readonly operation: Exclude<ObjectStoreOperation, 'UploadPart'>;
	  };

/**
 * A failed attempt that the uploader is about to make again. `reason` is the
 * store's error code, the network error's code, or `idle-timeout` when the
 * body had produced nothing for 10 seconds or more, which is less than R2's
 * limit.
 */
export interface NarRetryReport {
	readonly target: NarRequestTarget;
	readonly attempt: number;
	readonly reason: string;
}

/**
 * A streamed part that was recompressed from the NAR source for another
 * attempt. `narBytes` counts the NAR bytes recompressed, and `compressedBytes`
 * the part's compressed bytes that were recompressed.
 */
export interface NarRecompressionReport {
	readonly partNumber: number;
	readonly reason: string;
	readonly narBytes: number;
	readonly compressedBytes: number;
	readonly durationMs: number;
}

/**
 * A streamed part whose compressed bytes ended before the part did. The
 * uploader filled the rest with a zstd skippable frame of `bytes` bytes.
 * `continuesIntoNextPart` is true when the frame did not fit in the gap and
 * its last bytes formed one more part.
 */
export interface NarPaddingReport {
	readonly partNumber: number;
	readonly bytes: number;
	readonly continuesIntoNextPart: boolean;
}

/**
 * Receives the events of one NAR's upload as they happen.
 */
export interface NarUploadObserver {
	/**
	 * Receives the number of bytes added to the stored object, including
	 * padding. Each byte is counted once.
	 */
	readonly onBytes?: (count: number) => void;
	readonly onPart?: (report: NarPartReport) => void;
	readonly onRetry?: (report: NarRetryReport) => void;
	readonly onRecompression?: (report: NarRecompressionReport) => void;
	readonly onPadding?: (report: NarPaddingReport) => void;
}

/**
 * How one NAR was sent. `resentBytes` counts the bytes sent beyond the size
 * of the stored object: the bytes that failed attempts had already sent.
 */
export interface NarTransferFacts {
	readonly isSingleRequest: boolean;
	readonly bufferedParts: number;
	readonly streamedParts: number;
	readonly retries: number;
	readonly recompressions: number;
	readonly resentBytes: number;
	readonly paddingBytes: number;
}

export interface CompressedNarUpload {
	readonly blob: CommitBlobDeclaration;
	readonly digest: NarDigest;
	readonly compression: NarCompressionFacts;
	readonly transfer: NarTransferFacts;
}

/**
 * Waits after the failed attempt numbered `attempt`.
 */
export type Backoff = (attempt: number, signal: AbortSignal) => Promise<void>;

export interface RequestOptions {
	readonly observer?: NarUploadObserver;
	readonly signal?: AbortSignal;
	/**
	 * The default backoff waits about 0.5 s after the first failed attempt,
	 * then about 1 s, 2 s and 4 s. Each wait is shortened by up to half at
	 * random so that uploads that fail together are unlikely to retry
	 * together.
	 */
	readonly backoff?: Backoff;
	/**
	 * Returns the current time in milliseconds.
	 */
	readonly now?: () => number;
}

export interface NarUploadOptions extends RequestOptions {
	readonly compression?: NarCompressionOptions;
}

/**
 * Compresses a NAR and uploads it to `key`: with one `PutObject` when it
 * compresses to one part or less, and as a multipart upload otherwise.
 *
 * Every part except the last has the same length, which R2 requires. The first
 * part is compressed into memory, and a NAR that ends inside it is sent with
 * one `PutObject` of its exact length. Before each later part, the uploader
 * estimates the compressed bytes that remain from the compression ratio so
 * far. While the estimate is at least two parts, the part is streamed: its
 * request starts with its length fixed, and its body sends the compressed
 * bytes as they are produced. Otherwise the part is compressed into memory
 * first, so a last part has its exact length. If a streamed part's bytes end
 * before the part does, a zstd skippable frame fills the rest of the part.
 *
 * A failed buffered part is sent again from memory. A failed streamed part is
 * recompressed from the NAR source. The bytes that were already sent are
 * checked against the digests that the first read recorded, and the NAR hash
 * describes the NAR that the stored object decodes to. A multipart upload that
 * fails is aborted.
 */
export async function uploadCompressedNar(
	store: ObjectStore,
	key: string,
	source: NarSource,
	narSize: number,
	options: NarUploadOptions = {}
): Promise<CompressedNarUpload> {
	const upload = new NarUpload(store, key, source, narSize, options);
	let result: CompressedNarUpload;

	try {
		result = await upload.run();
	} catch (error) {
		upload.closeInBackground();
		throw error;
	}

	await upload.close();

	return result;
}

/**
 * Uploads `bytes` to `key` with one `PutObject`, sending it again after a
 * failure that another attempt can fix.
 */
export async function uploadBytes(
	store: ObjectStore,
	key: string,
	bytes: Uint8Array,
	options: RequestOptions = {}
): Promise<void> {
	await new RequestSender(options, new TransferCounts()).sendPart(
		1,
		'single-request',
		bytes.byteLength,
		{ chunks: [bytes], length: bytes.byteLength },
		(body) => store.putObject(key, body)
	);
}

interface BufferedBytes {
	readonly chunks: readonly Uint8Array[];
	readonly length: number;
}

/**
 * The body of one attempt at a request. It counts the bytes that it hands to
 * the request and notes when it last produced a chunk. When producing a chunk
 * fails, it aborts the attempt's signal, so the request stops without waiting
 * for the store to reset the connection.
 */
class AttemptBody implements AsyncIterable<Uint8Array> {
	private readonly controller = new AbortController();

	private readonly iterator: AsyncIterator<Uint8Array>;

	private pulling: Promise<unknown> = Promise.resolve();

	private lastProducedAt: number;

	private failure: unknown;

	readonly signal: AbortSignal;

	constructor(
		source: AsyncIterable<Uint8Array>,
		private readonly outer: AbortSignal,
		private readonly now: () => number,
		private readonly onChunk: (bytes: number) => void
	) {
		this.signal = AbortSignal.any([outer, this.controller.signal]);
		this.iterator = source[Symbol.asyncIterator]();
		this.lastProducedAt = now();
	}

	private async pull(): Promise<IteratorResult<Uint8Array>> {
		try {
			const next = await this.iterator.next();

			if (next.done !== true) {
				this.lastProducedAt = this.now();
				this.onChunk(next.value.byteLength);
			}

			return next;
		} catch (error) {
			this.failure = error;
			this.controller.abort(error);
			throw error;
		}
	}

	/**
	 * The error that producing the body raised, if any.
	 */
	get error(): unknown {
		return this.failure;
	}

	/**
	 * How long the body has gone without producing a chunk.
	 */
	idleMs(): number {
		return this.now() - this.lastProducedAt;
	}

	[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
		return {
			next: () => {
				const next = this.pull();
				this.pulling = settled(next);

				return next;
			},
			return: () => {
				this.abandon();

				return Promise.resolve({ done: true, value: undefined });
			}
		};
	}

	/**
	 * Waits for a chunk that is being produced and then stops the body. After
	 * a failed attempt, the request may still be producing a chunk that it will
	 * never send. Waiting for it means that the next attempt starts from where
	 * this one stopped reading. When the upload is cancelled first, it stops
	 * the body without waiting and rejects with the cancellation's reason.
	 */
	async stop(): Promise<void> {
		try {
			await abortable(this.pulling, this.outer);
		} catch (error) {
			this.abandon();
			throw error;
		}

		await this.iterator.return?.();
	}

	/**
	 * Stops the body without waiting for a chunk that is being produced. The
	 * body closes once that chunk arrives, if it ever does. Use it when no
	 * attempt follows, so a stalled source cannot delay the upload's failure.
	 */
	abandon(): void {
		void closeInBackground(this.iterator.return?.());
	}
}

/**
 * Counts how the parts of one upload were sent.
 */
class TransferCounts {
	private bufferedParts = 0;

	private streamedParts = 0;

	private retries = 0;

	private recompressions = 0;

	private handedBytes = 0;

	private paddingBytes = 0;

	countPart(mode: 'buffered' | 'streamed'): void {
		if (mode === 'buffered') {
			this.bufferedParts += 1;
			return;
		}

		this.streamedParts += 1;
	}

	countRetry(): void {
		this.retries += 1;
	}

	countRecompression(): void {
		this.recompressions += 1;
	}

	countHanded(bytes: number): void {
		this.handedBytes += bytes;
	}

	countPadding(bytes: number): void {
		this.paddingBytes += bytes;
	}

	facts(isSingleRequest: boolean, storedBytes: number): NarTransferFacts {
		return {
			isSingleRequest,
			bufferedParts: this.bufferedParts,
			streamedParts: this.streamedParts,
			retries: this.retries,
			recompressions: this.recompressions,
			resentBytes: Math.max(0, this.handedBytes - storedBytes),
			paddingBytes: this.paddingBytes
		};
	}
}

/**
 * Sends requests to the object store, and sends a request again after a
 * failure that another attempt can fix.
 */
class RequestSender {
	private readonly backoff: Backoff;

	readonly observer: NarUploadObserver;

	readonly signal: AbortSignal;

	readonly now: () => number;

	constructor(
		options: RequestOptions,
		private readonly counts: TransferCounts
	) {
		this.observer = options.observer ?? {};
		this.signal = options.signal ?? new AbortController().signal;
		this.now = options.now ?? (() => performance.now());
		this.backoff = options.backoff ?? defaultBackoff;
	}

	private async attemptPart<T>(
		partNumber: number,
		length: number,
		body:
			| BufferedBytes
			| ((failure: string | undefined) => Promise<AsyncIterable<Uint8Array>>),
		send: (body: ObjectStoreBody) => Promise<T>,
		onAttempt: (attempt: number) => void
	): Promise<T> {
		let failure: string | undefined;

		for (let attempt = 1; ; attempt += 1) {
			onAttempt(attempt);
			const source =
				typeof body === 'function'
					? await body(failure)
					: asyncChunks(body.chunks);
			const attemptBody = new AttemptBody(
				source,
				this.signal,
				this.now,
				(bytes) => {
					this.counts.countHanded(bytes);
				}
			);

			try {
				return await send({
					body: attemptBody,
					length,
					signal: attemptBody.signal
				});
			} catch (error) {
				// Classify the failure before stopping the body. Stopping waits for
				// a chunk in progress, which can arrive long after the store reset
				// the request and would make a stalled body look busy.
				const idleMs = attemptBody.idleMs();
				const cause: unknown = this.signal.aborted
					? this.signal.reason
					: (attemptBody.error ?? error);

				if (
					attempt >= maxRequestAttempts ||
					!(cause instanceof ObjectStoreRequestError) ||
					!cause.isRetryable
				) {
					attemptBody.abandon();
					throw cause;
				}

				failure = idleMs >= idleResetMs ? 'idle-timeout' : cause.reason;
				this.retried({ kind: 'part', partNumber }, attempt, failure);
				await attemptBody.stop();
				await this.wait(attempt);
			}
		}
	}

	/**
	 * Waits before the next attempt. When the upload is cancelled during the
	 * wait, it rejects with the cancellation's reason.
	 */
	async wait(attempt: number): Promise<void> {
		try {
			await this.backoff(attempt, this.signal);
		} catch (error) {
			this.signal.throwIfAborted();
			throw error;
		}
	}

	/**
	 * Sends one part, or the single request, until it succeeds, it fails with
	 * an error that another attempt cannot fix, or the attempts run out. `body`
	 * returns the bytes of an attempt, given the reason that the previous
	 * attempt failed.
	 */
	async sendPart<T>(
		partNumber: number,
		mode: NarPartMode,
		length: number,
		body:
			| BufferedBytes
			| ((failure: string | undefined) => Promise<AsyncIterable<Uint8Array>>),
		send: (body: ObjectStoreBody) => Promise<T>
	): Promise<T> {
		const startedAt = this.now();
		let attempt = 1;
		const report = (outcome: 'sent' | 'failed'): void => {
			this.observer.onPart?.({
				partNumber,
				mode,
				bytes: length,
				attempts: attempt,
				durationMs: this.now() - startedAt,
				outcome
			});
		};

		try {
			const result = await this.attemptPart(
				partNumber,
				length,
				body,
				send,
				(next) => {
					attempt = next;
				}
			);
			report('sent');

			return result;
		} catch (error) {
			report('failed');
			throw error;
		}
	}

	/**
	 * Sends a request that has no body of NAR bytes, such as creating the
	 * multipart upload or reading the object, and sends it again like a part.
	 */
	async request<T>(
		operation: Exclude<ObjectStoreOperation, 'UploadPart'>,
		send: (signal: AbortSignal) => Promise<T>
	): Promise<T> {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await send(this.signal);
			} catch (error) {
				this.signal.throwIfAborted();

				if (
					attempt >= maxRequestAttempts ||
					!(error instanceof ObjectStoreRequestError) ||
					!error.isRetryable
				) {
					throw error;
				}

				this.retried({ kind: 'request', operation }, attempt, error.reason);
				await this.wait(attempt);
			}
		}
	}

	retried(target: NarRequestTarget, attempt: number, reason: string): void {
		this.counts.countRetry();
		this.observer.onRetry?.({ target, attempt, reason });
	}
}

/**
 * The skippable frame that fills the end of a part. `gap` of its bytes are in
 * that part, and the rest of the frame is the last part.
 */
interface Padding {
	readonly partNumber: number;
	readonly gap: number;
	readonly header: Uint8Array;
}

/**
 * A recompression that has started and not yet reached the position that the
 * first read reached.
 */
interface Recompression {
	readonly reason: string;
	readonly startedAt: number;
	readonly compressedBytes: number;
}

class NarUpload {
	private readonly blobHasher = new CompressedBlobHasher();

	private readonly compressor: FramedNarCompressor;

	private readonly partSize: number;

	private readonly counts = new TransferCounts();

	private readonly sender: RequestSender;

	private padding: Padding | undefined;

	private recompression: Recompression | undefined;

	private storedBytes = 0;

	constructor(
		private readonly store: ObjectStore,
		private readonly key: string,
		source: NarSource,
		narSize: number,
		options: NarUploadOptions
	) {
		this.compressor = new FramedNarCompressor(
			source,
			narSize,
			options.compression ?? defaultNarCompression
		);
		this.partSize = partSizeFor(this.compressor.frames);
		this.sender = new RequestSender(options, this.counts);
	}

	private get signal(): AbortSignal {
		return this.sender.signal;
	}

	private get observer(): NarUploadObserver {
		return this.sender.observer;
	}

	private result(isSingleRequest: boolean): CompressedNarUpload {
		return {
			digest: this.compressor.digest(),
			blob: this.blobHasher.declaration(),
			compression: this.compressor.compression(),
			transfer: this.counts.facts(isSingleRequest, this.storedBytes)
		};
	}

	// Sends the parts. The first part's buffer is released once it is sent, so
	// at most one buffered part is kept at a time.
	private async sendParts(
		uploadId: string,
		first: { part: BufferedBytes | undefined }
	): Promise<UploadedPart[]> {
		const parts = [
			await this.sendBuffered(uploadId, 1, first.part ?? emptyBuffer)
		];
		first.part = undefined;

		for (let partNumber = 2; ; partNumber += 1) {
			const overflow = this.padding?.header.subarray(this.padding.gap);

			if (overflow !== undefined && overflow.byteLength > 0) {
				parts.push(
					await this.sendBuffered(uploadId, partNumber, {
						chunks: [overflow],
						length: overflow.byteLength
					})
				);
				break;
			}

			if (!(await this.compressor.hasMore(this.signal))) {
				break;
			}

			parts.push(
				this.compressor.estimateRemaining() >= 2 * this.partSize
					? await this.sendStreamed(uploadId, partNumber)
					: await this.sendBuffered(uploadId, partNumber, await this.fill())
			);
		}

		return parts;
	}

	// Compresses up to one part into memory.
	private async fill(): Promise<BufferedBytes> {
		const chunks: Uint8Array[] = [];
		let length = 0;

		while (length < this.partSize) {
			const chunk = await this.compressor.read(
				this.partSize - length,
				this.signal
			);

			if (chunk === undefined) {
				break;
			}

			this.blobHasher.update(chunk);
			this.addStored(chunk.byteLength);
			chunks.push(chunk);
			length += chunk.byteLength;
		}

		return { chunks, length };
	}

	private async sendBuffered(
		uploadId: string,
		partNumber: number,
		buffer: BufferedBytes
	): Promise<UploadedPart> {
		this.counts.countPart('buffered');
		const etag = await this.sender.sendPart(
			partNumber,
			'buffered',
			buffer.length,
			buffer,
			(body) => this.store.uploadPart(this.key, uploadId, partNumber, body)
		);

		return { partNumber, etag };
	}

	private async sendStreamed(
		uploadId: string,
		partNumber: number
	): Promise<UploadedPart> {
		this.counts.countPart('streamed');
		const start = this.compressor.checkpoint();
		this.compressor.discardBefore(start);
		const etag = await this.sender.sendPart(
			partNumber,
			'streamed',
			this.partSize,
			async (failure) => {
				if (failure !== undefined) {
					await this.rewind(start, failure);
				}

				return this.streamedBody(partNumber, start);
			},
			(body) => this.store.uploadPart(this.key, uploadId, partNumber, body)
		);

		return { partNumber, etag };
	}

	// Moves the compressor back to the start of a part for another attempt,
	// when the failed attempt had read past it.
	private async rewind(
		start: CompressedCheckpoint,
		reason: string
	): Promise<void> {
		if (this.compressor.position <= start.position) {
			return;
		}

		const startedAt = this.sender.now();
		const compressedBytes = this.compressor.reachedPosition - start.position;
		await this.compressor.rewind(start, this.signal);
		this.counts.countRecompression();
		this.recompression = { reason, startedAt, compressedBytes };
	}

	// Yields a streamed part: the compressed bytes up to the end of the part,
	// then a skippable frame if the compressed NAR ends before the part does.
	// After a rewind, the first bytes are recompressed.
	private async *streamedBody(
		partNumber: number,
		start: CompressedCheckpoint
	): AsyncIterable<Uint8Array> {
		const end = start.position + this.partSize;

		while (this.compressor.position < end) {
			const isFirstRead = !this.compressor.isReplaying;
			const chunk = await this.compressor.read(
				end - this.compressor.position,
				this.signal
			);

			if (chunk === undefined) {
				break;
			}

			if (isFirstRead) {
				this.blobHasher.update(chunk);
				this.addStored(chunk.byteLength);
			}

			if (this.recompression !== undefined && !this.compressor.isReplaying) {
				this.reportRecompression(partNumber, this.recompression);
				this.recompression = undefined;
			}

			yield chunk;
		}

		const gap = end - this.compressor.position;

		if (gap > 0) {
			yield* this.paddingBytes(this.padTo(partNumber, gap));
		}
	}

	private reportRecompression(
		partNumber: number,
		recompression: Recompression
	): void {
		this.observer.onRecompression?.({
			partNumber,
			reason: recompression.reason,
			narBytes: this.compressor.lastReplayNarBytes,
			compressedBytes: recompression.compressedBytes,
			durationMs: this.sender.now() - recompression.startedAt
		});
	}

	// Records the skippable frame that fills the end of the part. A skippable
	// frame has at least 8 bytes, so when the gap is smaller, the rest of the
	// frame becomes the last part.
	private padTo(partNumber: number, gap: number): Padding {
		if (this.padding !== undefined) {
			return this.padding;
		}

		const frameBytes = Math.max(gap, skippableFrameHeaderBytes);
		const header = new Uint8Array(skippableFrameHeaderBytes);
		const view = new DataView(header.buffer);
		view.setUint32(0, skippableFrameMagic, true);
		view.setUint32(4, frameBytes - skippableFrameHeaderBytes, true);
		this.padding = { partNumber, gap, header };
		this.blobHasher.update(header);

		for (
			let remaining = frameBytes - skippableFrameHeaderBytes;
			remaining > 0;
			remaining -= zeros.byteLength
		) {
			this.blobHasher.update(
				zeros.subarray(0, Math.min(remaining, zeros.byteLength))
			);
		}

		this.counts.countPadding(frameBytes);
		this.addStored(frameBytes);
		this.observer.onPadding?.({
			partNumber,
			bytes: frameBytes,
			continuesIntoNextPart: gap < skippableFrameHeaderBytes
		});

		return this.padding;
	}

	private *paddingBytes(padding: Padding): Iterable<Uint8Array> {
		yield padding.header.subarray(0, padding.gap);

		for (
			let remaining = padding.gap - skippableFrameHeaderBytes;
			remaining > 0;
			remaining -= zeros.byteLength
		) {
			yield zeros.subarray(0, Math.min(remaining, zeros.byteLength));
		}
	}

	// Completes the upload. When an attempt fails in a way that leaves its
	// outcome unknown, the upload may have completed anyway, and the next
	// attempt then fails with `NoSuchUpload`. The upload counts as complete only
	// if the stored object has the size and the multipart ETag of the parts
	// that were sent.
	private async complete(
		uploadId: string,
		parts: readonly UploadedPart[]
	): Promise<void> {
		let isOutcomeUnknown = false;

		for (let attempt = 1; ; attempt += 1) {
			try {
				await this.store.completeMultipartUpload(
					this.key,
					uploadId,
					parts,
					this.signal
				);
				return;
			} catch (error) {
				this.signal.throwIfAborted();

				if (!(error instanceof ObjectStoreRequestError)) {
					throw error;
				}

				if (isOutcomeUnknown && error.reason === 'NoSuchUpload') {
					await this.verifyCompleted(parts);
					return;
				}

				if (attempt >= maxRequestAttempts || !error.isRetryable) {
					throw error;
				}

				isOutcomeUnknown = true;
				this.sender.retried(
					{ kind: 'request', operation: 'CompleteMultipartUpload' },
					attempt,
					error.reason
				);
				await this.sender.wait(attempt);
			}
		}
	}

	private async verifyCompleted(parts: readonly UploadedPart[]): Promise<void> {
		const expected: StoredObject = {
			length: this.storedBytes,
			etag: multipartEtag(parts.map((part) => part.etag))
		};
		const found = await this.sender.request('HeadObject', (signal) =>
			this.store.headObject(this.key, signal)
		);

		if (
			found?.length === expected.length &&
			unquotedEtag(found.etag) === expected.etag
		) {
			return;
		}

		throw new UnverifiedMultipartUploadError(this.key, expected, found);
	}

	private async abort(uploadId: string): Promise<void> {
		try {
			await this.store.abortMultipartUpload(this.key, uploadId);
		} catch {
			// The upload has already failed, and the caller reports that error. R2
			// removes an incomplete multipart upload after seven days.
		}
	}

	private addStored(count: number): void {
		this.storedBytes += count;
		this.observer.onBytes?.(count);
	}

	async run(): Promise<CompressedNarUpload> {
		this.signal.throwIfAborted();
		const first: { part: BufferedBytes | undefined } = {
			part: await this.fill()
		};

		if (!(await this.compressor.hasMore(this.signal))) {
			const single = first.part ?? emptyBuffer;
			await this.sender.sendPart(
				1,
				'single-request',
				single.length,
				single,
				(body) => this.store.putObject(this.key, body)
			);

			return this.result(true);
		}

		const uploadId = await this.sender.request(
			'CreateMultipartUpload',
			(signal) => this.store.createMultipartUpload(this.key, signal)
		);

		try {
			const parts = await this.sendParts(uploadId, first);
			await this.complete(uploadId, parts);
		} catch (error) {
			await this.abort(uploadId);
			throw error;
		}

		return this.result(false);
	}

	async close(): Promise<void> {
		await this.compressor.close();
	}

	/**
	 * Closes the compressor and its source without waiting for them. A source
	 * that has stalled closes once its read returns, if it ever does.
	 */
	closeInBackground(): void {
		void closeInBackground(this.compressor.close());
	}
}

const emptyBuffer: BufferedBytes = { chunks: [], length: 0 };

const logger = rootLogger().getChild('upload');

// Waits for a body or a source to close after its upload has stopped. Its
// error, if any, arrives after the upload has failed with its own error, so it
// is only logged.
async function closeInBackground(
	closing: Promise<unknown> | undefined
): Promise<void> {
	try {
		await closing;
	} catch (error) {
		logger.debug('A NAR source failed while it closed: {error}', { error });
	}
}

// Resolves once `operation` settles, whether it succeeds or fails.
async function settled(operation: Promise<unknown>): Promise<void> {
	try {
		await operation;
	} catch {
		// The caller of `operation` handles its failure.
	}
}

async function defaultBackoff(
	attempt: number,
	signal: AbortSignal
): Promise<void> {
	const delayMs = 250 * 2 ** attempt;

	await sleepFor(delayMs * (0.5 + Math.random() / 2), undefined, { signal });
}
