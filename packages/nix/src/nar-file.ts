import { NixStoreError } from './nix-store.ts';

/**
 * The largest file this reader will hold in memory while reading a NAR. A
 * derivation is the only file read this way and is far smaller, so a stream
 * longer than this bound is not a derivation and is refused instead of
 * buffered.
 */
export const maxNarFileByteLength = 32 * 1024 * 1024;

export class UnexpectedNarShapeError extends NixStoreError {
	constructor(public readonly reason: string) {
		super(`The NAR does not serialise a single regular file: ${reason}`);
		this.name = 'UnexpectedNarShapeError';
	}
}

export class NarFileTooLargeError extends NixStoreError {
	constructor(
		public readonly byteLength: number,
		public readonly maxByteLength: number
	) {
		super(
			`The NAR contains a ${String(byteLength)}-byte file, more than the ${String(maxByteLength)}-byte limit for reading a file into memory`
		);
		this.name = 'NarFileTooLargeError';
	}
}

/**
 * The bytes of the single regular file a NAR serialises. A store path holding a
 * single file (a derivation, a text file added to the store) serialises to
 * exactly that, so this reads the whole file into memory; a NAR of any other
 * shape is refused.
 */
export async function narRegularFileContents(
	chunks: AsyncIterable<Uint8Array>,
	maxByteLength: number = maxNarFileByteLength
): Promise<Uint8Array> {
	const reader = new NarReader(chunks);

	// The reader stops as soon as it has the file, leaving the stream
	// suspended. Releasing the stream here lets a producer that holds a resource
	// for the stream's lifetime, such as a dedicated daemon connection, close
	// that resource when this function returns.
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
				`'${marker}' where the contents belong`
			);
		}

		const contents = await reader.readBlob(maxByteLength);
		await reader.expectWord(')');

		return contents;
	} finally {
		await reader.release();
	}
}

// The longest fixed word of the NAR grammar this reader accepts; anything
// longer in a structural position is malformed.
const maxNarWordLength = 'nix-archive-1'.length;

// A NAR is a stream of 64-bit-length-prefixed, 8-byte-padded byte strings.
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
			throw new UnexpectedNarShapeError('a length too large to read');
		}

		return Number(value);
	}

	private async skipPadding(byteLength: number): Promise<void> {
		const padding = (8 - (byteLength % 8)) % 8;

		if (padding > 0) {
			await this.read(padding);
		}
	}

	/**
	Tells the stream this reader is finished with it.
	*/
	async release(): Promise<void> {
		await this.iterator.return?.();
	}

	async readWord(): Promise<string> {
		const byteLength = await this.readLength();

		if (byteLength > maxNarWordLength) {
			throw new UnexpectedNarShapeError(
				`a grammar token of ${String(byteLength)} bytes`
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
				`'${word}' where '${expected}' belongs`
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

// The buffered chunks with the first `consumed` bytes dropped.
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
