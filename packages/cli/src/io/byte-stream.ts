export type ByteSource =
	ReadableStream<Uint8Array> | Iterable<Uint8Array> | AsyncIterable<Uint8Array>;

export function byteStream(source: ByteSource): ReadableStream<Uint8Array> {
	if (source instanceof ReadableStream) {
		return source;
	}

	return asyncIterableByteStream(source);
}

/**
 * Wraps a byte stream so `onChunk` sees each chunk's length as the consumer
 * pulls it through, leaving the bytes themselves untouched. Used to follow an
 * upload's progress as each chunk is sent.
 */
export function countingByteStream(
	source: ReadableStream<Uint8Array>,
	onChunk: (byteLength: number) => void
): ReadableStream<Uint8Array> {
	return source.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				onChunk(chunk.byteLength);
				controller.enqueue(chunk);
			}
		})
	);
}

/**
 * Copies written bytes into pieces of exactly `size` bytes. A piece is
 * allocated when its first byte is written, and the last, shorter piece is
 * returned in a buffer of its own length.
 */
export class ByteAccumulator {
	private piece: Buffer | undefined;

	private filled = 0;

	private readonly complete: Buffer[] = [];

	private total = 0;

	constructor(private readonly size: number) {}

	/**
	 * How many bytes have been written in total.
	 */
	get written(): number {
		return this.total;
	}

	write(bytes: Uint8Array): void {
		this.total += bytes.byteLength;

		for (let offset = 0; offset < bytes.byteLength;) {
			this.piece ??= Buffer.allocUnsafeSlow(this.size);

			const copied = Math.min(
				this.size - this.filled,
				bytes.byteLength - offset
			);
			this.piece.set(bytes.subarray(offset, offset + copied), this.filled);
			this.filled += copied;
			offset += copied;

			if (this.filled < this.size) {
				continue;
			}

			this.complete.push(this.piece);
			this.piece = undefined;
			this.filled = 0;
		}
	}

	/**
	 * Returns the complete pieces and removes them from the accumulator.
	 */
	*takeComplete(): Iterable<Uint8Array> {
		for (
			let piece = this.complete.shift();
			piece !== undefined;
			piece = this.complete.shift()
		) {
			yield piece;
		}
	}

	/**
	 * Returns the complete pieces and then the remaining bytes, and removes
	 * them from the accumulator.
	 */
	*takeAll(): Iterable<Uint8Array> {
		yield* this.takeComplete();

		if (this.piece === undefined) {
			return;
		}

		const remainder = new Uint8Array(this.piece.subarray(0, this.filled));
		this.piece = undefined;
		this.filled = 0;

		yield remainder;
	}
}

function asyncIterableByteStream(
	source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
): ReadableStream<Uint8Array> {
	const iterator = byteIterator(source);

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await iterator.next();

			if (next.done === true) {
				controller.close();
				return;
			}

			controller.enqueue(next.value);
		},
		async cancel() {
			await iterator.return?.();
		}
	});
}

function isAsyncIterable(
	source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
): source is AsyncIterable<Uint8Array> {
	return (
		typeof (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
		'function'
	);
}

function byteIterator(
	source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
): AsyncIterator<Uint8Array> {
	if (isAsyncIterable(source)) {
		return source[Symbol.asyncIterator]();
	}

	const iterator = source[Symbol.iterator]();

	return {
		next: () => Promise.resolve(iterator.next()),
		return: () =>
			Promise.resolve(iterator.return?.() ?? { done: true, value: undefined })
	};
}
