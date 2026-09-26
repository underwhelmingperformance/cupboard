import {
	subrequestSafetyReserve,
	workersInvocationAllowances
} from '@cupboard/protocol/platform';
import {
	rootListPageSize,
	rootSetMaxTargets
} from '@cupboard/protocol/retention';
import { describe, expect, it } from 'vitest';

import { cacheProbeD1CallsPerChunk } from '../read/read.ts';
import {
	cacheAvailabilityChunkSize,
	cacheAvailabilityChunkSizeFor,
	reuseViewAvailabilityChunkSize,
	reuseViewAvailabilityChunkSizeFor
} from '../routing/chunked-availability.ts';

import {
	inheritanceListSubrequests,
	inheritanceLookupSubrequests,
	inheritedBundleSubrequests,
	maxInheritedBundlesPerPath
} from './attestations-service.ts';
import {
	reuseDistinctNarLimit,
	reuseViewProbeD1CallsPerChunk
} from './reuse-view-lookup-service.ts';
import { subrequestSliceReserve } from './subrequest-slice.ts';

// Each cap below bounds how many items one request accepts, so that its D1 and
// R2 calls stay under the Free plan's usable subrequest allowance.
//
// The per-item costs are read from the code, so each is a claim a reader must
// re-check rather than something the compiler knows.
interface CappedRequest {
	readonly cap: string;
	readonly items: number;
	/**
	D1 and R2 calls for one item.
	*/
	readonly requestsPerItem: number;
	readonly fixedCalls: number;
	/**
	Where that count comes from.
	*/
	readonly fanOut: string;
}

const cappedRequests: readonly CappedRequest[] = [
	{
		cap: 'rootSetMaxTargets',
		items: rootSetMaxTargets,
		requestsPerItem: 6,
		fixedCalls: 4,
		fanOut:
			'`servableNarInfoVersions` heads the narinfo object and the NAR, repairs a missing narinfo object, and heads the repaired objects again.'
	},
	{
		cap: 'rootListPageSize',
		items: rootListPageSize,
		requestsPerItem: 4,
		fixedCalls: 1,
		fanOut: 'The same probe as `rootSetMaxTargets`, over one page.'
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
		chunk: 'maxInheritedBundlesPerPath',
		items: maxInheritedBundlesPerPath,
		requestsPerItem: inheritedBundleSubrequests,
		d1Calls: inheritanceLookupSubrequests + inheritanceListSubrequests,
		fanOut:
			'Each inherited bundle heads its CAS object and makes three D1 calls. The source lookup and the list write add three calls for the path.'
	},
	{
		chunk: 'cacheAvailabilityChunkSize',
		items: cacheAvailabilityChunkSize,
		requestsPerItem: 2,
		d1Calls: cacheProbeD1CallsPerChunk,
		fanOut:
			'One narinfo head and one NAR head for each distinct hash, in `missingStorePathHashes` in `read/read.ts`.'
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
				request.items * request.requestsPerItem + request.fixedCalls >
				workersInvocationAllowances.free.subrequests - subrequestSafetyReserve
		);

		expect(
			overBudget.map(
				(request) =>
					`${request.cap}: ${String(request.items * request.requestsPerItem)} requests`
			)
		).toStrictEqual([]);
	});

	it('sets the root boundary from the complete repair cost', () => {
		expect({
			cap: rootSetMaxTargets,
			calls: rootSetMaxTargets * 6 + 4,
			nextCalls: (rootSetMaxTargets + 1) * 6 + 4,
			usable:
				workersInvocationAllowances.free.subrequests - subrequestSafetyReserve
		}).toStrictEqual({ cap: 149, calls: 898, nextCalls: 904, usable: 900 });
	});

	it('leaves the slice its reserve after the worst case of every chunk', () => {
		const overBudget = chunkedRequests.filter(
			(request) =>
				request.items < 1 ||
				request.items * request.requestsPerItem +
					request.d1Calls +
					subrequestSliceReserve >
					workersInvocationAllowances.free.subrequests
		);

		expect(
			overBudget.map(
				(request) =>
					`${request.chunk}: ${String(request.items)} hashes at ${String(request.requestsPerItem)} heads`
			)
		).toStrictEqual([]);
	});

	it('derives different chunks for Free and Paid invocations', () => {
		expect({
			free: {
				cache: cacheAvailabilityChunkSizeFor(
					workersInvocationAllowances.free.subrequests
				),
				reuse: reuseViewAvailabilityChunkSizeFor(
					workersInvocationAllowances.free.subrequests
				)
			},
			paid: {
				cache: cacheAvailabilityChunkSizeFor(
					workersInvocationAllowances.paid.subrequests
				),
				reuse: reuseViewAvailabilityChunkSizeFor(
					workersInvocationAllowances.paid.subrequests
				)
			}
		}).toStrictEqual({
			free: { cache: 449, reuse: 56 },
			paid: { cache: 4949, reuse: 618 }
		});
	});
});
