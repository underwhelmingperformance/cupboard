import { ZstdDecodeError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';

import { verifiableMaxBytes } from '../http/http.ts';

// What a stored NAR blob's bytes must satisfy: decompressed, they hash to the
// `narHash` the narinfo commits to and signs, and their length is `narSize`.
export interface ExpectedNar {
	readonly narHash: string;
	readonly narSize: number;
}

export type NarVerification =
	| {
			readonly ok: true;
			// The compressed object's own SHA-256 and byte length, computed over the
			// same bytes this pass decompresses. A byte verification always reports
			// them; the reuse pass-through, which verifies no bytes, omits them and
			// sources the blob facts from `blob_state`.
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
 * compressed input, so a successful verification also yields the object's own
 * file hash and size without a second read. The stream is never buffered whole,
 * so peak memory stays bounded regardless of NAR size and only CPU time bounds
 * how large a NAR can be verified in one pass. This is the server-side check
 * that makes a client's `narHash` trustworthy before it is signed and served.
 */
export async function verifyDecompressedNar(
	body: ReadableStream<Uint8Array>,
	expected: ExpectedNar
): Promise<NarVerification> {
	// Decompression stops once it exceeds the declared size or the server's hard
	// cap, whichever is smaller. A frame that expands far beyond its declared
	// `narSize` (a zstd bomb) cannot burn the CPU budget, and the bound is never
	// larger than what the server is willing to verify regardless of what the
	// client declared.
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
