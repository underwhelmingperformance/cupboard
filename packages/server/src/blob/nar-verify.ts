import { ZstdDecodeError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';

import {
	SubrequestTimeoutError,
	UploadedObjectNotFoundError
} from '../errors.ts';
import { verifiableMaxBytes } from '../http/http.ts';
import { type R2ObjectKey } from '../http/http.ts';

export const narVerifyBudgetMs = 5 * 60 * 1000;

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
 * Streams a stored `.nar.zst` body through native zstd decompression and a
 * running SHA-256, recomputing the uncompressed NAR hash and size and comparing
 * them to what the narinfo commits to. The same pass hashes and counts the
 * compressed input, so successful verification also yields the object's file
 * hash and size without a second read. Verification streams the body and
 * rejects decompressed data beyond the declared size or the server limit.
 */
export async function verifyDecompressedNar(
	body: ReadableStream<Uint8Array>,
	expected: ExpectedNar
): Promise<NarVerification> {
	// Stop after the declared size or the server limit, whichever is smaller. A
	// highly expanding frame cannot make this pass process an unbounded NAR.
	const limit = Math.min(expected.narSize, verifiableMaxBytes);

	// Hash and count the compressed bytes as they arrive, before decompression,
	// so a successful pass reports the stored object's own file hash and size.
	const fileDigestStream = new crypto.DigestStream('SHA-256');
	const fileDigestComplete = fileDigestStream.digest;
	const fileWriter = fileDigestStream.getWriter();
	let fileSize = 0;

	const compressed = body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			async transform(chunk, controller) {
				fileSize += chunk.byteLength;
				await fileWriter.write(chunk);
				controller.enqueue(chunk);
			},
			async flush() {
				await fileWriter.close();
			}
		})
	);

	const reader = compressed.pipeThrough(zstdDecompressionStream()).getReader();
	const digestStream = new crypto.DigestStream('SHA-256');
	const digestComplete = digestStream.digest;
	const writer = digestStream.getWriter();
	let narSize = 0;

	// Cancel every end and discard the (now-rejecting) digests so an early exit
	// never leaves an unhandled rejection or a dangling decompression.
	const teardown = async (): Promise<void> => {
		await Promise.allSettled([
			reader.cancel(),
			writer.abort(),
			fileWriter.abort(),
			digestComplete,
			fileDigestComplete
		]);
	};

	try {
		for (;;) {
			const result = await reader.read();

			if (result.done) {
				break;
			}

			narSize += result.value.byteLength;

			if (narSize > limit) {
				await teardown();

				return {
					ok: false,
					reason: 'nar-size-mismatch',
					actualNarSize: narSize
				};
			}

			await writer.write(result.value);
		}

		await writer.close();
	} catch (error) {
		await teardown();

		// Bytes that are not a valid zstd frame can never decode to the claimed
		// hash, so this is a definitive verification failure. Any other error (a
		// source read fault) propagates for the caller to treat as transient.
		if (error instanceof ZstdDecodeError) {
			return { ok: false, reason: 'undecodable' };
		}

		throw error;
	}

	const digest = new Uint8Array(await digestComplete);
	const actualNarHash = NixSha256Hash.fromDigest(digest).toString();

	if (actualNarHash !== expected.narHash) {
		return { ok: false, reason: 'nar-hash-mismatch', actualNarHash };
	}

	if (narSize !== expected.narSize) {
		return { ok: false, reason: 'nar-size-mismatch', actualNarSize: narSize };
	}

	const fileDigest = new Uint8Array(await fileDigestComplete);

	return {
		ok: true,
		fileHash: NixSha256Hash.fromDigest(fileDigest).value,
		fileSize
	};
}

// The verifier locks its input stream. Keep the R2 reader outside that stream
// so timeout cancellation can still reach the underlying R2 body.
function cancellableNarBody(body: ReadableStream<Uint8Array>): {
	readonly stream: ReadableStream<Uint8Array>;
	readonly cancel: (reason?: unknown) => Promise<void>;
} {
	const reader = body.getReader();
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();

			if (done) {
				controller.close();
				return;
			}

			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});

	return { stream, cancel: (reason) => reader.cancel(reason) };
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

function verificationSignal(
	budgetMs: number,
	outer?: AbortSignal
): { readonly signal: AbortSignal; readonly dispose: () => void } {
	const controller = new AbortController();
	const onOuterAbort = (): void => {
		if (outer !== undefined) {
			controller.abort(abortReason(outer));
		}
	};

	if (outer?.aborted === true) {
		onOuterAbort();
	} else {
		outer?.addEventListener('abort', onOuterAbort, { once: true });
	}

	const timer = setTimeout(() => {
		controller.abort(new SubrequestTimeoutError('nar.verify'));
	}, budgetMs);

	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timer);
			outer?.removeEventListener('abort', onOuterAbort);
		}
	};
}

/**
 * Fetches and verifies one staged NAR within a fixed wall-clock budget. An
 * outer consumer signal can shorten that budget. If the R2 get finishes after
 * cancellation, the verifier cancels the returned body without decoding it.
 */
export async function verifyStoredNar(
	blobs: R2Bucket,
	r2Key: R2ObjectKey,
	expected: ExpectedNar,
	budgetMs: number = narVerifyBudgetMs,
	outerSignal?: AbortSignal
): Promise<NarVerification> {
	const { signal, dispose } = verificationSignal(budgetMs, outerSignal);
	let cancelBody: ((reason?: unknown) => Promise<void>) | undefined;
	let cancellation: Promise<void> | undefined;
	const cancel = (): void => {
		cancellation ??= cancelBody?.(abortReason(signal));
	};
	signal.addEventListener('abort', cancel, { once: true });

	try {
		const object = await getStoredNar(blobs, r2Key, signal);

		if (object === null) {
			throw new UploadedObjectNotFoundError(r2Key);
		}

		const body = object.body as ReadableStream<Uint8Array>;
		const cancellable = cancellableNarBody(body);
		cancelBody = cancellable.cancel;
		signal.throwIfAborted();
		const verification = await verifyDecompressedNar(
			cancellable.stream,
			expected
		);

		if (signal.aborted) {
			throw abortReason(signal);
		}

		return verification;
	} catch (error) {
		await Promise.allSettled([cancellation]);

		throw signal.aborted ? abortReason(signal) : error;
	} finally {
		signal.removeEventListener('abort', cancel);
		dispose();
	}
}
