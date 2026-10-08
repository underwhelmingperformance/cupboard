import { ZstdDecodeError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { ZstdDecoder } from '@cupboard/nix-store/zstd';

import { type SubrequestHold } from '../do/subrequest-slice.ts';
import { raceVerificationOperation } from '../do/verification-claim-lease.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { type R2ObjectKey, verifiableMaxBytes } from '../http/http.ts';

import { type R2ObjectStore } from './connection-limited-bucket.ts';
import {
	BodyChunks,
	type NarChunk,
	narChunkSize,
	type NarChunkSource,
	openStoredNarChunks,
	type RangeReadProgress
} from './nar-chunks.ts';
import { type NarReadBufferPool } from './nar-read-buffers.ts';
import { isR2BadDigest } from './r2-errors.ts';

/**
 * How long verification may go without completing a read of the stored NAR,
 * from any of its R2 gets, before it fails with
 * `SubrequestTimeoutError('nar.verify')`.
 */
const narVerifyStallMs = 60 * 1000;

/**
 * The stall interval while verification also writes the canonical object. R2
 * fails a streamed put whose body receives no bytes for 75 seconds, and keeps
 * one open across a 60-second gap. A chunk from a ranged read reaches the put
 * only after the whole range has arrived, so reads can complete while the put
 * receives nothing. Verification therefore fails when the put receives no
 * bytes for this interval, as well as when no read completes for it. The
 * interval also bounds the work after the last read and R2's answer to the put.
 */
const canonicalWriteStallMs = 30 * 1000;

// libzstd allocates the decoding window outside the isolate's memory limit.
// Without a maximum window log, a frame header can make libzstd allocate
// 128 MiB. The CLI compresses at zstd's default level, which uses a window log
// of 21 for inputs over 256 KiB.
const maxWindowLog = 23;

/**
 * Verification accepts decompressed bytes only when both values match the
 * corresponding narinfo fields.
 */
export interface ExpectedNar {
	readonly narHash: string;
	readonly narSize: number;
}

export type NarVerification =
	| {
			readonly ok: true;
			// Byte verification reports these values. A reuse verdict omits them and
			// uses the existing blob-state metadata.
			readonly fileHash?: NixSha256HashString;
			readonly fileSize?: number;
	  }
	| {
			readonly ok: false;
			readonly reason: 'nar-hash-mismatch';
			readonly actualNarHash: string;
	  }
	| {
			readonly ok: false;
			readonly reason: 'nar-size-mismatch';
			readonly actualNarSize: number;
	  }
	| { readonly ok: false; readonly reason: 'undecodable' };

/**
 * The staged object differs from the client's declaration of the compressed
 * file.
 */
export type DeclarationMismatch =
	| {
			readonly ok: false;
			readonly reason: 'file-size-mismatch';
			readonly actualFileSize: number;
	  }
	| { readonly ok: false; readonly reason: 'file-hash-mismatch' };

/**
 * The result of verification that also writes a declared upload's canonical
 * object.
 */
export type DeclaredNarVerification = NarVerification | DeclarationMismatch;

type NarMismatch = Extract<NarVerification, { readonly ok: false }>;

type DecodeHalt = Extract<
	NarVerification,
	{ readonly reason: 'nar-size-mismatch' | 'undecodable' }
>;

const undecodable: DecodeHalt = { ok: false, reason: 'undecodable' };

/**
 * The step that a verification is performing: fetching the object from R2,
 * waiting for a read of its body, or decoding the bytes read so far.
 */
export type NarVerifyStage = 'fetch' | 'read' | 'decode';

/**
 * The work that one verification has done so far. The verifier updates this
 * object during verification, so the caller can still read the counts and the
 * last stage after verification throws.
 */
export interface NarVerifyProgress extends RangeReadProgress {
	stage: NarVerifyStage;
	reads: number;
	compressedBytes: number;
	narBytes: number;
}

export function narVerifyProgress(): NarVerifyProgress {
	return {
		stage: 'fetch',
		reads: 0,
		compressedBytes: 0,
		narBytes: 0,
		ranges: 0,
		rangeBufferMisses: 0,
		rangeBudgetSkips: 0,
		lostRangeBuffers: 0,
		peakRangeBuffers: 0
	};
}

export interface NarVerifyOptions {
	readonly progress?: NarVerifyProgress;
}

export interface StoredNarVerifyOptions extends NarVerifyOptions {
	/**
	 * The buffers for reading parts of the object ahead of the decoder.
	 */
	readonly buffers: NarReadBufferPool;
	/**
	 * The subrequest that the pass set aside for the first get. The verifier
	 * releases it just before it makes the get.
	 */
	readonly firstGet?: SubrequestHold;
	/**
	 * Stops verification, for example when the verification pass ends.
	 */
	readonly signal?: AbortSignal;
	readonly stallMs?: number;
}

const verificationRejected = (): DOMException =>
	new DOMException('The staged NAR failed verification.', 'AbortError');

/**
 * Receives each compressed chunk that verification reads, in order, and
 * produces the result once the NAR has passed verification. `write` calls
 * `release` once the sink no longer reads `bytes`, which can be after `write`
 * resolves. `finish` is called only after every chunk has been decoded and the
 * NAR matched; `abort` is called on every other exit.
 */
interface CompressedSink<Result> {
	write(bytes: Uint8Array, release: () => void): Promise<void>;
	finish(): Promise<Result>;
	abort(reason: unknown): Promise<void>;
}

/**
 * A running SHA-256 of the bytes written to it.
 */
class Sha256Stream {
	private readonly stream = new crypto.DigestStream('SHA-256');
	private readonly writer = this.stream.getWriter();

	write(chunk: Uint8Array): Promise<void> {
		return this.writer.write(chunk);
	}

	async digest(): Promise<NixSha256Hash> {
		await this.writer.close();

		return NixSha256Hash.fromDigest(new Uint8Array(await this.stream.digest));
	}

	async abort(): Promise<void> {
		await Promise.allSettled([this.writer.abort(), this.stream.digest]);
	}
}

type HashedFile = Extract<NarVerification, { readonly ok: true }>;

// Hashes and measures the compressed bytes, so a successful verification also
// reports the object's file hash and size.
class FileHashSink implements CompressedSink<HashedFile> {
	private readonly hash = new Sha256Stream();
	private size = 0;

	async write(bytes: Uint8Array, release: () => void): Promise<void> {
		this.size += bytes.byteLength;
		await this.hash.write(bytes);
		release();
	}

	async finish(): Promise<HashedFile> {
		const digest = await this.hash.digest();

		return { ok: true, fileHash: digest.value, fileSize: this.size };
	}

	abort(): Promise<void> {
		return this.hash.abort();
	}
}

async function decoded(
	operation: Promise<void>
): Promise<DecodeHalt | undefined> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof ZstdDecodeError) {
			return undecodable;
		}

		throw error;
	}
}

