import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	type StorePathString,
	type TenantId
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	type CacheMetadataEntry,
	cacheMetadataMaxNarInfoBytes
} from '@cupboard/protocol/cache-metadata';
import { type DrizzleD1Database } from 'drizzle-orm/d1';

import { isNarInfoObjectOfCommit } from '../blob/narinfo-object-metadata.ts';
import * as d1Schema from '../db/d1-schema.ts';
import { chunk, maxOutgoingConnections } from '../do/bulk.ts';
import { requireSubrequestsFor } from '../do/subrequest-slice.ts';
import {
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError,
	SharedFactsUnavailableError
} from '../errors.ts';
import { narInfoObjectKey } from '../http/http.ts';

import { authorisedNarInfoVersions, type ReadScope } from './read.ts';

const utf8 = new TextEncoder();

/**
 * Serialises a complete narinfo only when its full store path matches the
 * requested path. The per-narinfo bound applies before JSON encoding.
 */
export function renderCacheMetadataEntry(
	storePath: StorePathString,
	metadata: NarInfo | string | undefined
): CacheMetadataEntry {
	if (metadata === undefined) {
		return { storePath, status: 'missing' };
	}

	let narInfo: NarInfo;
	let narinfo: string;

	try {
		narInfo = typeof metadata === 'string' ? NarInfo.parse(metadata) : metadata;
		narinfo = narInfo.render();
	} catch (error) {
		throw new MetadataNarInfoInvalidError(storePath, error);
	}

	if (narInfo.storePath.value !== storePath) {
		throw new MetadataNarInfoInvalidError(
			storePath,
			new Error(
				`The narinfo describes ${narInfo.storePath.value}, not the requested store path`
			)
		);
	}

	if (utf8.encode(narinfo).byteLength > cacheMetadataMaxNarInfoBytes) {
		throw new MetadataNarInfoTooLargeError(
			storePath,
			cacheMetadataMaxNarInfoBytes
		);
	}

	return { storePath, status: 'found', narinfo };
}

async function sharedRead<T>(read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (error) {
		throw new SharedFactsUnavailableError(error);
	}
}

async function boundedNarInfoText(
	object: R2ObjectBody,
	storePath: StorePathString
): Promise<string> {
	if (object.size > cacheMetadataMaxNarInfoBytes) {
		await sharedRead(() => object.body.cancel());
		throw new MetadataNarInfoTooLargeError(
			storePath,
			cacheMetadataMaxNarInfoBytes
		);
	}

	const reader = object.body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
	const parts: string[] = [];
	let bytes = 0;

	try {
		for (;;) {
			const result = await sharedRead(() => reader.read());

			if (result.done) {
				parts.push(decoder.decode());
				return parts.join('');
			}

			const value: unknown = result.value;

			if (!(value instanceof Uint8Array)) {
				throw new TypeError('The R2 narinfo body returned a non-byte chunk');
			}

			bytes += value.byteLength;

			if (bytes > cacheMetadataMaxNarInfoBytes) {
				await sharedRead(() => reader.cancel());
				throw new MetadataNarInfoTooLargeError(
					storePath,
					cacheMetadataMaxNarInfoBytes
				);
			}

			parts.push(decoder.decode(value, { stream: true }));
		}
	} catch (error) {
		if (
			error instanceof SharedFactsUnavailableError ||
			error instanceof MetadataNarInfoTooLargeError
		) {
			throw error;
		}

		await sharedRead(() => reader.cancel());
		throw new MetadataNarInfoInvalidError(storePath, error);
	} finally {
		reader.releaseLock();
	}
}

/**
 * Reads the current committed narinfos in request order. Each group reads at
 * most six bounded R2 bodies before yielding its entries, so a caller can stop
 * after a response prefix without retaining every requested narinfo.
 */
export async function* readCacheMetadata(
	blobs: R2Bucket,
	database: DrizzleD1Database<typeof d1Schema>,
	tenant: TenantId,
	cache: ReadScope,
	storePaths: readonly StorePathString[]
): AsyncGenerator<CacheMetadataEntry> {
	const versions = await authorisedNarInfoVersions(
		database,
		tenant,
		cache.scope,
		storePaths.map((storePath) => StorePath.hash(storePath))
	);
	const readEntry = async (
		storePath: StorePathString
	): Promise<CacheMetadataEntry> => {
		const hash = StorePath.hash(storePath);
		const current = versions.get(hash);

		if (current?.cacheGeneration !== cache.generation) {
			return { storePath, status: 'missing' };
		}

		const object = await sharedRead(() =>
			blobs.get(narInfoObjectKey(tenant, hash, cache.scope, cache.generation))
		);

		if (object === null) {
			return { storePath, status: 'missing' };
		}

		if (!isNarInfoObjectOfCommit(object, current)) {
			await sharedRead(() => object.body.cancel());
			return { storePath, status: 'missing' };
		}

		const text = await boundedNarInfoText(object, storePath);
		let narInfo: NarInfo;

		try {
			narInfo = NarInfo.parse(text);
		} catch (error) {
			throw new MetadataNarInfoInvalidError(storePath, error);
		}

		if (narInfo.narHash.toString() !== current.narHash) {
			throw new MetadataNarInfoInvalidError(
				storePath,
				new Error('The narinfo body disagrees with its committed NAR hash')
			);
		}

		return renderCacheMetadataEntry(storePath, narInfo);
	};

	for (const paths of chunk(storePaths, maxOutgoingConnections)) {
		requireSubrequestsFor(paths.length, 'cache metadata probe');
		const entries = await Promise.allSettled(
			paths.map((storePath) => readEntry(storePath))
		);
		const failed = entries.find((entry) => entry.status === 'rejected');

		if (failed !== undefined) {
			const error: unknown = failed.reason;
			throw error;
		}

		for (const entry of entries) {
			if (entry.status === 'fulfilled') {
				yield entry.value;
			}
		}
	}
}
