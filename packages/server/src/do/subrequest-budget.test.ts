import {
	cacheAvailabilityMaxPaths,
	reuseViewAvailabilityMaxPaths
} from '@cupboard/protocol/cache-availability';
import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import {
	rootListPageSize,
	rootSetMaxTargets
} from '@cupboard/protocol/retention';
import { describe, expect, it } from 'vitest';

import { checkBatchSize } from '../http/http.ts';

import { reuseCandidateLimit } from './reuse-view-lookup-service.ts';

// Each cap below bounds how many items one request accepts, so the binding
// calls the server makes for those items stay under the subrequest ceiling.
// `scripts/subrequest-budget.test.ts` checks that both Worker configurations
// use their plan's internal-service call allowance.
//
// The per-item costs are read from the code, so each is a claim a reader must
// re-check rather than something the compiler knows.
interface CappedRequest {
	readonly cap: string;
	readonly items: number;
	/**
	Binding calls one item costs. Fixed request overhead is not counted.
	*/
	readonly requestsPerItem: number;
	/**
	Where that count comes from.
	*/
	readonly fanOut: string;
}

const cappedRequests: readonly CappedRequest[] = [
	{
		cap: 'cacheAvailabilityMaxPaths',
		items: cacheAvailabilityMaxPaths,
		requestsPerItem: 1,
		fanOut:
			'One narinfo head for each distinct hash, in `missingStorePathHashes` in `read/read.ts`.'
	},
	{
		cap: 'reuseViewAvailabilityMaxPaths',
		items: reuseViewAvailabilityMaxPaths,
		requestsPerItem: reuseCandidateLimit,
		fanOut:
			'One NAR head for each candidate of a hash. `snapshotCandidateBatch` drops a hash with more candidates than the limit before the probe.'
	},
	{
		cap: 'rootSetMaxTargets',
		items: rootSetMaxTargets,
		requestsPerItem: 6,
		fanOut:
			'`servableNarInfoVersions` heads the narinfo and NAR, repairs a missing narinfo object, and reads the associated D1 rows.'
	},
	{
		cap: 'rootListPageSize',
		items: rootListPageSize,
		requestsPerItem: 6,
		fanOut: 'The same probe as `rootSetMaxTargets`, over one page.'
	},
	{
		cap: 'checkBatchSize',
		items: checkBatchSize,
		requestsPerItem: 3,
		fanOut:
			'One narinfo head for each row, one NAR head for each distinct hash, and in deep mode one NAR read as well.'
	}
];

describe('the subrequest ceiling', () => {
	it('covers the fan-out of every capped request', () => {
		const overBudget = cappedRequests.filter(
			(request) =>
				request.items * request.requestsPerItem > subrequestsPerInvocation
		);

		expect(
			overBudget.map(
				(request) =>
					`${request.cap}: ${String(request.items * request.requestsPerItem)} calls`
			)
		).toStrictEqual([]);
	});
});
