import { formatBytes, formatDuration } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	compressionRows,
	CompressionTotals,
	reportNarCompression,
	transferRows,
	TransferTotals,
	uploadObserver
} from './compression-report.ts';
import type { NarTransferFacts } from './nar-upload.ts';

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

const streamedTransfer: NarTransferFacts = {
	isSingleRequest: false,
	bufferedParts: 3,
	streamedParts: 2,
	retries: 1,
	recompressions: 1,
	resentBytes: 4_194_304,
	paddingBytes: 1000
};

const singleRequestTransfer: NarTransferFacts = {
	isSingleRequest: true,
	bufferedParts: 0,
	streamedParts: 0,
	retries: 0,
	recompressions: 0,
	resentBytes: 0,
	paddingBytes: 0
};

describe('uploadObserver', () => {
	it('reports parts and retries at debug level, and recompressed and padded parts as warnings', () => {
		const messages: unknown[] = [];
		let bytes = 0;
		const observer = uploadObserver(
			{
				info: (message, presentation) => {
					messages.push({ info: message, presentation });
				},
				warn: (label, value) => {
					messages.push({ warn: label, value });
				}
			},
			'app',
			(count) => {
				bytes += count;
			}
		);

		observer.onBytes?.(1000);
		observer.onPart?.({
			partNumber: 1,
			mode: 'single-request',
			bytes: 1000,
			attempts: 1,
			durationMs: 20,
			outcome: 'sent'
		});
		observer.onPart?.({
			partNumber: 2,
			mode: 'streamed',
			bytes: 8_388_608,
			attempts: 2,
			durationMs: 1500,
			outcome: 'sent'
		});
		observer.onPart?.({
			partNumber: 3,
			mode: 'buffered',
			bytes: 8_388_608,
			attempts: 5,
			durationMs: 3000,
			outcome: 'failed'
		});
		observer.onRetry?.({
			target: { kind: 'part', partNumber: 2 },
			attempt: 1,
			reason: 'ECONNRESET'
		});
		observer.onRetry?.({
			target: { kind: 'request', operation: 'CreateMultipartUpload' },
			attempt: 1,
			reason: 'SlowDown'
		});
		observer.onRecompression?.({
			partNumber: 2,
			reason: 'idle-timeout',
			narBytes: 20_000_000,
			compressedBytes: 4_000_000,
			durationMs: 250
		});
		observer.onPadding?.({
			partNumber: 4,
			bytes: 1000,
			continuesIntoNextPart: false
		});
		observer.onPadding?.({
			partNumber: 5,
			bytes: 70_000,
			continuesIntoNextPart: true
		});

		expect({ bytes, messages }).toStrictEqual({
			bytes: 1000,
			messages: [
				{
					info: `app: sent the NAR in one request of ${formatBytes(1000)} in ${formatDuration(20)} after 1 attempt`,
					presentation: { level: 'debug' }
				},
				{
					info: `app: sent part 2 (streamed, ${formatBytes(8_388_608)}) in ${formatDuration(1500)} after 2 attempts`,
					presentation: { level: 'debug' }
				},
				{
					info: `app: part 3 (buffered, ${formatBytes(8_388_608)}) failed after 5 attempts in ${formatDuration(3000)}`,
					presentation: { level: 'debug' }
				},
				{
					info: 'app: part 2 will be sent again after attempt 1 failed: ECONNRESET',
					presentation: { level: 'debug' }
				},
				{
					info: 'app: CreateMultipartUpload will be sent again after attempt 1 failed: SlowDown',
					presentation: { level: 'debug' }
				},
				{
					warn: 'app',
					value: `part 2 failed (idle-timeout), so ${formatBytes(20_000_000)} of NAR were recompressed from the store in ${formatDuration(250)} to send ${formatBytes(4_000_000)} again`
				},
				{
					warn: 'app',
					value: `the compressed NAR ended inside part 4, so a skippable frame of ${formatBytes(1000)} filled the rest of the part`
				},
				{
					warn: 'app',
					value: `the compressed NAR ended inside part 5, so a skippable frame of ${formatBytes(70_000)} filled the rest of the part and one more part`
				}
			]
		});
	});
});

describe('TransferTotals', () => {
	it('sums the NARs', () => {
		const totals = new TransferTotals();

		totals.add(streamedTransfer);
		totals.add(singleRequestTransfer);
		totals.add({ ...streamedTransfer, retries: 0, recompressions: 0 });

		expect(totals.summary()).toStrictEqual({
			singleRequestUploads: 1,
			partsSent: 10,
			bufferedParts: 6,
			streamedParts: 4,
			retries: 1,
			recompressions: 1,
			resentBytes: 8_388_608,
			paddingBytes: 2000
		});
	});

	it('has no summary before any NAR is uploaded', () => {
		expect(new TransferTotals().summary()).toBeUndefined();
	});
});

describe('transferRows', () => {
	const quiet = {
		singleRequestUploads: 4,
		partsSent: 5,
		bufferedParts: 3,
		streamedParts: 2,
		retries: 0,
		recompressions: 0,
		resentBytes: 0,
		paddingBytes: 0
	};

	it.each([
		{
			name: 'a run without failures or padding',
			summary: quiet,
			rows: [
				{ label: 'Single-request uploads', value: '4' },
				{ label: 'Parts sent', value: '5' },
				{ label: 'Buffered parts', value: '3' },
				{ label: 'Streamed parts', value: '2' }
			]
		},
		{
			name: 'a run with retries, recompressed parts and padding',
			summary: {
				...quiet,
				retries: 2,
				recompressions: 1,
				resentBytes: 4_194_304,
				paddingBytes: 1000
			},
			rows: [
				{ label: 'Single-request uploads', value: '4' },
				{ label: 'Parts sent', value: '5' },
				{ label: 'Buffered parts', value: '3' },
				{ label: 'Streamed parts', value: '2' },
				{ label: 'Requests sent again', value: '2' },
				{ label: 'Parts recompressed', value: '1' },
				{ label: 'Bytes sent again', value: formatBytes(4_194_304) },
				{ label: 'Padding bytes', value: formatBytes(1000) }
			]
		}
	])('lists the totals for $name', ({ summary, rows }) => {
		expect(transferRows(summary)).toStrictEqual(rows);
	});
});
