import { ZstdDecodeError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { ZstdDecoder } from '@cupboard/nix-store/zstd';

import { type SubrequestHold } from '../do/subrequest-slice.ts';
import { raceVerificationOperation } from '../do/verification-claim-lease.ts';
import { SubrequestTimeoutError } from '../errors.ts';
import { type R2ObjectKey, verifiableMaxBytes } from '../http/http.ts';

import {
	BodyChunks,
	type NarChunk,
	narChunkSize,
	type NarChunkSource,
	openStoredNarChunks,
	type RangeReadProgress
} from './nar-chunks.ts';
import { type NarReadBufferPool } from './nar-read-buffers.ts';

/**
 * How long verification may go without completing a read of the stored NAR,
 * from any of its R2 gets, before it fails with
 * `SubrequestTimeoutError('nar.verify')`.
 */
const narVerifyStallMs = 60 * 1000;

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

async function verifyNarChunks(
	source: NarChunkSource,
	expected: ExpectedNar,
	progress: NarVerifyProgress,
	signal?: AbortSignal
): Promise<NarVerification> {
	// Stop after the declared size or the server limit, whichever is smaller. A
	// highly expanding frame cannot make this pass process an unbounded NAR.
	const decoder = new NarDecoder(
		Math.min(expected.narSize, verifiableMaxBytes),
		progress
	);
	const fileHash = new Sha256Stream();
	let next = readAhead(source);
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
			next = readAhead(source);
			progress.reads += 1;
			progress.compressedBytes += chunk.bytes.byteLength;
			progress.stage = 'decode';
			await fileHash.write(chunk.bytes);
			const halt = await raceVerificationOperation(
				decoder.write(chunk.bytes),
				signal
			);

			if (halt !== undefined) {
				return halt;
			}

			chunk.release();
		}

		progress.stage = 'decode';
		const halt = await raceVerificationOperation(decoder.end(), signal);

		if (halt !== undefined) {
			return halt;
		}

		isDecoded = true;
	} finally {
		// Stop the decoder and the hash before the source returns its buffers.
		// Another verification can detach a buffer as soon as it is back in the
		// pool.
		if (!isDecoded) {
			await Promise.allSettled([decoder.destroy(), fileHash.abort()]);
		}

		await Promise.allSettled([source.close(signal?.reason), next]);
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
	return verifyNarChunks(new BodyChunks(body), expected, progress);
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
	blobs: R2Bucket,
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
			watchdog.signal
		);
		watchdog.signal.throwIfAborted();

		return verification;
	} finally {
		watchdog.dispose();
	}
}
