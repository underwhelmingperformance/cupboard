import { describe, expect, it } from 'vitest';

import { byteStream, countingByteStream } from './byte-stream.ts';

async function collect(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];

	for await (const chunk of stream) {
		chunks.push(chunk);
	}

	return Buffer.concat(chunks);
}

describe('countingByteStream', () => {
	it('reports each chunk length and passes the bytes through unchanged', async () => {
		const source = byteStream([
			new Uint8Array([1, 2, 3]),
			new Uint8Array([4, 5]),
			new Uint8Array([6])
		]);
		const lengths: number[] = [];

		const passed = await collect(
			countingByteStream(source, (byteLength) => lengths.push(byteLength))
		);

		expect({ lengths, passed: [...passed] }).toStrictEqual({
			lengths: [3, 2, 1],
			passed: [1, 2, 3, 4, 5, 6]
		});
	});

	it('reports nothing for an empty stream', async () => {
		const lengths: number[] = [];

		const passed = await collect(
			countingByteStream(byteStream([]), (byteLength) =>
				lengths.push(byteLength)
			)
		);

		expect({ lengths, passed: passed.byteLength }).toStrictEqual({
			lengths: [],
			passed: 0
		});
	});
});
