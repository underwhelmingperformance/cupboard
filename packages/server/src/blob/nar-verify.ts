import { ZstdDecodeError } from '@cupboard/nix-store/errors';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { type NixSha256HashString } from '@cupboard/nix-store/scalars';
import { zstdDecompressionStream } from '@cupboard/nix-store/zstd';

import { verifiableMaxBytes } from '../http/http.ts';

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
