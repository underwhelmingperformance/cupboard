import { CacheInfo } from '@cupboard/nix-store/cache-info';
import type { CachePriority } from '@cupboard/nix-store/scalars';
import type { IsoTimestamp } from '@cupboard/protocol/scalars';

import { sha256HexBytes } from '../crypto/crypto.ts';

/**
 * The synthesised `nix-cache-info` object: its rendered bytes, byte length, a
 * content ETag and the cache's creation time. The GET body path and the
 * HEAD/list stat path both derive from this single render so they can never
 * report a different size or ETag for the same object.
 */
export interface RenderedCacheInfoObject {
	readonly body: Uint8Array;
	readonly size: number;
	readonly etag: string;
	readonly lastModified: Date;
}

/**
 * Renders the `nix-cache-info` for a cache from its priority and creation time,
 * using the store's default directory and mass-query settings.
 */
export async function renderNixCacheInfoObject(record: {
	readonly priority: CachePriority;
	readonly createdAt: IsoTimestamp;
}): Promise<RenderedCacheInfoObject> {
	const body = new TextEncoder().encode(
		new CacheInfo(
			CacheInfo.default.storeDirectory,
			CacheInfo.default.hasMassQuery,
			record.priority
		).render()
	);

	return {
		body,
		size: body.length,
		etag: await sha256HexBytes(body),
		lastModified: new Date(record.createdAt)
	};
}
