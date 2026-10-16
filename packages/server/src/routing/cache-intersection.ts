import {
	cacheIntersectionMaxResponseBytes,
	type CacheIntersectionRequest,
	cacheIntersectionResponseSchema
} from '@cupboard/protocol/cache-metadata';
import { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import { type Context } from 'hono';

import { sha256Hex } from '../crypto/crypto.ts';
import * as d1Schema from '../db/d1-schema.ts';
import {
	MetadataCandidateBudgetExceededError,
	MetadataScopeChangedError
} from '../errors.ts';
import { withSpan } from '../observability/span.ts';
import { upstreamTraceAttributes } from '../observability/trace-context.ts';
import { intersectCachePaths } from '../read/path-intersection.ts';

import { type WorkerHonoEnv } from './hono-env.ts';
import {
	cacheReadScopeVersion,
	revalidateCacheReadAuthority,
	revalidateCacheReadScope
} from './read-scope.ts';

export async function answerCacheIntersection(
	context: Context<WorkerHonoEnv>,
	request: CacheIntersectionRequest
): Promise<Response> {
	return withSpan(
		'cache-path-intersection',
		{
			'url.path': context.req.path,
			'cupboard.probe.access': context.get('readScope').access,
			'cupboard.probe.requested_hashes': request.storePathHashes.length,
			...upstreamTraceAttributes(context.req.raw.headers)
		},
		async (span) => {
			try {
				const version = cacheReadScopeVersion(context);
				if (
					request.expectedScopeVersion !== undefined &&
					request.expectedScopeVersion !== version
				) {
					throw new MetadataScopeChangedError();
				}
				context.req.raw.signal.throwIfAborted();
				const inputFingerprint = await sha256Hex(
					JSON.stringify(request.storePathHashes)
				);
				span.setAttribute('cupboard.probe.input_sha256', inputFingerprint);
				const intersection = await intersectCachePaths(
					drizzleD1(context.env.CUPBOARD_DB, { schema: d1Schema }),
					context.get('tenant'),
					context.get('readScope'),
					request.storePathHashes,
					context.req.raw.signal
				);
				span.setAttribute(
					'cupboard.probe.lookup_strategy',
					intersection.strategy
				);
				span.setAttribute(
					'cupboard.probe.raw_reference_rows',
					intersection.scannedRows
				);
				span.setAttribute(
					'cupboard.probe.authority_candidates',
					intersection.candidateHashes
				);
				span.setAttribute(
					'cupboard.probe.matching_hashes',
					intersection.matchingHashes.length
				);
				const response = cacheIntersectionResponseSchema.parse({
					complete: true,
					scopeVersion: version,
					checked: request.storePathHashes.length,
					inputFingerprint,
					matchingHashes: intersection.matchingHashes
				});
				const body = JSON.stringify(response);
				const bytes = new TextEncoder().encode(body).byteLength;
				if (bytes > cacheIntersectionMaxResponseBytes) {
					throw new MetadataCandidateBudgetExceededError(
						intersection.matchingHashes.length,
						bytes
					);
				}
				await revalidateCacheReadScope(context, version);
				await revalidateCacheReadAuthority(context);
				context.req.raw.signal.throwIfAborted();
				span.setAttribute('cupboard.probe.outcome', 'complete');
				span.setAttribute('http.response.status_code', 200);
				return new Response(body, {
					headers: {
						'cache-control': 'no-store',
						'content-type': 'application/json'
					}
				});
			} catch (error) {
				span.setAttribute('cupboard.probe.outcome', 'error');
				throw error;
			}
		}
	);
}
