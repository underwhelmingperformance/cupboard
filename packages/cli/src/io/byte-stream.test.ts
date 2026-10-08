import { describe, expect, it } from 'vitest';

import {
	ByteAccumulator,
	byteStream,
	countingByteStream
} from './byte-stream.ts';

async function collect(
	stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = await Array.fromAsync(stream);

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
			countingByteStream(source, (byteLength) => {
				lengths.push(byteLength);
			})
		);

		expect({ lengths, passed: [...passed] }).toStrictEqual({
			lengths: [3, 2, 1],
			passed: [1, 2, 3, 4, 5, 6]
		});
	});

	it('reports nothing for an empty stream', async () => {
		const lengths: number[] = [];

		const passed = await collect(
			countingByteStream(byteStream([]), (byteLength) => {
				lengths.push(byteLength);
			})
		);

		expect({ lengths, passed: passed.byteLength }).toStrictEqual({
			lengths: [],
			passed: 0
		});
	});
});

describe('ByteAccumulator', () => {
	const cases: readonly {
		readonly name: string;
		readonly writes: readonly number[];
		readonly complete: readonly number[];
		readonly all: readonly number[];
	}[] = [
		{ name: 'no writes', writes: [], complete: [], all: [] },
		{ name: 'less than one piece', writes: [1, 2], complete: [], all: [3] },
		{
			name: 'writes across piece boundaries',
			writes: [3, 3, 3],
			complete: [4, 4],
			all: [4, 4, 1]
		},
		{
			name: 'an exact multiple of the piece size',
			writes: [2, 2, 4],
			complete: [4, 4],
			all: [4, 4]
		},
		{
			name: 'a write longer than several pieces',
			writes: [1, 10],
			complete: [4, 4],
			all: [4, 4, 3]
		},
		{ name: 'empty writes', writes: [0, 2, 0, 2, 0], complete: [4], all: [4] }
	];

	it.each(cases)(
		'returns complete pieces, then a remainder in its own buffer, for $name',
		({ writes, complete, all }) => {
			let next = 0;
			const written = writes.map((length) =>
				Uint8Array.from({ length }, () => (next += 1))
			);
			const accumulator = new ByteAccumulator(4);

			for (const bytes of written) {
				accumulator.write(bytes);
			}

			const completed = [...accumulator.takeComplete()];
			const pieces = [...completed, ...accumulator.takeAll()];

			expect({
				complete: completed.map((piece) => piece.byteLength),
				all: pieces.map((piece) => piece.byteLength),
				backing: pieces.map((piece) => piece.buffer.byteLength),
				bytes: [...Buffer.concat(pieces)]
			}).toStrictEqual({
				complete,
				all,
				backing: all,
				bytes: [...Buffer.concat(written)]
			});
		}
	);
});
