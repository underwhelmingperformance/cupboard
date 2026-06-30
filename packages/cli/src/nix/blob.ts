import { createHash } from 'node:crypto';

import { zstdCompressionStream } from '@cupboard/nix-store/zstd';

import { type ByteSource, byteStream } from '../io/byte-stream.ts';

import type { NarDigest } from './nar.ts';
import { NixSha256Hash } from './nar.ts';

// A NAR compressed on the fly: the compressed bytes stream straight to the
// uploader, and the uncompressed NAR's hash and size, accumulated as the bytes
// pass through, are read once the stream is fully consumed. Nothing is written
// to disk, so a large closure cannot exhaust a runner's temporary space.
export interface NarUploadStream {
	readonly body: ReadableStream<Uint8Array>;
	digest(): NarDigest;
}

export function compressNarToStream(nar: ByteSource): NarUploadStream {
	const narHasher = new HashingByteTransform();
	const body = byteStream(nar)
		.pipeThrough(narHasher.stream)
		.pipeThrough(zstdCompressionStream());

	return {
		body,
		digest: () => {
			const digest = narHasher.digest();

			return { narHash: digest.hash, narSize: digest.size };
		}
	};
}

class HashingByteTransform {
	private readonly hash = createHash('sha256');

	private size = 0;

	// `createHash` can be finalised only once, so the result is cached: a stream
	// whose hash is read more than once (a fake, or a retry) gets the same value.
	private finalised:
		| { readonly hash: NixSha256Hash; readonly size: number }
		| undefined;

	readonly stream: TransformStream<Uint8Array, Uint8Array>;

	constructor() {
		this.stream = new TransformStream<Uint8Array, Uint8Array>({
			transform: (chunk, controller) => {
				this.hash.update(chunk);
				this.size += chunk.byteLength;
				controller.enqueue(chunk);
			}
		});
	}

	digest(): {
		readonly hash: NixSha256Hash;
		readonly size: number;
	} {
		this.finalised ??= {
			hash: NixSha256Hash.fromDigest(this.hash.digest()),
			size: this.size
		};

		return this.finalised;
	}
}
