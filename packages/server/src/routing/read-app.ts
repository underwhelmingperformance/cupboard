import {
	cacheAvailabilityRequestSchema,
	type CacheAvailabilityResponse
} from '@cupboard/protocol/cache-availability';
import { type Context, Hono } from 'hono';
import { StatusCodes } from 'http-status-codes';

import {
	notFoundResponse,
	parseAttestationDigestName,
	parseNarInfoName,
	parseNarName,
	uncachedNotFoundResponse
} from '../http/http.ts';
import { parseRequestBody } from '../http/parse.ts';
import {
	guardScopedRead,
	missingStorePathHashes,
	narAuthorityForScope,
	serveNar,
	serveNarInfo
} from '../read/read.ts';

import { tenantServer } from './durable-object.ts';
import { type WorkerHonoEnv } from './hono-env.ts';
import { cachedTenantRead, tenantUncachedRead } from './tenant-forward.ts';

/**
 * The Nix binary-cache routes relative to a selected cache. The worker mounts
 * this sub-app at each cache prefix, and mount middleware sets the read scope.
 *
 * Hono answers HEAD by re-dispatching the request to the GET handler with the
 * body stripped, so a separate HEAD registration would never match.
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

		const denied = await guardContentRead(context);

		if (denied !== undefined) {
			return denied;
		}

		return isCacheableRead(context)
			? cachedTenantRead(context)
			: serveNarInfo(
					context.req.raw,
					context.env,
					context.get('tenant'),
					context.get('readScope'),
					storePathHash,
					true
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

		return isCacheableRead(context)
			? cachedTenantRead(context)
			: serveNar(
					context.req.raw,
					context.env,
					context.get('tenant'),
					nar,
					narAuthorityForScope(context.get('readScope')),
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

	app.post('/api/v1/missing-paths', async (context) => {
		const denied = await guardRead(context);

		if (denied !== undefined) {
			return denied;
		}

		const request = await parseRequestBody(
			cacheAvailabilityRequestSchema,
			context.req.raw
		);
		// A deleted cache cannot satisfy an availability request, even while its
		// teardown drain is still removing narinfo objects.
		const response: CacheAvailabilityResponse = {
			missingStorePathHashes: context.get('isCacheDeleted')
				? [...new Set(request.storePathHashes)]
				: await missingStorePathHashes(
						context.env,
						context.get('tenant'),
						context.get('readScope'),
						request.storePathHashes
					)
		};

		return context.json(response, StatusCodes.OK, {
			'cache-control': 'no-store'
		});
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
		context.get('cacheVerifier')
	);
}

/**
 * Authenticates a read of cache content and refuses it while the addressed
 * cache is deleted.
 *
 * Cache deletion retains the read credential and removes narinfo and
 * attestation objects asynchronously. Authentication can therefore succeed
 * while those objects remain. Return 404 after authentication so the objects
 * are inaccessible without revealing the cache state to an unauthenticated
 * reader.
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
// tenant Worker handles those reads; the control Worker serves all others with
// `no-store`.
function isCacheableRead(context: Context<WorkerHonoEnv>): boolean {
	return context.get('readScope').access === 'public';
}
