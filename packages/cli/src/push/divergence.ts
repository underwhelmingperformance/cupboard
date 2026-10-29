import type { StorePathString } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type DivergenceSummaryInput,
	divergenceSummaryResultKind
} from '@cupboard/protocol/reports';
import type { Reporter } from '@cupboard/reporter';

export interface NarDivergence {
	readonly storePath: StorePathString;
	readonly localNarHash: string;
	readonly cacheNarHash: string;
}

export function narDivergence(
	storePath: StorePathString,
	localNarHash: string,
	cacheNarHash: string
): NarDivergence | undefined {
	if (localNarHash === cacheNarHash) {
		return undefined;
	}

	return { storePath, localNarHash, cacheNarHash };
}

/**
Reports every path that kept the cache's copy in one warning. The NAR hashes
appear at debug level and in the warning's value.
*/
export function warnDivergences(
	reporter: Pick<Reporter, 'warn' | 'presentation'>,
	diverged: readonly NarDivergence[]
): void {
	if (diverged.length === 0) {
		return;
	}

	const lead =
		'The cache already serves different contents for these paths and keeps its own copies';
	const checksums = diverged
		.map(
			(divergence) =>
				`${StorePath.basename(divergence.storePath)} (local ${divergence.localNarHash}, cache ${divergence.cacheNarHash})`
		)
		.join(', ');
	const names = diverged
		.map((divergence) => StorePath.basename(divergence.storePath))
		.join(', ');

	reporter.warn('diverged', checksums, {
		humanMessage:
			reporter.presentation === 'debug'
				? `${lead}: ${checksums}. Check the builds for reproducibility.`
				: `${lead}: ${names}. Check the builds for reproducibility. Use --debug to compare the checksums.`
	});
}

/**
Warns about every path that kept the cache's copy and records the paths with
both NAR hashes in a `divergence-summary` result. The result has no rows, so
only the JSON output and the result file show it.
*/
export function reportDivergences(
	reporter: Pick<Reporter, 'warn' | 'presentation' | 'result'>,
	diverged: readonly NarDivergence[]
): void {
	if (diverged.length === 0) {
		return;
	}

	warnDivergences(reporter, diverged);

	const data: DivergenceSummaryInput = { diverged: [...diverged] };

	reporter.result({ kind: divergenceSummaryResultKind, data, rows: [] });
}
