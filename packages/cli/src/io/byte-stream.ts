export type ByteSource =
	| ReadableStream<Uint8Array>
	| Iterable<Uint8Array>
	| AsyncIterable<Uint8Array>;

export function byteStream(source: ByteSource): ReadableStream<Uint8Array> {
	if (source instanceof ReadableStream) {
		return source;
	}

	return asyncIterableByteStream(source);
}

/**
 * Wraps a byte stream so `onChunk` sees each chunk's length as the consumer
 * pulls it through, leaving the bytes themselves untouched. Used to follow an
 * upload's progress as it is sent rather than only once it completes.
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

function byteIterator(
	source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>
): AsyncIterator<Uint8Array> {
	if (Symbol.asyncIterator in source) {
		return source[Symbol.asyncIterator]();
	}

	const iterator = source[Symbol.iterator]();

	return {
		next() {
			return Promise.resolve(iterator.next());
		},
		return() {
			return Promise.resolve(
				iterator.return?.() ?? { done: true, value: undefined }
			);
		}
	};
}
