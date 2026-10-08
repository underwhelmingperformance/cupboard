import { createHash } from 'node:crypto';

/**
 * Returns `length` bytes from a xorshift generator. The same seed always gives
 * the same bytes, and zstd cannot compress them.
 */
export function pseudoRandomBytes(length: number, seed: number): Uint8Array {
	const words = new Uint32Array(Math.ceil(length / 4));
	let state = seed | 1;

	for (let index = 0; index < words.length; index += 1) {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		words[index] = state >>> 0;
	}

	return new Uint8Array(words.buffer, words.byteOffset, length);
}

/**
 * Returns the length and SHA-256 digest of `bytes`. Tests compare these
 * instead of multi-megabyte buffers, which take seconds to compare element by
 * element.
 */
export function fingerprint(bytes: Uint8Array): {
	readonly size: number;
	readonly sha256: string;
} {
	return {
		size: bytes.byteLength,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}