/**
 * Decompresses zstd frames and hashes the output, stopping as soon as the
 * output exceeds `limit` bytes.
 */
class NarDecoder {
	private readonly hash = new Sha256Stream();
	private readonly halted = Promise.withResolvers<DecodeHalt>();
	private readonly zstd: ZstdDecoder;

	constructor(
		private readonly limit: number,
		private readonly progress: NarVerifyProgress
	) {
		this.zstd = new ZstdDecoder({
			chunkSize: narChunkSize,
			windowLogMax: maxWindowLog,
			onOutput: (chunk) => this.accept(chunk)
		});
	}

	private accept(chunk: Uint8Array): Promise<void> | undefined {
		this.progress.narBytes += chunk.byteLength;

		if (this.progress.narBytes > this.limit) {
			this.halted.resolve({
				ok: false,
				reason: 'nar-size-mismatch',
				actualNarSize: this.progress.narBytes
			});
			this.zstd.destroy();
			return undefined;
		}

		return this.hash.write(chunk);
	}

	/**
	 * Resolves when the decoder has consumed the whole chunk, or with the
	 * verdict that stopped decoding.
	 */
	write(chunk: Uint8Array): Promise<DecodeHalt | undefined> {
		return Promise.race([this.halted.promise, decoded(this.zstd.write(chunk))]);
	}

	/**
	 * Resolves when the decoder has hashed all of its output, or with the
	 * verdict that stopped decoding.
	 */
	end(): Promise<DecodeHalt | undefined> {
		return Promise.race([this.halted.promise, decoded(this.zstd.end())]);
	}

	async narHash(): Promise<string> {
		const digest = await this.hash.digest();

		return digest.toString();
	}

	async destroy(): Promise<void> {
		this.zstd.destroy();
		await this.hash.abort();
	}
}

/**
 * Provides a signal that aborts with the outer signal's reason, or with
 * `SubrequestTimeoutError('nar.verify')` when nothing restarts the watchdog for
 * `stallMs`.
 */
