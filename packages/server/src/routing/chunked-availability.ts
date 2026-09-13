import { type StorePathHash } from '@cupboard/nix-store/scalars';
import {
	type CacheAvailabilityResponse,
	cacheAvailabilityResponseSchema
} from '@cupboard/protocol/cache-availability';
import { subrequestsPerInvocation } from '@cupboard/protocol/platform';
import { discardResponseBody } from '@cupboard/shared/cleanup';
import { chunk } from '@cupboard/shared/collections';
import { mapWithConcurrency } from '@cupboard/shared/concurrency';
import { type Context } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { maxOutgoingConnections } from '../do/bulk.ts';
import {
	reuseDistinctNarLimit,
	reuseViewProbeD1CallsPerChunk
} from '../do/reuse-view-lookup-service.ts';
import { subrequestSliceReserve } from '../do/subrequest-slice.ts';
import { cacheProbeD1CallsPerChunk } from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';

// The hashes one object request may carry: the subrequests an invocation has,
// less the reserve its slice keeps and the D1 calls the probe makes before its
// heads, divided by the heads one hash costs at worst. Derived, not chosen:
// `subrequest-budget.test.ts` checks each chunk's worst case against the
// ceiling.
function chunkSizeFor(headsPerHash: number, d1CallsPerChunk: number): number {
	return Math.floor(
		(subrequestsPerInvocation - subrequestSliceReserve - d1CallsPerChunk) /
			headsPerHash
	);
}

/**
 * One narinfo head per hash.
 */
export const cacheAvailabilityChunkSize = chunkSizeFor(
	1,
	cacheProbeD1CallsPerChunk
);

/**
 * One NAR head per distinct NAR among a hash's copies, at most
 * `reuseDistinctNarLimit`.
 */
export const reuseViewAvailabilityChunkSize = chunkSizeFor(
	reuseDistinctNarLimit,
	reuseViewProbeD1CallsPerChunk
);

/**
 * Answers an availability page through the tenant Durable Object a chunk at a
 * time.
 *
 * The subrequest ceiling is per invocation, and each request the Worker sends
 * to the object is an invocation with its own allowance. A page whose R2 heads
 * would exceed one allowance is therefore split into chunks the object answers
 * within one, sent with bounded concurrency, and merged in request order. A
 * chunk the object refuses is returned as it is, so its status and retry
 * advice reach the client.
 *
 * Each chunk carries the request's credential: the object authenticates a
 * read of a private reuse view itself.
 */
export async function answerAvailabilityInChunks(
	context: Context<WorkerHonoEnv>,
	storePathHashes: readonly StorePathHash[],
	chunkSize: number
): Promise<Response> {
	const target = new URL(context.req.url);
	target.pathname = context.get('tenantRest');
	const object = tenantServer(context.env, context.get('tenant'));
	const authorization = context.req.header('authorization');
	const headers = {
		'content-type': 'application/json',
		...(authorization !== undefined && { authorization })
	};

	return mergeAvailabilityChunks(
		(hashes) =>
			object.fetch(target, {
				body: JSON.stringify({ storePathHashes: hashes }),
				headers,
				method: 'POST'
			}),
		storePathHashes,
		chunkSize
	);
}

/**
 * Sends each chunk of `storePathHashes` through `sendChunk` and merges the
 * answers. `sendChunk` receives at most `chunkSize` hashes per call.
 */
export async function mergeAvailabilityChunks(
	sendChunk: (storePathHashes: readonly StorePathHash[]) => Promise<Response>,
	storePathHashes: readonly StorePathHash[],
	chunkSize: number
): Promise<Response> {
	const unique = [...new Set(storePathHashes)];
	const responses = await mapWithConcurrency(
		chunk(unique, chunkSize),
		maxOutgoingConnections,
		sendChunk
	);
	const refused = responses.find((response) => !response.ok);

	if (refused !== undefined) {
		await Promise.all(
			responses
				.filter((response) => response !== refused)
				.map((response) => discardResponseBody(response))
		);

		return refused;
	}

	const missing: StorePathHash[] = [];

	for (const response of responses) {
		const answer = cacheAvailabilityResponseSchema.parse(await response.json());
		missing.push(...answer.missingStorePathHashes);
	}

	const merged: CacheAvailabilityResponse = { missingStorePathHashes: missing };

	return Response.json(merged, {
		status: StatusCodes.OK,
		headers: { 'cache-control': 'no-store' }
	});
}
