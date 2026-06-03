import { NixSha256Hash, zstdDecompressionStream } from '@cupboard/shared';

// What a stored NAR blob's bytes must satisfy: decompressed, they hash to the
// `narHash` the narinfo commits to and signs, and their length is `narSize`.
export interface ExpectedNar {
	readonly narHash: string;
	readonly narSize: number;
}

export type NarVerification =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: 'nar-hash-mismatch';
			readonly actualNarHash: string;
	  }
	| {
			readonly ok: false;
			readonly reason: 'nar-size-mismatch';
			readonly actualNarSize: number;
	  };

/**
 * Streams a stored `.nar.zst` body through native zstd decompression and a
 * running SHA-256, recomputing the uncompressed NAR hash and size and comparing
 * them to what the narinfo commits to. The stream is never buffered whole, so
 * peak memory stays bounded regardless of NAR size and only CPU time bounds how
 * large a NAR can be verified in one pass. This is the server-side check that
 * makes a client-asserted `narHash` trustworthy before it is signed and served.
 */
export async function verifyDecompressedNar(
	body: ReadableStream<Uint8Array>,
	expected: ExpectedNar
): Promise<NarVerification> {
	const digestStream = new crypto.DigestStream('SHA-256');
	let narSize = 0;

	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			narSize += chunk.byteLength;
			controller.enqueue(chunk);
		}
	});

	await body
		.pipeThrough(zstdDecompressionStream())
		.pipeThrough(counter)
		.pipeTo(digestStream);

	const digest = new Uint8Array(await digestStream.digest);
	const actualNarHash = NixSha256Hash.fromDigest(digest).toString();

	if (actualNarHash !== expected.narHash) {
		return { ok: false, reason: 'nar-hash-mismatch', actualNarHash };
	}

	if (narSize !== expected.narSize) {
		return { ok: false, reason: 'nar-size-mismatch', actualNarSize: narSize };
	}

	return { ok: true };
}