class StallWatchdog {
	private readonly controller = new AbortController();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly onOuterAbort = (): void => {
		this.controller.abort(this.outer?.reason);
	};

	constructor(
		private readonly stallMs: number,
		private readonly outer?: AbortSignal
	) {
		if (outer?.aborted === true) {
			this.onOuterAbort();
			return;
		}

		outer?.addEventListener('abort', this.onOuterAbort, { once: true });
		this.restart();
	}

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/**
	 * Starts a new stall interval after the source makes progress.
	 */
	restart(): void {
		clearTimeout(this.timer);

		if (this.signal.aborted) {
			return;
		}

		this.timer = setTimeout(() => {
			this.controller.abort(new SubrequestTimeoutError('nar.verify'));
		}, this.stallMs);
	}

	stop(): void {
		clearTimeout(this.timer);
	}

	dispose(): void {
		clearTimeout(this.timer);
		this.outer?.removeEventListener('abort', this.onOuterAbort);
	}
}

/**
 * Starts reading the next chunk. The verifier awaits the read only after it has
 * decoded the previous chunk, so a rejection is marked as handled until then.
 */
function readAhead(source: NarChunkSource): Promise<NarChunk | undefined> {
	const read = source.read();
	void read.catch(() => {
		// Observed when awaited.
	});

	return read;
}

// Releases a chunk once each of `holders` has released it.
function sharedRelease(chunk: NarChunk, holders: number): () => void {
	let remaining = holders;

	return () => {
		remaining -= 1;

		if (remaining === 0) {
			chunk.release();
		}
	};
}

async function verifyNarChunks<Result>(
	source: NarChunkSource,
	expected: ExpectedNar,
	progress: NarVerifyProgress,
	sink: CompressedSink<Result>,
	watchdog?: StallWatchdog
): Promise<Result | NarMismatch> {
	const signal = watchdog?.signal;
	// Stop after the declared size or the server limit, whichever is smaller. A
	// highly expanding frame cannot make this pass process an unbounded NAR.
	const decoder = new NarDecoder(
		Math.min(expected.narSize, verifiableMaxBytes),
		progress
	);
	let next = readAhead(source);
	let isDecoded = false;
	let isFinished = false;

	try {
		for (;;) {
			progress.stage = 'read';
			const chunk = await raceVerificationOperation(next, signal);

			if (chunk === undefined) {
				break;
			}

			// Start the next read before decoding, so the wait for R2 overlaps the
			// decoding work.
			next = readAhead(source);
			progress.reads += 1;
			progress.compressedBytes += chunk.bytes.byteLength;
			progress.stage = 'decode';
			const release = sharedRelease(chunk, 2);
			const [, halt] = await raceVerificationOperation(
				Promise.all([
					sink.write(chunk.bytes, release),
					decoder.write(chunk.bytes)
				]),
				signal
			);

			if (halt !== undefined) {
				return halt;
			}

			release();
		}

		progress.stage = 'decode';
		const halt = await raceVerificationOperation(decoder.end(), signal);

		if (halt !== undefined) {
			return halt;
		}

		isDecoded = true;
		const actualNarHash = await decoder.narHash();

		if (actualNarHash !== expected.narHash) {
			return { ok: false, reason: 'nar-hash-mismatch', actualNarHash };
		}

		if (progress.narBytes !== expected.narSize) {
			return {
				ok: false,
				reason: 'nar-size-mismatch',
				actualNarSize: progress.narBytes
			};
		}

		// The sink can still be using the source's buffers, so it finishes before
		// the source returns them.
		const result = await raceVerificationOperation(sink.finish(), signal);
		isFinished = true;

		return result;
	} finally {
		// Stop the decoder and the sink before the source returns its buffers.
		// Another verification can detach a buffer as soon as it is back in the
		// pool.
		const reason: unknown = signal?.reason ?? verificationRejected();
		await Promise.allSettled([
			...(isDecoded ? [] : [decoder.destroy()]),
			...(isFinished ? [] : [sink.abort(reason)])
		]);
		await Promise.allSettled([source.close(signal?.reason), next]);
	}
}

