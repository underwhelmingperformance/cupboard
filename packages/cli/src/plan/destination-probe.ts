import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import {
	type StoredCache,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	cacheAvailabilityMaxPaths,
	cacheAvailabilityResponseSchema,
	reuseViewAvailabilityMaxPaths
} from '@cupboard/protocol/cache-availability';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type BasicCredential } from '@cupboard/shared/http';

import { DestinationProbeResponseError } from './destination-probe-errors.ts';

const maximumConcurrentProbes = 4;

export interface DestinationProbeOptions {
	readonly paths: readonly StorePathString[];
	readonly credentials?: BasicCredential;
	readonly fetcher?: typeof fetch;
}

/** Which of `paths` the destination cache already serves. */
export function destinationServedPaths(
	options: DestinationProbeOptions & {
		readonly baseUrl: URL;
		readonly cache: StoredCache;
	}
): Promise<ReadonlySet<StorePathString>> {
	return availablePathsAt(
		cacheUrl(options.baseUrl, options.cache),
		options,
		cacheAvailabilityMaxPaths
	);
}

/**
 * Which of `paths` a named tenant reuse view serves. A separate fact from
 * destination availability: it says where a shared output can be
 * substituted from, never whether the destination retains it.
 */
export function viewServedPaths(
	options: DestinationProbeOptions & {
		readonly baseUrl: URL;
		readonly view: string;
	}
): Promise<ReadonlySet<StorePathString>> {
	return availablePathsAt(
		reuseViewUrl(options.baseUrl, options.view.trim()),
		options,
		reuseViewAvailabilityMaxPaths
	);
}

async function availablePathsAt(
	probeUrl: URL,
	options: DestinationProbeOptions,
	maximumBatchSize: number
): Promise<Set<StorePathString>> {
	const paths = new Set(options.paths).values().toArray();

	if (paths.length === 0) {
		return new Set();
	}

	const pathsByHash = new Map<StorePathHash, StorePathString[]>();

	for (const storePath of paths) {
		const hash = StorePath.hash(storePath);
		const matching = pathsByHash.get(hash) ?? [];
		matching.push(storePath);
		pathsByHash.set(hash, matching);
	}

	const batches = chunk(pathsByHash.keys().toArray(), maximumBatchSize);
	const fetcher = options.fetcher ?? fetch;
	const headers = {
		'content-type': 'application/json',
		...(options.credentials !== undefined &&
			basicAuthHeader(options.credentials))
	};
	const missingBatches = await mapWithConcurrency(
		batches,
		maximumConcurrentProbes,
		(batch) => queryMissingStorePathHashes(fetcher, probeUrl, batch, headers)
	);
	const missing = new Set(missingBatches.flat());
	const available = new Set<StorePathString>();

	for (const [hash, matchingPaths] of pathsByHash) {
		if (missing.has(hash)) {
			continue;
		}

		for (const storePath of matchingPaths) {
			available.add(storePath);
		}
	}

	return available;
}

async function queryMissingStorePathHashes(
	fetcher: typeof fetch,
	probeUrl: URL,
	storePathHashes: readonly StorePathHash[],
	headers: Readonly<Record<string, string>>
): Promise<StorePathHash[]> {
	const target = `${canonicalHref(probeUrl)}/api/v1/missing-paths`;
	const response = await fetcher(target, {
		method: 'POST',
		headers,
		body: JSON.stringify({ storePathHashes })
	});

	if (!response.ok) {
		await response.body?.cancel();
		throw new DestinationProbeResponseError(target, response.status);
	}

	let value: unknown;

	try {
		value = await response.json();
	} catch (error) {
		throw new DestinationProbeResponseError(
			target,
			response.status,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	const parsed = cacheAvailabilityResponseSchema.safeParse(value);

	if (!parsed.success) {
		throw new DestinationProbeResponseError(
			target,
			response.status,
			parsed.error
		);
	}

	return parsed.data.missingStorePathHashes;
}
