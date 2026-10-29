import { bench, describe } from 'vitest';

import { redactKeyValues, redactOptionValues } from './credential-scanner.ts';

const length = 8192;

const benchSink: { value: unknown } = { value: undefined };

function scan(text: string): void {
	benchSink.value = redactOptionValues(redactKeyValues(text));
}

// Each group scans the same number of characters in both benchmarks. If the
// scans are linear in the length of the text, the two benchmarks take about the
// same time. Redaction cuts longer strings before it scans them, so these
// benchmarks call the scans directly.
describe.each<[string, (length: number) => string]>([
	['a dotted name', (size) => 'a.'.repeat(size / 2)],
	['a repeated credential name', (size) => 'password'.repeat(size / 8)],
	[
		'an escaped quoted value',
		(size) => `password="${String.raw`\a`.repeat(size / 2)}`
	],
	['an option followed by spaces', (size) => '--token'.padEnd(size)]
])('scanning %s', (_shape, text) => {
	const short = text(length);
	const long = text(8 * length);

	bench('eight 8 KiB inputs', () => {
		for (let index = 0; index < 8; index += 1) {
			scan(short);
		}
	});

	bench('one 64 KiB input', () => {
		scan(long);
	});
});