/**
 * Reads a stored `.nar.zst` body in 1 MiB pieces, decompresses it with native
 * zstd and hashes the output, then compares the NAR hash and size with what the
 * narinfo declares. The same pass hashes and counts the compressed input, so
 * successful verification also yields the object's file hash and size without
 * fetching the object again. Verification stops reading once the decompressed
 * data exceeds the declared size or the server limit, and on every early exit
 * it cancels the body.
 *
 * When the bytes do not decode, it returns
 * `{ ok: false, reason: 'undecodable' }`. An error from reading the body
 * propagates for the caller to treat as transient.
 */
export async function verifyDecompressedNar(
	body: ReadableStream,
	expected: ExpectedNar,
	{ progress = narVerifyProgress() }: NarVerifyOptions = {}
): Promise<NarVerification> {
	return verifyNarChunks(
		new BodyChunks(body),
		expected,
		progress,
		new FileHashSink()
	);
}

/**
 * Fetches and verifies one staged NAR. While the decoder works through one part
 * of the object, ranged gets read later parts into buffers from `buffers`; see
 * `openStoredNarChunks`. It fails with `SubrequestTimeoutError('nar.verify')`
 * when no read of the object completes for `stallMs`, from the head or from any
 * ranged get. When the outer signal aborts, it cancels every body and rejects
 * with the signal's reason. If an R2 get finishes after a timeout or an abort,
 * the verifier cancels the returned body without decoding it.
 */
export async function verifyStoredNar(
	blobs: R2ObjectStore,
	r2Key: R2ObjectKey,
	expected: ExpectedNar,
	{
		buffers,
		firstGet,
		signal: outerSignal,
		stallMs = narVerifyStallMs,
		progress = narVerifyProgress()
	}: StoredNarVerifyOptions
): Promise<NarVerification> {
	const watchdog = new StallWatchdog(stallMs, outerSignal);

	try {
		progress.stage = 'fetch';
		const source = await openStoredNarChunks(blobs, r2Key, {
			buffers,
			watch: watchdog,
			progress,
			firstGet
		});
		const verification = await verifyNarChunks(
			source,
			expected,
			progress,
			new FileHashSink(),
			watchdog
		);
		watchdog.signal.throwIfAborted();

		return verification;
	} finally {
		watchdog.dispose();
	}
}

/**
 * Where to write a declared upload's canonical object, and the client's
 * declaration of the compressed file.
 */
export interface CanonicalWriteTarget {
	readonly key: R2ObjectKey;
	readonly fileHash: NixSha256HashString;
	readonly fileSize: number;
}

export interface CanonicalWriteOptions extends StoredNarVerifyOptions {
	/**
	 * The subrequest that the pass set aside for the canonical put. The writer
	 * releases it just before it makes the put.
	 */
	readonly canonicalPut?: SubrequestHold;
}

type PutResult =
	| { readonly kind: 'stored' }
	| { readonly kind: 'existing' }
	| { readonly kind: 'failed'; readonly error: unknown };

async function putResult(put: Promise<R2Object | null>): Promise<PutResult> {
	try {
		return { kind: (await put) === null ? 'existing' : 'stored' };
	} catch (error) {
		return { kind: 'failed', error };
	}
}

// Resolves once R2 has read the bytes of the stream `operation`, and then
// calls `onTaken`, or resolves once the stream has failed. The put reports why
// the stream failed.
async function streamSettled(
	operation: Promise<void>,
	onTaken?: () => void
): Promise<void> {
	try {
		await operation;
	} catch {
		return;
	}

	onTaken?.();
}

interface HeldChunk {
	readonly bytes: Uint8Array;
	readonly release: () => void;
}

/**
 * Streams the staged bytes into a conditional put of the canonical object. R2
 * checks the body against the declared SHA-256. The writer keeps back the
 * final chunk until verification accepts the NAR. Until then the body is
 * incomplete, so R2 cannot store a new object. An abort prevents an unfinished
 * put from completing; an existing or completed object can remain at the key.
 * A chunk is released only once the put no longer reads it.
 */
class CanonicalWriter implements CompressedSink<DeclaredNarVerification> {
	private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	private readonly put: Promise<PutResult>;
	private result: PutResult | undefined;
	private received = 0;
	private finalChunk: HeldChunk | undefined;

	private readonly onReceived = (): void => {
		if (this.result === undefined) {
			this.receiving.restart();
		}
	};

