import { rootLogger } from '@cupboard/logger';
import type { CacheScope, StorePathHash } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import {
	buildInputsMaxLength,
	type BuildInputsRecordEntry,
	buildInputsRecordMaxBuildInputs,
	buildInputsRecordMaxEntries,
	type BuildInputsRecordResponse,
	type BuildInputsRecordResult,
	canStoreBuildInputs
} from '@cupboard/protocol/build-inputs';
import { tenantContract } from '@cupboard/protocol/contract';
import {
	type DependencyStatusEntry,
	dependencyStatusMaxPaths,
	type DependencyStatusResponse
} from '@cupboard/protocol/dependency-status';
import { type RandomSource } from '@cupboard/shared/backoff';
import { chunkByWeight } from '@cupboard/shared/collections';
import { lookupInPages, lookupPage } from '@cupboard/shared/paging';

import {
	DuplicateBuildInputsEntryError,
	PathResponseMismatchError
} from '../errors.ts';

import { type CacheScopedClient, callInCache } from './cache-scoped.ts';
import { procedureDeadline } from './orpc.ts';

export interface DependencyStatusClient {
	readonly dependencyStatus: CacheScopedClient<
		{ storePathHashes: string[] },
		DependencyStatusResponse
	>;
}

export interface BuildInputsRecordClient {
	readonly record: CacheScopedClient<
		{ entries: BuildInputsRecordEntry[] },
		BuildInputsRecordResponse
	>;
}

export interface PagedRequestOptions {
	readonly signal?: AbortSignal;
	/**
	The random source for the backoff before a request is sent again. The
	default is `Math.random`.
	*/
	readonly random?: RandomSource;
}

const dependencyStatusConcurrency = 2;

/**
Reports the state of each store path in `cache`, in the order of
`storePathHashes`. Sends at most `dependencyStatusMaxPaths` hashes in one
request.
*/
export function dependencyStatuses(
	client: DependencyStatusClient,
	cache: CacheScope,
	storePathHashes: readonly StorePathHash[],
	options: PagedRequestOptions = {}
): Promise<DependencyStatusEntry[]> {
	return lookupInPages(storePathHashes, {
		pageSize: dependencyStatusMaxPaths,
		concurrency: dependencyStatusConcurrency,
		deadline: procedureDeadline(
			'uploads.dependencyStatus',
			tenantContract.uploads.dependencyStatus.inDefaultCache,
			options
		),
		request: async (page, signal) => {
			const { paths } = await callInCache(
				client.dependencyStatus,
				cache,
				{ storePathHashes: [...page] },
				{ signal }
			);
			const mismatch = page.findIndex(
				(storePathHash, index) => paths[index]?.storePathHash !== storePathHash
			);

			if (mismatch !== -1 || paths.length !== page.length) {
				throw new PathResponseMismatchError(
					'uploads.dependencyStatus',
					page[mismatch === -1 ? page.length - 1 : mismatch] ?? ''
				);
			}

			return paths;
		}
	});
}

/**
Adds build inputs to the rows that `cache` already has, and returns the result
of each entry in the order of `entries`. Sends the entries in order, at most
`buildInputsRecordMaxEntries` entries and `buildInputsRecordMaxBuildInputs`
build inputs in one request. The server answers `deferred` for the entries
after it reaches its work budget, and the client sends those entries again in
the next request, so no returned result is `deferred`. An entry with more
build inputs than a row can store, or more bytes of them, is never sent and is
`limit-exceeded`. Logs a warning for each entry that is `limit-exceeded` or
whose row's stored build inputs cannot be read. Throws
`DuplicateBuildInputsEntryError`, before it sends anything, when two entries
have the same store-path hash.
*/
export async function recordBuildInputs(
	client: BuildInputsRecordClient,
	cache: CacheScope,
	entries: readonly BuildInputsRecordEntry[],
	options: PagedRequestOptions = {}
): Promise<BuildInputsRecordResult[]> {
	const hashes = new Set<string>();

	for (const entry of entries) {
		const hash = StorePath.hash(entry.storePath);

		if (hashes.has(hash)) {
			throw new DuplicateBuildInputsEntryError(entry.storePath);
		}

		hashes.add(hash);
	}

	const deadline = procedureDeadline(
		'buildInputs.record',
		tenantContract.buildInputs.record.inDefaultCache,
		options
	);
	const answered = new Map<string, BuildInputsRecordResult>();
	const pages = chunkByWeight(
		entries.filter((entry) => canRecordBuildInputs(entry.buildInputs)),
		{
			maxItems: buildInputsRecordMaxEntries,
			maxWeight: buildInputsRecordMaxBuildInputs
		},
		(entry) => entry.buildInputs.length
	);

	for (const page of pages) {
		const settled = await lookupPage(page, {
			deadline,
			request: async (requested, signal) => {
				const response = await callInCache(
					client.record,
					cache,
					{ entries: [...requested] },
					{ signal }
				);

				return settledPrefix(requested, response.entries);
			}
		});

		for (const result of settled) {
			answered.set(result.storePath, result);
		}
	}

	const results = entries.map(
		(entry): BuildInputsRecordResult =>
			answered.get(entry.storePath) ?? {
				storePath: entry.storePath,
				status: 'limit-exceeded'
			}
	);

	for (const result of results) {
		if (
			result.status === 'limit-exceeded' ||
			result.status === 'invalid-stored'
		) {
			rootLogger().warn('the cache did not record build inputs for a path', {
				storePath: result.storePath,
				status: result.status
			});
		}
	}

	return results;
}

// A row can never store more build inputs than this, so the server would refuse
// the entry, or the whole page when the entry alone goes over the page limit.
function canRecordBuildInputs(buildInputs: readonly string[]): boolean {
	return (
		buildInputs.length <= buildInputsMaxLength &&
		canStoreBuildInputs(buildInputs)
	);
}

// The server answers each entry in request order, and every entry after the
// first `deferred` one is `deferred` too.
function settledPrefix(
	requested: readonly BuildInputsRecordEntry[],
	answered: readonly BuildInputsRecordResult[]
): readonly BuildInputsRecordResult[] {
	const mismatch = requested.findIndex(
		(entry, index) => answered[index]?.storePath !== entry.storePath
	);

	if (mismatch !== -1 || answered.length !== requested.length) {
		throw new PathResponseMismatchError(
			'buildInputs.record',
			requested[mismatch === -1 ? requested.length - 1 : mismatch]?.storePath ??
				''
		);
	}

	const deferred = answered.findIndex((result) => result.status === 'deferred');

	if (deferred === -1) {
		return answered;
	}

	const settled = answered
		.slice(deferred)
		.find((result) => result.status !== 'deferred');

	if (settled !== undefined) {
		throw new PathResponseMismatchError(
			'buildInputs.record',
			settled.storePath
		);
	}

	return answered.slice(0, deferred);
}
