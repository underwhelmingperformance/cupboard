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
