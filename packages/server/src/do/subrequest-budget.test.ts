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

// A hash's candidates are the caches of the view that hold it. Their NARs are
// probed once for each distinct hash, so copies that agree cost one head. This
// is the number of disagreeing copies one hash is assumed to have at worst; a
// view whose copies disagree is served as a miss either way.
const reuseViewCandidateHeads = 17;

import { checkBatchSize } from '../http/http.ts';

// Each cap below bounds how many items one request accepts, so that the R2
// requests the server makes for those items stay under the subrequest ceiling.
// `scripts/subrequest-budget.test.ts` holds that ceiling equal to the figure
// both Worker configurations pin.
//
// The per-item costs are read from the code, so each is a claim a reader must
// re-check rather than something the compiler knows.
interface CappedRequest {
	readonly cap: string;
	readonly items: number;
	/**
	R2 requests one item costs.
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
		fanOut: 'One narinfo head for each distinct hash, in `narInfoAvailability`.'
	},
	{
		cap: 'reuseViewAvailabilityMaxPaths',
		items: reuseViewAvailabilityMaxPaths,
		requestsPerItem: reuseViewCandidateHeads,
		fanOut:
			"One NAR head for each distinct NAR among a hash's candidates. Copies that agree share one NAR, so this is the count for a hash whose copies disagree."
	},
	{
		cap: 'rootSetMaxTargets',
		items: rootSetMaxTargets,
		requestsPerItem: 4,
		fanOut:
			'`servableNarInfoVersions` heads the narinfo object and the NAR, repairs a missing narinfo object, and heads the repaired objects again.'
	},
	{
		cap: 'rootListPageSize',
		items: rootListPageSize,
		requestsPerItem: 4,
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
					`${request.cap}: ${String(request.items * request.requestsPerItem)} requests`
			)
		).toStrictEqual([]);
	});
});
