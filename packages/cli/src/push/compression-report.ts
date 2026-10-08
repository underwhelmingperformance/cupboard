import process from 'node:process';

import type { CompressionSummary } from '@cupboard/protocol/reports';
import {
	formatBytes,
	formatCount,
	formatDuration,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';

import type { NarCompressionFacts } from '../nix/blob.ts';

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
