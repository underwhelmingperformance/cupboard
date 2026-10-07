import { ZstdDecodeError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { ZstdDecoder } from '@cupboard/nix-store/zstd';

import { raceVerificationOperation } from '../do/verification-claim-lease.ts';
import {
	SubrequestTimeoutError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { type R2ObjectKey, verifiableMaxBytes } from '../http/http.ts';

/**
 * How long the R2 get, or one read of the stored NAR's body, may take before
 * verification fails with `SubrequestTimeoutError('nar.verify')`.
 */
const narVerifyStallMs = 60 * 1000;

const readSize = 1024 * 1024;

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
export interface NarVerifyProgress {
	stage: NarVerifyStage;
	reads: number;
	compressedBytes: number;
	narBytes: number;
}

export function narVerifyProgress(): NarVerifyProgress {
	return { stage: 'fetch', reads: 0, compressedBytes: 0, narBytes: 0 };
}

export interface NarVerifyOptions {
	readonly progress?: NarVerifyProgress;
}

export interface StoredNarVerifyOptions extends NarVerifyOptions {
	/**
	 * Stops verification, for example when the verification pass ends.
	 */
	readonly signal?: AbortSignal;
	readonly stallMs?: number;
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
			chunkSize: readSize,
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
 * `SubrequestTimeoutError('nar.verify')` when the source makes no progress for
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

	/**
	 * Stops the stall interval once the source has ended.
	 */
	stop(): void {
		clearTimeout(this.timer);
	}

	dispose(): void {
		this.stop();
		this.outer?.removeEventListener('abort', this.onOuterAbort);
	}
}

async function readChunk(
	reader: ReadableStreamBYOBReader,
	watchdog: StallWatchdog | undefined
): Promise<Uint8Array | undefined> {
	// The decoder can still be processing the previous chunk while this read
	// runs, so every read gets a new buffer.
	const { done, value } = await reader.readAtLeast(
		readSize,
		new Uint8Array(readSize)
	);

	if (done) {
		watchdog?.stop();
		return undefined;
	}

	watchdog?.restart();

	return value;
}

async function verifyNarBody(
	body: ReadableStream,
	expected: ExpectedNar,
	progress: NarVerifyProgress,
	watchdog?: StallWatchdog
): Promise<NarVerification> {
	const signal = watchdog?.signal;
	const reader = body.getReader({ mode: 'byob' });
	// Stop after the declared size or the server limit, whichever is smaller. A
	// highly expanding frame cannot make this pass process an unbounded NAR.
	const decoder = new NarDecoder(
		Math.min(expected.narSize, verifiableMaxBytes),
		progress
	);
	const fileHash = new Sha256Stream();
	let next = readChunk(reader, watchdog);
	let isDecoded = false;

	try {
		for (;;) {
			progress.stage = 'read';
			const chunk = await raceVerificationOperation(next, signal);

			if (chunk === undefined) {
				break;
			}

			// Start the next read before decoding, so the wait for R2 overlaps the
			// decoding work.
			next = readChunk(reader, watchdog);
			progress.reads += 1;
			progress.compressedBytes += chunk.byteLength;
			progress.stage = 'decode';
			await fileHash.write(chunk);
			const halt = await raceVerificationOperation(
				decoder.write(chunk),
				signal
			);

			if (halt !== undefined) {
				return halt;
			}
		}

		progress.stage = 'decode';
		const halt = await raceVerificationOperation(decoder.end(), signal);

		if (halt !== undefined) {
			return halt;
		}

		isDecoded = true;
	} finally {
		if (!isDecoded) {
			await Promise.allSettled([
				reader.cancel(signal?.reason),
				next,
				decoder.destroy(),
				fileHash.abort()
			]);
		}
	}

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

	const fileDigest = await fileHash.digest();

	return {
		ok: true,
		fileHash: fileDigest.value,
		fileSize: progress.compressedBytes
	};
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
	return verifyNarBody(body, expected, progress);
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException('The operation was aborted.', 'AbortError')
	);
}

async function cancelObjectBody(
	object: R2ObjectBody | null,
	reason: unknown
): Promise<void> {
	if (object === null) {
		return;
	}

	await object.body.cancel(reason);
}

async function getStoredNar(
	blobs: R2Bucket,
	r2Key: R2ObjectKey,
	signal: AbortSignal
): Promise<R2ObjectBody | null> {
	signal.throwIfAborted();
	const pending = blobs.get(r2Key);
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
 * Fetches and verifies one staged NAR. It fails with
 * `SubrequestTimeoutError('nar.verify')` when the R2 get or a read of the body
 * takes longer than `stallMs`. When the outer signal aborts, it cancels the
 * body and rejects with the signal's reason. If the R2 get finishes after a
 * timeout or an abort, the verifier cancels the returned body without decoding
 * it.
 */
export async function verifyStoredNar(
	blobs: R2Bucket,
	r2Key: R2ObjectKey,
	expected: ExpectedNar,
	{
		signal: outerSignal,
		stallMs = narVerifyStallMs,
		progress = narVerifyProgress()
	}: StoredNarVerifyOptions = {}
): Promise<NarVerification> {
	const watchdog = new StallWatchdog(stallMs, outerSignal);

	try {
		progress.stage = 'fetch';
		const object = await getStoredNar(blobs, r2Key, watchdog.signal);

		if (object === null) {
			throw new UploadedObjectNotFoundError(r2Key);
		}

		const verification = await verifyNarBody(
			object.body,
			expected,
			progress,
			watchdog
		);
		watchdog.signal.throwIfAborted();

		return verification;
	} finally {
		watchdog.dispose();
	}
}
