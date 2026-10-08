import { formatBytes, formatDuration } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	compressionRows,
	CompressionTotals,
	reportNarCompression
} from './compression-report.ts';

const facts = {
	narBytes: 64_000_000,
	compressedBytes: 8_000_000,
	frames: 4,
	compressionMs: 500
};

describe('reportNarCompression', () => {
	it.each([
		{ frames: 4, framesText: '4 frames' },
		{ frames: 1, framesText: '1 frame' }
	])(
		'reports a NAR of $frames frames at debug level',
		({ frames, framesText }) => {
			const infos: unknown[] = [];

			reportNarCompression(
				{
					info: (message, presentation) => {
						infos.push({ message, presentation });
					}
				},
				'app',
				{ ...facts, frames }
			);

			expect(infos).toStrictEqual([
				{
					message: `app: compressed ${formatBytes(64_000_000)} of NAR to ${formatBytes(8_000_000)} in ${framesText}; the upload waited ${formatDuration(500)} for the NAR to be read and compressed`,
					presentation: { level: 'debug' }
				}
			]);
		}
	);
});

describe('CompressionTotals', () => {
	it('sums the NARs and records the peak RSS', () => {
		const totals = new CompressionTotals();

		totals.add(facts);
		totals.add({
			narBytes: 1000,
			compressedBytes: 100,
			frames: 1,
			compressionMs: 0.4
		});

		expect(totals.summary(300_000_000)).toStrictEqual({
			narBytes: 64_001_000,
			compressedBytes: 8_000_100,
			frames: 5,
			compressionMs: 500,
			peakRssBytes: 300_000_000
		});
	});

	it('has no summary before any NAR is compressed', () => {
		expect(new CompressionTotals().summary(300_000_000)).toBeUndefined();
	});
});

describe('compressionRows', () => {
	it.each([
		{
			name: 'a measured compression time',
			compressionMs: 500,
			rows: [
				{ label: 'NAR bytes compressed', value: formatBytes(64_000_000) },
				{ label: 'Compressed bytes', value: formatBytes(8_000_000) },
				{
					label: 'Compression rate per upload worker',
					value: `${formatBytes(128_000_000)}/s`
				},
				{ label: 'Peak memory', value: formatBytes(300_000_000) }
			]
		},
		{
			name: 'no measurable compression time',
			compressionMs: 0,
			rows: [
				{ label: 'NAR bytes compressed', value: formatBytes(64_000_000) },
				{ label: 'Compressed bytes', value: formatBytes(8_000_000) },
				{ label: 'Peak memory', value: formatBytes(300_000_000) }
			]
		}
	])('lists the totals for $name', ({ compressionMs, rows }) => {
		expect(
			compressionRows({
				narBytes: 64_000_000,
				compressedBytes: 8_000_000,
				frames: 4,
				compressionMs,
				peakRssBytes: 300_000_000
			})
		).toStrictEqual(rows);
	});
});
