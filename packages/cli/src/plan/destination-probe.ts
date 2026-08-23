import { cacheUrl, reuseViewUrl } from '@cupboard/nix-store/cache-url';
import {
	type StoredCache,
	type StorePathHash,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { canonicalHref } from '@cupboard/nix-store/url';
import { attestationListSchema } from '@cupboard/protocol/attestations';
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
import { isSlsaProvenanceType } from '@cupboard/shared/slsa';
import { StatusCodes } from 'http-status-codes';

import type { DestinationProbes } from './availability-partition.ts';
import { DestinationProbeResponseError } from './destination-probe-errors.ts';

const maximumConcurrentProbes = 4;
const maximumProbeResponseBytes = 16 * 1024 * 1024;
const notFoundStatus: number = StatusCodes.NOT_FOUND;

export interface DestinationProbeOptions {
	readonly paths: readonly StorePathString[];
	readonly credentials?: BasicCredential;
	readonly fetcher?: typeof fetch;
}

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
 * Reuse-view results permit publication by reference; they do not show that the
 * destination cache serves or retains a path.
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

/**
 * The cache serves one attestation list per store-path hash, so this probe
 * requests each distinct hash once. A 404 means that the path has no
 * attestation.
 *
 * A cupboard build-origin statement is not sufficient evidence. It covers all
 * paths published by a run, including paths copied into the run's store, and
 * therefore does not prove that the workflow built a path.
 */
export function attestedServedPaths(
	options: DestinationProbeOptions & {
		readonly baseUrl: URL;
		readonly cache: StoredCache;
	}
): Promise<ReadonlySet<StorePathString>> {
	return attestedPathsAt(cacheUrl(options.baseUrl, options.cache), options);
}

export interface TenantProbeOptions {
	readonly baseUrl: URL;
	readonly cache: StoredCache;
	readonly view?: string;
	readonly credentials?: BasicCredential;
	readonly fetcher?: typeof fetch;
}

export interface TenantProbes extends DestinationProbes {
	readonly attestedServed: (
		paths: readonly StorePathString[]
	) => Promise<ReadonlySet<StorePathString>>;
}

export function tenantProbesFor(options: TenantProbeOptions): TenantProbes {
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
				: viewServedPaths({ ...shared, paths, view }),
		attestedServed: (paths) =>
			attestedServedPaths({ ...shared, paths, cache: options.cache })
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

async function attestedPathsAt(
	probeUrl: URL,
	options: DestinationProbeOptions
): Promise<Set<StorePathString>> {
	const pathsByHash = pathsByStorePathHash(options.paths);

	if (pathsByHash.size === 0) {
		return new Set();
	}

	const fetcher = options.fetcher ?? fetch;
	const headers = {
		...(options.credentials !== undefined &&
			basicAuthHeader(options.credentials))
	};
	const answers = await mapWithConcurrency(
		pathsByHash.keys().toArray(),
		maximumConcurrentProbes,
		async (hash) =>
			[hash, await hasAttestation(fetcher, probeUrl, hash, headers)] as const
	);
	const attested = new Set<StorePathString>();

	for (const [hash, isAttested] of answers) {
		if (!isAttested) {
			continue;
		}

		const matchingPaths = pathsByHash.get(hash) ?? [];

		for (const storePath of matchingPaths) {
			attested.add(storePath);
		}
	}

	return attested;
}

async function hasAttestation(
	fetcher: typeof fetch,
	probeUrl: URL,
	storePathHash: StorePathHash,
	headers: Readonly<Record<string, string>>
): Promise<boolean> {
	const target = `${canonicalHref(probeUrl)}/attestations/${storePathHash}`;
	const response = await fetcher(target, { headers });

	if (response.status === notFoundStatus) {
		await discardResponseBody(response);

		return false;
	}

	if (!response.ok) {
		await discardResponseBody(response);
		throw new DestinationProbeResponseError(target, response.status);
	}

	let value: unknown;

	try {
		value = await readResponseJson(response, {
			description: `Destination attestation response from ${target}`,
			maximumBytes: maximumProbeResponseBytes
		});
	} catch (error) {
		throw new DestinationProbeResponseError(
			target,
			response.status,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	const parsed = attestationListSchema.safeParse(value);

	if (!parsed.success) {
		throw new DestinationProbeResponseError(
			target,
			response.status,
			parsed.error
		);
	}

	return parsed.data.attestations.some((descriptor) =>
		isSlsaProvenanceType(descriptor.predicateType)
	);
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
