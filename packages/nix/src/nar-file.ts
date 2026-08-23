import { NixStoreError } from './nix-store.ts';

/**
 * The largest regular-file payload accepted by default. The reader checks the
 * declared length before allocating the destination buffer, so daemon
 * derivation reads reject unexpectedly large files.
 */
export const maxNarFileByteLength = 32 * 1024 * 1024;

export class UnexpectedNarShapeError extends NixStoreError {
	constructor(public readonly reason: string) {
		super(`Expected a NAR with a regular-file root: ${reason}`);
		this.name = 'UnexpectedNarShapeError';
	}
}

export class NarFileTooLargeError extends NixStoreError {
	constructor(
		public readonly byteLength: number,
		public readonly maxByteLength: number
	) {
		super(
			`The NAR declares a file length of ${String(byteLength)} bytes, above the ${String(maxByteLength)}-byte in-memory limit`
		);
		this.name = 'NarFileTooLargeError';
	}
}

/**
 * Reads the contents when a NAR's root node is a regular file, including one
 * with the optional executable marker. The payload is buffered in memory up to
 * `maxByteLength`; any other root shape is rejected. The input iterator is
 * released after success or failure.
 */
export async function narRegularFileContents(
	chunks: AsyncIterable<Uint8Array>,
	maxByteLength: number = maxNarFileByteLength
): Promise<Uint8Array> {
	const reader = new NarReader(chunks);

	// Parsing stops after the closing regular-file marker, before the producer
	// necessarily reports the end of the stream. Release the iterator so a
	// producer such as `narFromPath` can close its dedicated daemon connection.
	try {
		await reader.expectWord('nix-archive-1');
		await reader.expectWord('(');
		await reader.expectWord('type');
		await reader.expectWord('regular');

		const marker = await reader.readWord();

		if (marker === 'executable') {
			await reader.expectWord('');
			await reader.expectWord('contents');
		} else if (marker !== 'contents') {
			throw new UnexpectedNarShapeError(
				`expected 'contents' or 'executable', found '${marker}'`
			);
		}

		const contents = await reader.readBlob(maxByteLength);
		await reader.expectWord(')');

		return contents;
	} finally {
		await reader.release();
	}
}

// Structural words in this NAR subset are no longer than `nix-archive-1`.
// Reject a larger declared token before allocating or decoding it.
const maxNarWordLength = 'nix-archive-1'.length;

// NAR values use a little-endian 64-bit length followed by the bytes and enough
// zero padding to reach an eight-byte boundary.
class NarReader {
	private buffered: Uint8Array[] = [];

	private bufferedLength = 0;

	private readonly iterator: AsyncIterator<Uint8Array>;

	constructor(chunks: AsyncIterable<Uint8Array>) {
		this.iterator = chunks[Symbol.asyncIterator]();
	}

	private async read(byteLength: number): Promise<Uint8Array> {
		while (this.bufferedLength < byteLength) {
			const next = await this.iterator.next();

			if (next.done === true) {
				throw new UnexpectedNarShapeError('the stream ended early');
			}

			this.buffered.push(next.value);
			this.bufferedLength += next.value.byteLength;
		}

		const result = new Uint8Array(byteLength);
		let offset = 0;

		for (const chunk of this.buffered) {
			if (offset >= byteLength) {
				break;
			}

			const take = Math.min(chunk.byteLength, byteLength - offset);
			result.set(chunk.subarray(0, take), offset);
			offset += take;
		}

		this.buffered = remaining(this.buffered, byteLength);
		this.bufferedLength -= byteLength;

		return result;
	}

	private async readLength(): Promise<number> {
		const header = await this.read(8);
		const value = new DataView(
			header.buffer,
			header.byteOffset,
			header.byteLength
		).getBigUint64(0, true);

		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new UnexpectedNarShapeError(
				"a declared length exceeds JavaScript's safe integer range"
			);
		}

		return Number(value);
	}

	private async skipPadding(byteLength: number): Promise<void> {
		const padding = (8 - (byteLength % 8)) % 8;

		if (padding > 0) {
			await this.read(padding);
		}
	}

	async release(): Promise<void> {
		await this.iterator.return?.();
	}

	async readWord(): Promise<string> {
		const byteLength = await this.readLength();

		if (byteLength > maxNarWordLength) {
			throw new UnexpectedNarShapeError(
				`a structural token declares ${String(byteLength)} bytes; the limit is ${String(maxNarWordLength)}`
			);
		}

		const bytes = await this.read(byteLength);
		await this.skipPadding(byteLength);

		return new TextDecoder().decode(bytes);
	}

	async expectWord(expected: string): Promise<void> {
		const word = await this.readWord();

		if (word !== expected) {
			throw new UnexpectedNarShapeError(
				`expected '${expected}', found '${word}'`
			);
		}
	}

	async readBlob(maxByteLength: number): Promise<Uint8Array> {
		const byteLength = await this.readLength();

		if (byteLength > maxByteLength) {
			throw new NarFileTooLargeError(byteLength, maxByteLength);
		}

		const bytes = await this.read(byteLength);
		await this.skipPadding(byteLength);

		return bytes;
	}
}

function remaining(
	chunks: readonly Uint8Array[],
	consumed: number
): Uint8Array[] {
	const kept: Uint8Array[] = [];
	let offset = 0;

	for (const chunk of chunks) {
		if (offset >= consumed) {
			kept.push(chunk);
			continue;
		}

		const take = Math.min(chunk.byteLength, consumed - offset);
		offset += take;

		if (take < chunk.byteLength) {
			kept.push(chunk.subarray(take));
		}
	}

	return kept;
}
