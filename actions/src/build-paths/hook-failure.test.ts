import { describe, expect, it, vi } from 'vitest';

import { HookFailureDetector } from './hook-failure.ts';

const markers = [
	'cupboard-hook-relay: delivery failed:',
	'cupboard: failed to protect every completed output'
] as const;

describe('hook failure detection', () => {
	it.each(
		markers.flatMap((marker) =>
			Array.from({ length: marker.length - 1 }, (_, index) => ({
				marker,
				boundary: index + 1
			}))
		)
	)('recognises $marker split at $boundary', ({ marker, boundary }) => {
		const detector = new HookFailureDetector();
		expect([
			detector.accept(`unrelated stderr\n${marker.slice(0, boundary)}`),
			detector.accept(`${marker.slice(boundary)} details\n`),
			detector.accept('later unrelated stderr\n')
		]).toStrictEqual([false, true, true]);
	});

	it('retains only marker overlap across a large unrelated stream', () => {
		const detector = new HookFailureDetector();
		const scan = vi.spyOn(RegExp.prototype, 'test');
		const chunk = 'unrelated stderr\n'.repeat(4096);
		const overlap = Math.max(...markers.map((marker) => marker.length)) - 1;
		const results = Array.from({ length: 128 }, () => detector.accept(chunk));
		const scannedLengths = scan.mock.calls.map(([text]) => text.length);
		scan.mockRestore();

		expect({ results, scannedLengths }).toStrictEqual({
			results: Array.from({ length: 128 }, () => false),
			scannedLengths: [
				chunk.length,
				...Array.from({ length: 127 }, () => chunk.length + overlap)
			]
		});
	});
});
