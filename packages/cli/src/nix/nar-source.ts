import type { ByteSource } from '../io/byte-stream.ts';

/**
 * A store path's NAR that can be read again from any byte offset. The uploader
 * reads a NAR once from the start, and reopens it at an offset to recompress
 * part of the upload after a failed request.
 */
export interface NarSource {
	/**
	 * Returns the NAR's bytes from `offset` to the end. Each call starts a new
	 * read.
	 */
	open(offset: number): AsyncIterable<Uint8Array>;
}

/**
 * A NAR from a store that can only stream it from the start, such as a store
 * reached over `ssh-ng`. Opening it at an offset requests the whole NAR again
 * and discards the bytes before the offset.
 */
export class SequentialNarSource implements NarSource {
	constructor(private readonly request: () => ByteSource) {}

	async *open(offset: number): AsyncIterable<Uint8Array> {
		let position = 0;

		for await (const chunk of this.request()) {
			const end = position + chunk.byteLength;

			if (end > offset) {
				yield position >= offset ? chunk : chunk.subarray(offset - position);
			}

			position = end;
		}
	}
}
