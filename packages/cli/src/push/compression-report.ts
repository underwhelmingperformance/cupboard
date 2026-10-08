import process from 'node:process';

import type {
	CompressionSummary,
	TransferSummary
} from '@cupboard/protocol/reports';
import {
	formatBytes,
	formatCount,
	formatDuration,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';

import type { NarCompressionFacts } from '../nix/blob.ts';

import type {
	NarPartReport,
	NarTransferFacts,
	NarUploadObserver
} from './nar-upload.ts';

/**
 * Returns the process's peak resident set size in bytes.
 */
export type PeakRssSampler = () => number;

export const processPeakRss: PeakRssSampler = () =>
	process.resourceUsage().maxRSS * 1024;

export function reportNarCompression(
	reporter: Pick<Reporter, 'info'>,
	storePathName: string,
	facts: NarCompressionFacts
): void {
	reporter.info(
		`${storePathName}: compressed ${formatBytes(facts.narBytes)} of NAR to ${formatBytes(facts.compressedBytes)} in ${formatCount(facts.frames)} ${facts.frames === 1 ? 'frame' : 'frames'}; the upload waited ${formatDuration(Math.round(facts.compressionMs))} for the NAR to be read and compressed`,
		{ level: 'debug' }
	);
}

/**
 * Adds up what a run compressed, for its summary.
 */
export class CompressionTotals {
	private narBytes = 0;

	private compressedBytes = 0;

	private frames = 0;

	private compressionMs = 0;

	private nars = 0;

	add(facts: NarCompressionFacts): void {
		this.narBytes += facts.narBytes;
		this.compressedBytes += facts.compressedBytes;
		this.frames += facts.frames;
		this.compressionMs += facts.compressionMs;
		this.nars += 1;
	}

	/**
	 * Returns the totals with the given peak RSS, or `undefined` when the run
	 * compressed no NAR.
	 */
	summary(peakRssBytes: number): CompressionSummary | undefined {
		if (this.nars === 0) {
			return undefined;
		}

		return {
			narBytes: this.narBytes,
			compressedBytes: this.compressedBytes,
			frames: this.frames,
			compressionMs: Math.round(this.compressionMs),
			peakRssBytes
		};
	}
}

/**
 * The summary rows for a run's compression. The rate is the NAR bytes divided
 * by the time that uploads waited for their NARs to be read and compressed.
 * The waits of concurrent uploads are added together, so this is the average
 * rate of one upload worker, not of the whole run. The rate is omitted when the
 * summed wait rounds to zero.
 */
export function compressionRows(summary: CompressionSummary): ResultRow[] {
	return [
		{ label: 'NAR bytes compressed', value: formatBytes(summary.narBytes) },
		{ label: 'Compressed bytes', value: formatBytes(summary.compressedBytes) },
		...(summary.compressionMs > 0
			? [
					{
						label: 'Compression rate per upload worker',
						value: `${formatBytes((summary.narBytes * 1000) / summary.compressionMs)}/s`
					}
				]
			: []),
		{ label: 'Peak memory', value: formatBytes(summary.peakRssBytes) }
	];
}

/**
 * Reports one NAR's upload as it happens: each part at debug level, each
 * request that will be sent again at debug level, and each part that was
 * recompressed from the store or padded as a warning. `onBytes` receives the
 * number of bytes added to the stored object.
 */
export function uploadObserver(
	reporter: Pick<Reporter, 'info' | 'warn'>,
	storePathName: string,
	onBytes?: (count: number) => void
): NarUploadObserver {
	return {
		...(onBytes !== undefined && { onBytes }),
		onPart: (report) => {
			reporter.info(`${storePathName}: ${partMessage(report)}`, {
				level: 'debug'
			});
		},
		onRetry: (report) => {
			const request =
				report.target.kind === 'part'
					? `part ${String(report.target.partNumber)}`
					: report.target.operation;

			reporter.info(
				`${storePathName}: ${request} will be sent again after attempt ${String(report.attempt)} failed: ${report.reason}`,
				{ level: 'debug' }
			);
		},
		onRecompression: (report) => {
			reporter.warn(
				storePathName,
				`part ${String(report.partNumber)} failed (${report.reason}), so ${formatBytes(report.narBytes)} of NAR were recompressed from the store in ${formatDuration(Math.round(report.durationMs))} to send ${formatBytes(report.compressedBytes)} again`
			);
		},
		onPadding: (report) => {
			const parts = report.continuesIntoNextPart
				? 'the rest of the part and one more part'
				: 'the rest of the part';

			reporter.warn(
				storePathName,
				`the compressed NAR ended inside part ${String(report.partNumber)}, so a skippable frame of ${formatBytes(report.bytes)} filled ${parts}`
			);
		}
	};
}

function partMessage(report: NarPartReport): string {
	const duration = formatDuration(Math.round(report.durationMs));
	const attempts = `${formatCount(report.attempts)} ${report.attempts === 1 ? 'attempt' : 'attempts'}`;

	if (report.mode === 'single-request') {
		return report.outcome === 'sent'
			? `sent the NAR in one request of ${formatBytes(report.bytes)} in ${duration} after ${attempts}`
			: `the single request (${formatBytes(report.bytes)}) failed after ${attempts} in ${duration}`;
	}

	const part = `part ${String(report.partNumber)} (${report.mode}, ${formatBytes(report.bytes)})`;

	return report.outcome === 'sent'
		? `sent ${part} in ${duration} after ${attempts}`
		: `${part} failed after ${attempts} in ${duration}`;
}

/**
 * Adds up how a run sent its NARs, for its summary.
 */
export class TransferTotals {
	private nars = 0;

	private singleRequestUploads = 0;

	private bufferedParts = 0;

	private streamedParts = 0;

	private retries = 0;

	private recompressions = 0;

	private resentBytes = 0;

	private paddingBytes = 0;

	add(facts: NarTransferFacts): void {
		this.nars += 1;
		this.singleRequestUploads += facts.isSingleRequest ? 1 : 0;
		this.bufferedParts += facts.bufferedParts;
		this.streamedParts += facts.streamedParts;
		this.retries += facts.retries;
		this.recompressions += facts.recompressions;
		this.resentBytes += facts.resentBytes;
		this.paddingBytes += facts.paddingBytes;
	}

	/**
	 * Returns the totals, or `undefined` when the run uploaded no NAR.
	 */
	summary(): TransferSummary | undefined {
		if (this.nars === 0) {
			return undefined;
		}

		return {
			singleRequestUploads: this.singleRequestUploads,
			partsSent: this.bufferedParts + this.streamedParts,
			bufferedParts: this.bufferedParts,
			streamedParts: this.streamedParts,
			retries: this.retries,
			recompressions: this.recompressions,
			resentBytes: this.resentBytes,
			paddingBytes: this.paddingBytes
		};
	}
}

/**
 * The summary rows for how a run sent its NARs. The rows for requests sent
 * again, parts recompressed, bytes sent again and padding appear only when
 * their totals are not zero.
 */
export function transferRows(summary: TransferSummary): ResultRow[] {
	const optional: readonly [string, number, string][] = [
		['Requests sent again', summary.retries, formatCount(summary.retries)],
		[
			'Parts recompressed',
			summary.recompressions,
			formatCount(summary.recompressions)
		],
		['Bytes sent again', summary.resentBytes, formatBytes(summary.resentBytes)],
		['Padding bytes', summary.paddingBytes, formatBytes(summary.paddingBytes)]
	];

	return [
		{
			label: 'Single-request uploads',
			value: formatCount(summary.singleRequestUploads)
		},
		{ label: 'Parts sent', value: formatCount(summary.partsSent) },
		{ label: 'Buffered parts', value: formatCount(summary.bufferedParts) },
		{ label: 'Streamed parts', value: formatCount(summary.streamedParts) },
		...optional
			.filter(([, total]) => total > 0)
			.map(([label, , value]) => ({ label, value }))
	];
}
