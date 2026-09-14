import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import {
	rootListPageSize,
	rootSetMaxTargets
} from '@cupboard/protocol/retention';
import { describe, expect, it } from 'vitest';

import { checkBatchSize } from '../http/http.ts';
import { cacheProbeD1CallsPerChunk } from '../read/read.ts';
import {
	cacheAvailabilityChunkSize,
	reuseViewAvailabilityChunkSize
} from '../routing/chunked-availability.ts';

import {
	reuseDistinctNarLimit,
	reuseViewProbeD1CallsPerChunk
} from './reuse-view-lookup-service.ts';
import { subrequestSliceReserve } from './subrequest-slice.ts';

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
	R2 requests one item costs. D1 queries the same item makes are not counted.
	*/
	readonly requestsPerItem: number;
	/**
	Where that count comes from.
	*/
	readonly fanOut: string;
}

const cappedRequests: readonly CappedRequest[] = [
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

// An availability page is not one request to the object: the Worker sends it
// in chunks, each an invocation of its own. A chunk's worst case, after the D1
// calls the probe makes first, must fit the slice the object opens for it less
// the reserve the slice keeps; otherwise the object refuses the chunk. The
// chunk sizes are derived from these figures, so this checks the derivation,
// not a literal.
interface ChunkedRequest {
	readonly chunk: string;
	readonly items: number;
	readonly requestsPerItem: number;
	/**
	D1 calls the probe makes before its R2 heads.
	*/
	readonly d1Calls: number;
	readonly fanOut: string;
}

const chunkedRequests: readonly ChunkedRequest[] = [
	{
		chunk: 'cacheAvailabilityChunkSize',
		items: cacheAvailabilityChunkSize,
		requestsPerItem: 1,
		d1Calls: cacheProbeD1CallsPerChunk,
		fanOut:
			'One narinfo head for each distinct hash, in `missingStorePathHashes` in `read/read.ts`.'
	},
	{
		chunk: 'reuseViewAvailabilityChunkSize',
		items: reuseViewAvailabilityChunkSize,
		requestsPerItem: reuseDistinctNarLimit,
		d1Calls: reuseViewProbeD1CallsPerChunk,
		fanOut:
			"One NAR head for each distinct NAR among a hash's verified copies; the lookup refuses a hash with more than the limit before the probe."
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

	it('leaves the slice its reserve after the worst case of every chunk', () => {
		const overBudget = chunkedRequests.filter(
			(request) =>
				request.items < 1 ||
				request.items * request.requestsPerItem +
					request.d1Calls +
					subrequestSliceReserve >
					subrequestsPerInvocation
		);

		expect(
			overBudget.map(
				(request) =>
					`${request.chunk}: ${String(request.items)} hashes at ${String(request.requestsPerItem)} heads`
			)
		).toStrictEqual([]);
	});
});
