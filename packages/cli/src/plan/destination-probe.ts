import { withReadAuthentication } from '@cupboard/nix';
import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheScope,
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
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { basicAuthHeader, type BasicCredential } from '@cupboard/shared/http';
import { readResponseJson } from '@cupboard/shared/response-body';
import { StatusCodes } from 'http-status-codes';

import type { DestinationProbes } from './availability-partition.ts';
import {
	DestinationProbeResponseError,
	PrivateViewReadRefusedError
} from './destination-probe-errors.ts';

const readRefusalStatuses: ReadonlySet<number> = new Set([
	StatusCodes.UNAUTHORIZED,
	StatusCodes.FORBIDDEN
]);
const maximumConcurrentProbes = 4;
const maximumProbeResponseBytes = 16 * 1024 * 1024;

export interface DestinationProbeOptions {
	readonly paths: readonly StorePathString[];
	readonly credentials?: BasicCredential;
	readonly fetcher?: typeof fetch;
}

export function destinationServedPaths(
	options: DestinationProbeOptions & {
		readonly baseUrl: URL;
		readonly cache: CacheScope;
	}
): Promise<ReadonlySet<StorePathString>> {
	return availablePathsAt(
		cacheUrl(options.baseUrl, options.cache),
		{
			...options,
			fetcher: withReadAuthentication(options.fetcher ?? fetch, {
				tenantUrl: options.baseUrl
			})
		},
		cacheAvailabilityMaxPaths
	);
}

/**
 * Reuse-view results permit publication by reference; they do not show that the
 * destination cache serves or retains a path.
 */
export async function viewServedPaths(
	options: DestinationProbeOptions & {
		readonly baseUrl: URL;
		readonly view: string;
	}
): Promise<ReadonlySet<StorePathString>> {
	try {
		return await availablePathsAt(
			reuseViewUrl(options.baseUrl, options.view.trim()),
			{
				...options,
				fetcher: withReadAuthentication(options.fetcher ?? fetch, {
					tenantUrl: options.baseUrl
				})
			},
			reuseViewAvailabilityMaxPaths
		);
	} catch (error) {
		if (
			error instanceof DestinationProbeResponseError &&
			readRefusalStatuses.has(error.status)
		) {
			throw new PrivateViewReadRefusedError(error.url, error.status);
		}
		throw error;
	}
}

export interface TenantProbeOptions {
	readonly baseUrl: URL;
	readonly cache: CacheScope;
	readonly view?: string;
	readonly credentials?: BasicCredential;
	/**
	Overrides credentials for view reads; other probes keep credentials.
	*/
	readonly viewCredentials?: BasicCredential;
	readonly fetcher?: typeof fetch;
}

export function tenantProbesFor(
	options: TenantProbeOptions
): DestinationProbes {
	const shared = {
		baseUrl: options.baseUrl,
		...(options.credentials !== undefined && {
			credentials: options.credentials
		}),
		...(options.fetcher !== undefined && { fetcher: options.fetcher })
	};
	const view = options.view;

	return {
		destinationServed: (paths) =>
			destinationServedPaths({ ...shared, paths, cache: options.cache }),
		viewServed: (paths) =>
			// Do not make a request when no reuse view is configured.
			view === undefined
				? Promise.resolve(new Set())
				: viewServedPaths({
						...shared,
						paths,
						view,
						...(options.viewCredentials !== undefined && {
							credentials: options.viewCredentials
						})
					})
	};
}

// Cache indexes paths by their hash component. Send one request per distinct
// hash and apply its result to every path in that group.
function pathsByStorePathHash(
	paths: readonly StorePathString[]
): ReadonlyMap<StorePathHash, readonly StorePathString[]> {
	const grouped = new Map<StorePathHash, StorePathString[]>();
	const uniquePaths = new Set(paths);

	for (const storePath of uniquePaths) {
		const hash = StorePath.hash(storePath);
		const matching = grouped.get(hash) ?? [];
		matching.push(storePath);
		grouped.set(hash, matching);
	}

	return grouped;
}

async function availablePathsAt(
	probeUrl: URL,
	options: DestinationProbeOptions,
	maximumBatchSize: number
): Promise<Set<StorePathString>> {
	const pathsByHash = pathsByStorePathHash(options.paths);

	if (pathsByHash.size === 0) {
		return new Set();
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
		await discardResponseBody(response);
		throw new DestinationProbeResponseError(target, response.status);
	}

	let value: unknown;

	try {
		value = await readResponseJson(response, {
			description: `Destination availability response from ${target}`,
			maximumBytes: maximumProbeResponseBytes
		});
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
