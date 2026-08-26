import type { StorePathString } from '@cupboard/nix-store/scalars';

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
