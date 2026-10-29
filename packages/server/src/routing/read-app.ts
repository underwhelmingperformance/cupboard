import {
	cacheAvailabilityMaxRequestBytes,
	cacheAvailabilityRequestSchema,
	type CacheAvailabilityResponse
} from '@cupboard/protocol/cache-availability';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import { ByteRangeRequest } from '../http/byte-range.ts';
import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';
import { withSpan } from '../observability/span.ts';
import { upstreamTraceAttributes } from '../observability/trace-context.ts';
import { subrequestsPerInvocation } from '../policy/subrequests.ts';
import {
	guardScopedRead,
	narAuthorityForScope,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import { answerAttestationInfo } from './attestation-info.ts';
import { answerCacheMetadata } from './cache-metadata.ts';
import {
	answerAvailabilityInChunks,
	cacheAvailabilityChunkSizeFor
} from './chunked-availability.ts';
import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import {
	cachedTenantRead,
	tenantUncachedRead,
	withoutStoring
} from './tenant-forward.ts';

const minimumErrorStatus: number = StatusCodes.BAD_REQUEST;
const okStatus: number = StatusCodes.OK;

/**
The Nix binary-cache routes relative to a selected cache. The worker mounts
this sub-app at each cache prefix, and mount middleware sets the read scope.

Hono answers HEAD by re-dispatching the request to the GET handler with the
body stripped, so a separate HEAD registration would never match.
*/
export const readApp = buildReadApp();

function buildReadApp(): Hono<WorkerHonoEnv> {
	const app = new Hono<WorkerHonoEnv>();

	app.get('/nix-cache-info', async (context) => {
		const denied = await guardContentRead(context);

		if (denied !== undefined) {
			return denied;
		}

		return tenantUncachedRead(context, true);
	});

	app.get(String.raw`/:name{[0-9a-z]+\.narinfo}`, async (context) => {
		const storePathHash = parseNarInfoName(context.req.param('name') ?? '');

		if (storePathHash === undefined) {
			return notFoundResponse();
		}

		return withSpan(
			'narinfo-read',
			{
				...upstreamTraceAttributes(context.req.raw.headers),
				'cupboard.probe.requested_paths': 1
			},
			async (span) => {
				try {
					const denied = await guardContentRead(context);
					const response: Response =
						denied ??
						(isCacheableRead(context)
							? await cachedTenantRead(context)
							: await serveNarInfo(
									context.req.raw,
									context.env,
									context.get('tenant'),
									context.get('readScope'),
									storePathHash,
									true
								));
					span.setAttribute('http.response.status_code', response.status);
					span.setAttribute(
						'cupboard.probe.outcome',
						response.status === 404
							? 'missing'
							: response.ok
								? 'found'
								: 'refused'
					);
					return response;
				} catch (error) {
					span.setAttribute('cupboard.probe.outcome', 'error');
					throw error;
				}
			}
		);
	});

	app.get('/nar/:name', async (context) => {
		const nar = parseNarName(context.req.param('name'));

		if (nar === undefined) {
			return notFoundResponse();
		}

		const denied = await guardContentRead(context);

		if (denied !== undefined) {
			return denied;
		}

		const isPublic = isCacheableRead(context);
		const authority = narAuthorityForScope(context.get('readScope'));

		// A Workers Cache hit can answer a ranged request with the whole stored
		// 200. Nix resumes a download with a range after byte 0, and libcurl fails
		// the resume on a whole 200 unless its length equals the resume offset.
		// Serve such a range from R2 here. A range from byte 0 keeps the cached
		// path, where each possible answer is correct.
		if (
			isPublic &&
			ByteRangeRequest.of(context.req.raw)?.startsAfterFirstByte() === true
		) {
			const response = await serveNar(
				context.req.raw,
				context.env,
				context.get('tenant'),
				nar,
				authority,
				false
			);

			return withoutStoringErrors(response);
		}

		if (isPublic) {
			return acceptingRanges(await cachedTenantRead(context));
		}

		return serveNar(
			context.req.raw,
			context.env,
			context.get('tenant'),
			nar,
			authority,
			true
		);
	});

	// Serve signing keys uncached so rotation is visible immediately. One key set
	// signs everything the tenant publishes, so every cache prefix returns it.
	// Signing keys are tenant-wide public metadata.
	app.get('/pubkey', async (context) => {
		const pubkeyUrl = new URL(context.req.url);
		pubkeyUrl.pathname = '/pubkey';

		const response = await tenantServer(
			context.env,
			context.get('tenant')
		).fetch(new Request(pubkeyUrl, context.req.raw));

		return response;
	});

	// Path and cache deletion can change attestation lists and bundle references,
	// so neither response is cached. Malformed names fall through to the tenant
	// Durable Object's normal routing.
	app.get('/attestations/:hash', async (context, next) => {
		if (
			parseNarInfoName(`${context.req.param('hash')}.narinfo`) === undefined
		) {
			return next();
		}

		const denied = await guardContentRead(context);

		return denied ?? tenantUncachedRead(context);
	});

	app.get('/attestation-bundles/:digest', async (context, next) => {
		if (parseAttestationDigestName(context.req.param('digest')) === undefined) {
			return next();
		}

		const denied = await guardContentRead(context);

		if (denied !== undefined) {
			return denied;
		}

		return tenantUncachedRead(context, true);
	});

	app.post('/api/v1/attestation-info', async (context) => {
		const denied = await guardRead(context);
		return denied ?? answerAttestationInfo(context);
	});

	app.post('/api/v1/missing-paths', async (context) => {
		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		const request = await parseRequestBody(
			cacheAvailabilityRequestSchema,
			context.req.raw,
			cacheAvailabilityMaxRequestBytes
		);

		// A deleted cache cannot satisfy an availability request, even while its
		// teardown drain is still removing narinfo objects.
		if (context.get('isCacheDeleted')) {
			const response: CacheAvailabilityResponse = {
				missingStorePathHashes: [...new Set(request.storePathHashes)]
			};

			return context.json(response, StatusCodes.OK, {
				'cache-control': 'no-store'
			});
		}

		return answerAvailabilityInChunks(
			context,
			request.storePathHashes,
			cacheAvailabilityChunkSizeFor(subrequestsPerInvocation(context.env))
		);
	});

	app.post('/api/v1/path-info', async (context) => {
		const denied = await guardRead(context);
		return denied ?? answerCacheMetadata(context);
	});

	return app;
}

function guardRead(
	context: Context<WorkerHonoEnv>
): Promise<Response | undefined> {
	return guardScopedRead(
		context.req.raw,
		context.get('tenantEntry'),
		context.get('readScope'),
		{
			cacheVerifier: context.get('cacheVerifier'),
			isTokenAuthorised: (token, cache) =>
				tenantServer(
					context.env,
					context.get('tenant')
				).authoriseCacheContentRead(token, cache, context.get('isCacheDeleted'))
		}
	);
}

/**
Deletion retains credentials and removes content asynchronously.
Authentication can therefore succeed while objects remain. Return 404
before object-serving code can expose those residual objects.
*/
async function guardContentRead(
	context: Context<WorkerHonoEnv>
): Promise<Response | undefined> {
	const denied = await guardRead(context);

	if (denied !== undefined) {
		return denied;
	}

	return context.get('isCacheDeleted') ? uncachedNotFoundResponse() : undefined;
}

// Only unauthenticated public reads may enter Workers Cache. The cache-owning
// tenant Worker handles those reads, except a NAR request for a range after
// byte 0, which the control Worker serves from R2. The control Worker serves
// all other reads with `no-store`.
function isCacheableRead(context: Context<WorkerHonoEnv>): boolean {
	return context.get('readScope').access === 'public';
}

/**
Applies the tenant Worker's error policy to a public NAR read that the
control Worker serves itself: no error response may enter a cache.
*/
function withoutStoringErrors(response: Response): Response {
	return response.status >= minimumErrorStatus
		? withoutStoring(response)
		: response;
}

/**
Adds `Accept-Ranges: bytes` to a full NAR response from Workers Cache.

Workers Cache can return a response that an earlier release stored without
the header, and it stays fresh for a year. Nix resumes a download only when
the interrupted response had the header.
*/
function acceptingRanges(response: Response): Response {
	if (response.status !== okStatus || response.headers.has('accept-ranges')) {
		return response;
	}

	const headers = new Headers(response.headers);
	headers.set('accept-ranges', 'bytes');

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers
	});
}