	constructor(
		blobs: Pick<R2ObjectStore, 'put'>,
		private readonly target: CanonicalWriteTarget,
		narSize: number,
		canonicalPut: SubrequestHold | undefined,
		private readonly receiving: StallWatchdog
	) {
		const stream = new FixedLengthStream(target.fileSize);
		this.writer = stream.writable.getWriter();
		canonicalPut?.release();
		this.put = putResult(
			blobs.put(target.key, stream.readable, {
				sha256: NixSha256Hash.parse(target.fileHash).digestBytes(),
				customMetadata: { narSize: String(narSize) },
				onlyIf: { etagDoesNotMatch: '*' }
			})
		);
		void this.put.then((result) => {
			this.result = result;
			this.receiving.stop();
		});
	}

	// A conditional put for a key that already exists may finish before it has
	// read the whole body. Writing to it after that would wait for a reader that
	// never comes, so the writer stops.
	private async send(bytes: Uint8Array): Promise<void> {
		if (this.result === undefined) {
			await Promise.race([
				streamSettled(this.writer.write(bytes), this.onReceived),
				this.put
			]);
		}

		if (this.result?.kind === 'failed') {
			throw this.result.error;
		}
	}

	async write(bytes: Uint8Array, release: () => void): Promise<void> {
		this.received += bytes.byteLength;

		if (this.received >= this.target.fileSize) {
			this.finalChunk = { bytes, release };
			return;
		}

		await this.send(bytes);
		release();
	}

	/**
	 * Sends the final chunk, closes the body and reports what R2 did with it.
	 */
	async finish(): Promise<DeclaredNarVerification> {
		if (this.finalChunk !== undefined) {
			await this.send(this.finalChunk.bytes);
			this.finalChunk.release();
		}

		await Promise.race([
			streamSettled(this.writer.close(), this.onReceived),
			this.put
		]);
		const result = await this.put;

		if (result.kind !== 'failed') {
			return { ok: true };
		}

		if (isR2BadDigest(result.error)) {
			return { ok: false, reason: 'file-hash-mismatch' };
		}

		throw result.error;
	}

	// Aborting an unfinished body prevents R2 from completing the put. Waiting
	// for the abort or for R2's answer could delay the caller indefinitely. The
	// source returns the buffers of chunks that were not released.
	abort(reason: unknown): Promise<void> {
		void streamSettled(this.writer.abort(reason));

		return Promise.resolve();
	}
}

/**
 * Verifies one staged NAR and writes its canonical object to `target.key`
 * from the same read, which uses ranged gets as {@link verifyStoredNar} does.
 * The client declared the compressed object's SHA-256 and length, and R2
 * checks the written bytes against the declared hash, so this verifier does
 * not hash the compressed bytes itself.
 *
 * Returns `{ ok: true }` once R2 has stored the object, or when an object
 * already exists at the key. A mismatch of the NAR or of the declaration
 * prevents a new object from being stored; an existing object remains.
 * Read failures, stalls and aborts behave as in {@link verifyStoredNar}, with
 * a shorter stall interval, and abort any unfinished put. A verified write that
 * completed before a later abort can remain at the key. The write also fails with
 * `SubrequestTimeoutError('nar.verify')` when an unfinished put receives no
 * bytes for the stall interval, which covers the work after the last read and
 * R2's answer to the put.
 */
export async function verifyAndWriteStoredNar(
	blobs: R2ObjectStore,
	stagingKey: R2ObjectKey,
	expected: ExpectedNar,
	target: CanonicalWriteTarget,
	{
		buffers,
		firstGet,
		canonicalPut,
		signal: outerSignal,
		stallMs = canonicalWriteStallMs,
		progress = narVerifyProgress()
	}: CanonicalWriteOptions
): Promise<DeclaredNarVerification> {
	// R2 limits the time for which the put receives nothing, which reads alone
	// cannot bound. The write stops when either watchdog fires.
	const receiving = new StallWatchdog(stallMs, outerSignal);
	const watchdog = new StallWatchdog(stallMs, receiving.signal);

	try {
		progress.stage = 'fetch';
		const source = await openStoredNarChunks(blobs, stagingKey, {
			buffers,
			watch: watchdog,
			progress,
			firstGet
		});

		if (source.size !== target.fileSize) {
			await source.close(verificationRejected());

			return {
				ok: false,
				reason: 'file-size-mismatch',
				actualFileSize: source.size
			};
		}

		const verification = await verifyNarChunks(
			source,
			expected,
			progress,
			new CanonicalWriter(
				blobs,
				target,
				expected.narSize,
				canonicalPut,
				receiving
			),
			watchdog
		);
		watchdog.signal.throwIfAborted();

		return verification;
	} finally {
		watchdog.dispose();
		receiving.dispose();
	}
}
