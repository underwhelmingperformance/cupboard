import { type StorePathHash } from '@cupboard/nix-store/scalars';

import { type CacheId } from '../db/cache.ts';

/**
The paths of one cache that a caller watches for demotion, and the ones
demoted since the watch began.
*/
export class NarInfoDemotionWatch {
	private readonly demoted = new Set<StorePathHash>();

	constructor(
		private readonly cacheId: CacheId,
		private readonly storePathHashes: ReadonlySet<StorePathHash>
	) {}

	noteDemotion(cacheId: CacheId, storePathHash: StorePathHash): void {
		if (cacheId !== this.cacheId || !this.storePathHashes.has(storePathHash)) {
			return;
		}

		this.demoted.add(storePathHash);
	}

	wasDemoted(storePathHash: StorePathHash): boolean {
		return this.demoted.has(storePathHash);
	}
}

/**
Tells a caller which of its paths lost their narinfo object to demotion
while it worked outside the critical section.

Demotion deletes a path's narinfo object in R2 and leaves the path's row in
SQLite unchanged, so a recheck of the row cannot detect it. A caller that
probes servability before its critical section watches the probed paths
and, inside the section, treats a demoted path as unservable. The registry
can remain in memory: the probe and the section run in the same instance,
and the caller's request ends with the instance.
*/
export class NarInfoDemotionWatches {
	private readonly watches = new Set<NarInfoDemotionWatch>();

	async watching<T>(
		cacheId: CacheId,
		storePathHashes: readonly StorePathHash[],
		run: (watch: NarInfoDemotionWatch) => Promise<T>
	): Promise<T> {
		const watch = new NarInfoDemotionWatch(cacheId, new Set(storePathHashes));
		this.watches.add(watch);

		try {
			return await run(watch);
		} finally {
			this.watches.delete(watch);
		}
	}

	record(cacheId: CacheId, storePathHash: StorePathHash): void {
		for (const watch of this.watches) {
			watch.noteDemotion(cacheId, storePathHash);
		}
	}
}
