import { describe, expect, it } from 'vitest';

import { SequentialNarSource } from './nar-source.ts';

describe('SequentialNarSource', () => {
	const chunks = [
		Uint8Array.of(0, 1, 2),
		Uint8Array.of(3, 4, 5, 6),
		Uint8Array.of(),
		Uint8Array.of(7, 8, 9)
	];

	it.each([
		{ offset: 0, expected: [[0, 1, 2], [3, 4, 5, 6], [], [7, 8, 9]] },
		{ offset: 1, expected: [[1, 2], [3, 4, 5, 6], [], [7, 8, 9]] },
		{ offset: 3, expected: [[3, 4, 5, 6], [], [7, 8, 9]] },
		{ offset: 6, expected: [[6], [], [7, 8, 9]] },
		{ offset: 7, expected: [[7, 8, 9]] },
		{ offset: 9, expected: [[9]] },
		{ offset: 10, expected: [] }
	])(
		'requests the NAR again and discards the bytes before offset $offset',
		async ({ offset, expected }) => {
			let requests = 0;
			const source = new SequentialNarSource(() => {
				requests += 1;

				return chunks;
			});

			const first = await Array.fromAsync(source.open(offset));
			const second = await Array.fromAsync(source.open(offset));

			expect({
				first: first.map((chunk) => [...chunk]),
				second: second.map((chunk) => [...chunk]),
				requests
			}).toStrictEqual({ first: expected, second: expected, requests: 2 });
		}
	);
});
