import { controlContract, tenantContract } from '@cupboard/protocol/contract';
import { tenantListPageSize } from '@cupboard/protocol/tenants';
import { type RandomSource } from '@cupboard/shared/backoff';
import {
	type ProgressiveCollectionLimits,
	type ProgressivePage
} from '@cupboard/shared/collections';
import { cursorPages } from '@cupboard/shared/paging';

import { type CallOptions, procedureDeadline } from './orpc.ts';

// A listing that exceeds either cap fails, which stops a cursor that never
// ends. The CLI keeps every item in memory, so the item cap is ten million: a
// listing of that size would already take gigabytes.
const maximumListingItems = 10_000_000;
const maximumListingPages = 1_000_000;

/**
The item and page limits for collecting an admin API listing. The error for
a listing that exceeds a limit starts with `description`.
*/
export function listingLimits(
	description: string
): ProgressiveCollectionLimits {
	return {
		description,
		maximumItems: maximumListingItems,
		maximumPages: maximumListingPages
	};
}

/**
The `caches.list` procedure, with the result narrowed to the fields that the
caller reads.
*/
export interface CacheLister<Entry> {
	list(
		input?: { readonly namePrefix?: string; readonly cursor?: string },
		options?: CallOptions
	): Promise<{ readonly caches: readonly Entry[]; readonly cursor?: string }>;
}

/**
Requests the first page of the tenant's caches, or of the caches whose names
start with `namePrefix`. Each page request has the probe deadline and is
sent again when the deadline expires or the response body fails. `random`
is the random source for the backoff before a request is sent again, and
defaults to `Math.random`.
*/
export function cachePages<Entry>(
	client: CacheLister<Entry>,
	namePrefix?: string,
	random?: RandomSource
): Promise<ProgressivePage<Entry>> {
	return cursorPages<Entry, string>(
		async (cursor, signal) => {
			const page = await client.list(
				{
					...(namePrefix !== undefined && { namePrefix }),
					...(cursor !== undefined && { cursor })
				},
				{ signal }
			);

			return { items: page.caches, next: page.cursor };
		},
		procedureDeadline('caches.list', tenantContract.caches.list, { random })
	);
}

/**
The `tenants.list` procedure, with the result narrowed to the fields that the
caller reads.
*/
export interface TenantLister<Entry> {
	list(
		input?: { readonly cursor?: string; readonly limit?: number },
		options?: CallOptions
	): Promise<{ readonly tenants: readonly Entry[]; readonly cursor?: string }>;
}

/**
Requests the first page of the deployment's tenants. Every request has a
`limit`, which asks the server to page the listing. Each page request has
the probe deadline and is sent again when the deadline expires or the
response body fails. `random` is the random source for the backoff before a
request is sent again, and defaults to `Math.random`.
*/
export function tenantPages<Entry>(
	client: TenantLister<Entry>,
	random?: RandomSource
): Promise<ProgressivePage<Entry>> {
	return cursorPages<Entry, string>(
		async (cursor, signal) => {
			const page = await client.list(
				{ limit: tenantListPageSize, ...(cursor !== undefined && { cursor }) },
				{ signal }
			);

			return { items: page.tenants, next: page.cursor };
		},
		procedureDeadline('tenants.list', controlContract.tenants.list, { random })
	);
}
